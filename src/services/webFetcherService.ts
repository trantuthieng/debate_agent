import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import type { WebFetchResult } from '../types';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_CONTENT_BYTES = 500_000; // 500 KB cap before stripping HTML
const MAX_TEXT_CHARS = 20_000;    // final text cap per page

// -----------------------------------------------------------------------
// WebFetcherService – fetch web pages and return clean plain text
// -----------------------------------------------------------------------
export class WebFetcherService {
  private readonly timeoutMs: number;

  constructor(timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * Fetch a single URL and return clean text.
   */
  async fetchUrl(url: string): Promise<WebFetchResult> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return { url, success: false, error: `Invalid URL: ${url}`, text: '' };
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return { url, success: false, error: `Unsupported protocol: ${parsedUrl.protocol}`, text: '' };
    }

    try {
      const rawHtml = await this._fetchRaw(parsedUrl, 0);
      const text = this._extractText(rawHtml);
      return { url, success: true, text };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { url, success: false, error: message, text: '' };
    }
  }

  /**
   * Fetch multiple URLs concurrently.
   */
  async fetchUrls(urls: string[]): Promise<WebFetchResult[]> {
    return Promise.all(urls.map(u => this.fetchUrl(u)));
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  private _fetchRaw(url: URL, redirectCount: number): Promise<string> {
    const MAX_REDIRECTS = 5;
    if (redirectCount > MAX_REDIRECTS) {
      return Promise.reject(new Error('Too many redirects'));
    }

    return new Promise((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; LocalMultiAgentCoder/1.0)',
          'Accept': 'text/html,application/xhtml+xml,*/*',
          'Accept-Encoding': 'gzip, deflate',
          'Accept-Language': 'en-US,en;q=0.9',
          'Connection': 'close',
        },
        timeout: this.timeoutMs,
      };

      const req = transport.request(options, res => {
        // Follow redirects
        if (
          res.statusCode !== undefined &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          let nextUrl: URL;
          try {
            nextUrl = new URL(res.headers.location, url);
          } catch {
            reject(new Error(`Invalid redirect URL: ${res.headers.location}`));
            return;
          }
          resolve(this._fetchRaw(nextUrl, redirectCount + 1));
          return;
        }

        if (res.statusCode !== undefined && (res.statusCode < 200 || res.statusCode >= 300)) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url.href}`));
          return;
        }

        const chunks: Buffer[] = [];
        let totalBytes = 0;

        const encoding = res.headers['content-encoding'];
        let stream: NodeJS.ReadableStream = res;

        if (encoding === 'gzip') {
          stream = res.pipe(zlib.createGunzip());
        } else if (encoding === 'deflate') {
          stream = res.pipe(zlib.createInflate());
        }

        stream.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes <= MAX_CONTENT_BYTES) {
            chunks.push(chunk);
          }
        });

        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        stream.on('error', reject);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timed out after ${this.timeoutMs}ms`));
      });

      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Strip HTML tags and extract readable plain text from an HTML string.
   */
  private _extractText(html: string): string {
    // Remove script and style blocks entirely
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');

    // Replace block-level tags with newlines for readability
    text = text.replace(/<\/?(p|div|section|article|header|footer|nav|main|aside|h[1-6]|li|tr|br)[^>]*>/gi, '\n');

    // Remove all remaining HTML tags
    text = text.replace(/<[^>]+>/g, ' ');

    // Decode common HTML entities
    text = text
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&nbsp;/gi, ' ')
      .replace(/&#(\d+);/gi, (_, code) => String.fromCharCode(Number(code)));

    // Collapse whitespace
    text = text
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // Truncate to max chars
    if (text.length > MAX_TEXT_CHARS) {
      text = text.slice(0, MAX_TEXT_CHARS) + '\n\n[Content truncated]';
    }

    return text;
  }
}
