import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { RepositorySearchReport, SearchResult } from '../types';

const DEFAULT_EXTENSIONS = [
  'cjs', 'css', 'html', 'js', 'json', 'jsx', 'md', 'mjs', 'ts', 'tsx', 'txt', 'yml', 'yaml',
];

const SKIPPED_DIRS = new Set([
  '.agent-workspace',
  '.git',
  '.next',
  '.nuxt',
  '.turbo',
  '.vscode-test',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);

export class SearchService {
  constructor(private readonly workspaceRoot: string) {}

  async search(query: string, options?: { maxResults?: number; extensions?: string[] }): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) { return []; }

    const rgResults = await this._searchWithRipgrep(trimmed, options);
    if (rgResults !== null) {
      return rgResults;
    }
    return this._searchWithNode(trimmed, options);
  }

  async buildReport(queries: string[], options?: { maxResultsPerQuery?: number; extensions?: string[] }): Promise<RepositorySearchReport> {
    const warnings: string[] = [];
    const results: SearchResult[] = [];
    const filesInspected = new Set<string>();
    const uniqueQueries = [...new Set(queries.map(q => q.trim()).filter(Boolean))].slice(0, 8);

    for (const query of uniqueQueries) {
      try {
        const found = await this.search(query, {
          maxResults: options?.maxResultsPerQuery ?? 12,
          extensions: options?.extensions,
        });
        for (const result of found) {
          results.push(result);
          filesInspected.add(result.file);
        }
      } catch (err) {
        warnings.push(`Search failed for "${query}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      queries: uniqueQueries,
      results: results.slice(0, 80),
      filesInspected: [...filesInspected].sort(),
      warnings,
    };
  }

  deriveQueriesFromPrompt(prompt: string): string[] {
    const cleaned = prompt
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[^\p{L}\p{N}_./-]+/gu, ' ')
      .trim();
    const words = cleaned.split(/\s+/).filter(word => word.length >= 4);
    const fileLike = words.filter(word => /\.[A-Za-z0-9]{1,12}$/.test(word)).slice(0, 5);
    const technical = words.filter(word =>
      /api|auth|database|test|compile|lint|component|route|service|fix|bug|error|agent|tool|patch|search/i.test(word)
    ).slice(0, 8);
    return [...fileLike, ...technical, ...words.slice(0, 4)].slice(0, 10);
  }

  private _searchWithRipgrep(query: string, options?: { maxResults?: number; extensions?: string[] }): Promise<SearchResult[] | null> {
    return new Promise(resolve => {
      const args = [
        '--line-number',
        '--no-heading',
        '--color',
        'never',
        '--glob',
        '!{node_modules,.git,.agent-workspace,out,dist,coverage}/**',
        query,
        '.',
      ];
      cp.execFile('rg', args, {
        cwd: this.workspaceRoot,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      }, (error, stdout) => {
        if (error && !stdout) {
          resolve(null);
          return;
        }
        resolve(this._parseRipgrep(stdout.toString(), options?.maxResults ?? 40));
      });
    });
  }

  private _parseRipgrep(raw: string, maxResults: number): SearchResult[] {
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        const match = /^(.+?):(\d+):(.*)$/.exec(line);
        if (!match) { return null; }
        return {
          file: this._normalize(match[1]),
          line: Number(match[2]),
          text: match[3].trim(),
        };
      })
      .filter((value): value is SearchResult => value !== null)
      .slice(0, maxResults);
  }

  private _searchWithNode(query: string, options?: { maxResults?: number; extensions?: string[] }): SearchResult[] {
    const maxResults = options?.maxResults ?? 40;
    const extensions = new Set((options?.extensions ?? DEFAULT_EXTENSIONS).map(ext => ext.replace(/^\./, '').toLowerCase()));
    const lowerQuery = query.toLowerCase();
    const results: SearchResult[] = [];

    const scan = (dir: string) => {
      if (results.length >= maxResults) { return; }
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

      for (const entry of entries) {
        if (results.length >= maxResults) { break; }
        if (entry.name.startsWith('.') && entry.name !== '.env.example') { continue; }
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRS.has(entry.name)) { scan(fullPath); }
          continue;
        }
        if (!entry.isFile()) { continue; }
        const ext = path.extname(entry.name).replace('.', '').toLowerCase();
        if (!extensions.has(ext)) { continue; }
        this._searchFile(fullPath, lowerQuery, results, maxResults);
      }
    };

    scan(this.workspaceRoot);
    return results;
  }

  private _searchFile(fullPath: string, lowerQuery: string, results: SearchResult[], maxResults: number): void {
    let content: string;
    try { content = fs.readFileSync(fullPath, 'utf8'); } catch { return; }
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length && results.length < maxResults; index++) {
      if (lines[index].toLowerCase().includes(lowerQuery)) {
        results.push({
          file: this._normalize(path.relative(this.workspaceRoot, fullPath)),
          line: index + 1,
          text: lines[index].trim(),
        });
      }
    }
  }

  private _normalize(filePath: string): string {
    return filePath.replace(/^\.\//, '').replace(/\\/g, '/');
  }
}
