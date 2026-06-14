import * as https from 'https';
import type { WebSearchConfig, GitHubIntegrationConfig } from '../types';
import { WebSearchService } from './webSearchService';
import { WebFetcherService } from './webFetcherService';

/**
 * A single cited finding. Every fact an agent gets from the network carries its
 * source URL and the time it was retrieved so downstream reasoning can weigh
 * freshness and the brief can record an auditable citation trail.
 */
export interface ResearchFinding {
  source: string;
  title: string;
  retrievedAt: string;
  /** Repository push/update time when known — lets agents judge code freshness. */
  updatedAt?: string;
  snippet: string;
}

export interface ResearchOutcome {
  query: string;
  generatedAt: string;
  findings: ResearchFinding[];
  warnings: string[];
}

export interface ResearchServiceConfig {
  webSearch?: Partial<WebSearchConfig>;
  github?: Partial<GitHubIntegrationConfig>;
  /**
   * Lets agents read code from public GitHub/GitLab repositories. Network,
   * opt-in. Independent from local-repo GitHub context.
   */
  allowExternalRepoReads?: boolean;
  maxResults?: number;
}

/**
 * Governed research capability the agents can call on demand: web search (with
 * citations + freshness) and public GitHub/GitLab code discovery/reading so the
 * debate can ground its proposals in real, current sources and learn from
 * existing high-quality code instead of inventing from scratch.
 *
 * Everything here is OPT-IN and network-gated by config; with research disabled
 * each method returns an empty, clearly-warned outcome rather than reaching out.
 */
export class ResearchService {
  private readonly fetcher = new WebFetcherService();
  private readonly webSearch: WebSearchService;

  constructor(private readonly config: ResearchServiceConfig = {}) {
    this.webSearch = new WebSearchService(config.webSearch);
  }

  get webEnabled(): boolean {
    return this.config.webSearch?.enabled === true;
  }

  get repoReadsEnabled(): boolean {
    return this.config.allowExternalRepoReads === true;
  }

  private get maxResults(): number {
    return Math.max(1, Math.min(10, this.config.maxResults ?? this.config.webSearch?.maxResults ?? 5));
  }

  /** Web search + page fetch, returned as cited, freshness-stamped findings. */
  async webResearch(query: string): Promise<ResearchOutcome> {
    const generatedAt = new Date().toISOString();
    if (!this.webEnabled) {
      return { query, generatedAt, findings: [], warnings: ['Web research is disabled in config (webSearch.enabled=false).'] };
    }
    const report = await this.webSearch.searchAndFetch(query);
    const findings: ResearchFinding[] = [];
    for (const page of report.fetched) {
      if (!page.success || !page.text) { continue; }
      const hit = report.hits.find(h => h.url === page.url);
      findings.push({
        source: page.url,
        title: hit?.title ?? page.url,
        retrievedAt: generatedAt,
        snippet: this._clip(page.text, 1500),
      });
    }
    return { query, generatedAt, findings, warnings: report.warnings };
  }

