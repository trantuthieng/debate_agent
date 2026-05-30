import * as https from 'https';
import type { WebFetchResult, WebSearchConfig } from '../types';
import { WebFetcherService } from './webFetcherService';

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchReport {
  generatedAt: string;
  query: string;
  hits: WebSearchHit[];
  fetched: WebFetchResult[];
  warnings: string[];
}

export class WebSearchService {
  private readonly fetcher = new WebFetcherService();

  constructor(private readonly config?: Partial<WebSearchConfig>) {}

  async searchAndFetch(query: string): Promise<WebSearchReport> {
    const cfg = {
      enabled: false,
      maxResults: 5,
      officialDocsOnly: true,
      allowedDomains: [],
      ...this.config,
    };
    const warnings: string[] = [];
    if (!cfg.enabled) {
      return { generatedAt: new Date().toISOString(), query, hits: [], fetched: [], warnings: ['Web search disabled.'] };
    }

    let hits: WebSearchHit[] = [];
    try {
      hits = await this._searchDuckDuckGo(query, cfg.maxResults);
    } catch (err) {
      warnings.push(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (cfg.officialDocsOnly || cfg.allowedDomains.length > 0) {
      const allowedDomains = cfg.allowedDomains.map(domain => domain.toLowerCase());
      hits = hits.filter(hit => {
        try {
          const host = new URL(hit.url).hostname.replace(/^www\./, '').toLowerCase();
          return allowedDomains.some(domain => host === domain || host.endsWith(`.${domain}`));
        } catch {
          return false;
        }
      });
    }

    const fetched = await this.fetcher.fetchUrls(hits.slice(0, cfg.maxResults).map(hit => hit.url));
    return {
      generatedAt: new Date().toISOString(),
      query,
      hits,
      fetched,
      warnings,
    };
  }

  private _searchDuckDuckGo(query: string, maxResults: number): Promise<WebSearchHit[]> {
    const url = new URL('https://duckduckgo.com/html/');
    url.searchParams.set('q', query);
    return new Promise((resolve, reject) => {
      https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; LocalMultiAgentCoder/1.0)',
          'Accept': 'text/html,*/*',
        },
      }, res => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
        res.on('end', () => resolve(this._parseDuckDuckGo(Buffer.concat(chunks).toString('utf8'), maxResults)));
      }).on('error', reject);
    });
  }

  private _parseDuckDuckGo(html: string, maxResults: number): WebSearchHit[] {
    const hits: WebSearchHit[] = [];
    const resultPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;
    while ((match = resultPattern.exec(html)) !== null && hits.length < maxResults) {
      const url = this._decodeDuckDuckGoUrl(this._decodeHtml(match[1]));
      hits.push({
        url,
        title: this._stripHtml(match[2]),
        snippet: this._stripHtml(match[3]),
      });
    }
    return hits;
  }

  private _decodeDuckDuckGoUrl(value: string): string {
    try {
      const parsed = new URL(value, 'https://duckduckgo.com');
      return parsed.searchParams.get('uddg') ?? parsed.href;
    } catch {
      return value;
    }
  }

  private _stripHtml(value: string): string {
    return this._decodeHtml(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  }

  private _decodeHtml(value: string): string {
    return value
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }
}