  /**
   * Discover relevant public GitHub repositories (unauthenticated repo search,
   * ranked by stars) and pull each one's README so the agents have concrete,
   * citable code references. `pushed_at` is carried through as the freshness
   * signal so stale projects can be discounted.
   */
  async findCodeExamples(query: string): Promise<ResearchOutcome> {
    const generatedAt = new Date().toISOString();
    if (!this.repoReadsEnabled) {
      return { query, generatedAt, findings: [], warnings: ['External repo research is disabled in config (githubIntegration / allowExternalRepoReads).'] };
    }
    const warnings: string[] = [];
    let repos: GitHubRepoHit[] = [];
    try {
      repos = await this._searchGitHubRepos(query, this.maxResults);
    } catch (err) {
      warnings.push(`GitHub repo search failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const findings: ResearchFinding[] = [];
    for (const repo of repos) {
      const readme = await this._readRepoReadme(repo.fullName, repo.defaultBranch);
      findings.push({
        source: repo.htmlUrl,
        title: `${repo.fullName} ⭐${repo.stars}${repo.language ? ` · ${repo.language}` : ''}`,
        retrievedAt: generatedAt,
        updatedAt: repo.pushedAt,
        snippet: [repo.description, readme ? `README:\n${this._clip(readme, 1200)}` : '']
          .filter(Boolean)
          .join('\n\n') || '(no description or README available)',
      });
    }
    return { query, generatedAt, findings, warnings };
  }

  /**
   * Read a specific source file from a public GitHub or GitLab repository.
   * Accepts normal blob/tree URLs and rewrites them to raw endpoints. Returns a
   * single cited finding so the read is logged like any other source.
   */
  async readRepoFile(url: string): Promise<ResearchFinding | { error: string }> {
    if (!this.repoReadsEnabled) {
      return { error: 'External repo reads are disabled in config (allowExternalRepoReads=false).' };
    }
    const rawUrl = this._toRawUrl(url);
    const result = await this.fetcher.fetchUrl(rawUrl);
    if (!result.success) {
      return { error: `Failed to read ${rawUrl}: ${result.error ?? 'empty response'}` };
    }
    return {
      source: rawUrl,
      title: rawUrl,
      retrievedAt: new Date().toISOString(),
      snippet: this._clip(result.text, 4000),
    };
  }

  /** Render an outcome as a cited, freshness-annotated markdown block for prompts/journal. */
  static format(outcome: ResearchOutcome): string {
    const lines: string[] = [`### Research: ${outcome.query}`, `_Retrieved ${outcome.generatedAt}_`, ''];
    if (outcome.findings.length === 0) {
      lines.push('No findings.', ...(outcome.warnings.length ? outcome.warnings.map(w => `- ⚠️ ${w}`) : []));
      return lines.join('\n');
    }
    outcome.findings.forEach((f, i) => {
      lines.push(
        `${i + 1}. **${f.title}**`,
        `   - Source: ${f.source}`,
        `   - Retrieved: ${f.retrievedAt}${f.updatedAt ? ` · Last updated: ${f.updatedAt}` : ''}`,
        `   - ${f.snippet.replace(/\n/g, '\n     ')}`,
        ''
      );
    });
    if (outcome.warnings.length) {
      lines.push('Warnings:', ...outcome.warnings.map(w => `- ⚠️ ${w}`));
    }
    return lines.join('\n');
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private _clip(text: string, max: number): string {
    const cleaned = text.replace(/\s+\n/g, '\n').trim();
    return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
  }

  /** Normalize a github.com/gitlab.com blob URL to its raw-content equivalent. */
  private _toRawUrl(url: string): string {
    try {
      const u = new URL(url);
      if (u.hostname === 'github.com') {
        // https://github.com/{owner}/{repo}/blob/{ref}/{path} -> raw.githubusercontent.com
        const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/);
        if (m) { return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`; }
      }
      if (u.hostname === 'gitlab.com') {
        // https://gitlab.com/{group}/{repo}/-/blob/{ref}/{path} -> /-/raw/
        return url.replace('/-/blob/', '/-/raw/');
      }
      return url;
    } catch {
      return url;
    }
  }

  private async _readRepoReadme(fullName: string, branch: string): Promise<string> {
    for (const name of ['README.md', 'readme.md', 'README.MD']) {
      const result = await this.fetcher.fetchUrl(`https://raw.githubusercontent.com/${fullName}/${branch}/${name}`);
      if (result.success && result.text.trim()) { return result.text; }
    }
    return '';
  }

  private _searchGitHubRepos(query: string, max: number): Promise<GitHubRepoHit[]> {
    const url = new URL('https://api.github.com/search/repositories');
    url.searchParams.set('q', query);
    url.searchParams.set('sort', 'stars');
    url.searchParams.set('order', 'desc');
    url.searchParams.set('per_page', String(max));
    return new Promise((resolve, reject) => {
      https.get(url, {
        headers: {
          'User-Agent': 'LocalMultiAgentCoder/1.0',
          'Accept': 'application/vnd.github+json',
        },
      }, res => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          res.resume();
          reject(new Error(`GitHub API HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              items?: Array<{
                full_name?: string; html_url?: string; description?: string;
                stargazers_count?: number; language?: string; pushed_at?: string; default_branch?: string;
              }>;
            };
            const hits: GitHubRepoHit[] = (parsed.items ?? []).slice(0, max).map(it => ({
              fullName: it.full_name ?? '',
              htmlUrl: it.html_url ?? '',
              description: it.description ?? '',
              stars: it.stargazers_count ?? 0,
              language: it.language ?? '',
              pushedAt: it.pushed_at ?? '',
              defaultBranch: it.default_branch ?? 'main',
            })).filter(h => h.fullName);
            resolve(hits);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      }).on('error', reject);
    });
  }
}

interface GitHubRepoHit {
  fullName: string;
  htmlUrl: string;
  description: string;
  stars: number;
  language: string;
  pushedAt: string;
  defaultBranch: string;
}
