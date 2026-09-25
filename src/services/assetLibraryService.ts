import * as fs from 'fs';
import * as path from 'path';
import type { AssetLibraryConfig } from '../types';

const OPENVERSE_API = 'https://api.openverse.org/v1/images/';
const MAX_BYTES_HARD_CAP = 10_000_000;
const ALLOWED_CONTENT_TYPES: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
};

interface OpenverseResult {
  id?: string;
  title?: string;
  url?: string;
  thumbnail?: string;
  width?: number;
  height?: number;
  license?: string;
  license_version?: string;
  creator?: string;
  creator_url?: string;
  source?: string;
  foreign_landing_url?: string;
}

export interface AssetSearchHit {
  id: string;
  title: string;
  imageUrl: string;
  thumbnailUrl: string;
  width?: number;
  height?: number;
  license: string;
  licenseVersion: string;
  creator: string;
  creatorUrl: string;
  source: string;
  foreignLandingUrl: string;
}

export interface AssetSearchOutcome {
  query: string;
  generatedAt: string;
  hits: AssetSearchHit[];
  warnings: string[];
}

export interface AssetAttribution {
  title: string;
  creator: string;
  license: string;
  licenseVersion: string;
  source: string;
  foreignLandingUrl: string;
}

export interface AssetFetchResult {
  success: boolean;
  savedPath?: string;
  bytes?: number;
  error?: string;
}

/**
 * Governed visual-asset capability: search Openverse's openly-licensed image
 * index (no API key required) and save a chosen image into the workspace,
 * recording its license and attribution alongside the file so a generated
 * product never ships unattributed or non-permissive artwork.
 *
 * OPT-IN and network-gated by config, matching ResearchService: when disabled,
 * both methods return an empty/clear result instead of reaching out.
 */
export class AssetLibraryService {
  constructor(
    private readonly workspaceRoot: string,
    private readonly config: AssetLibraryConfig,
    private readonly request: typeof fetch = fetch
  ) {}

  get enabled(): boolean {
    return this.config.enabled === true;
  }

  private get maxResults(): number {
    return Math.max(1, Math.min(20, this.config.maxResults ?? 8));
  }

  private get maxBytes(): number {
    return Math.max(1, Math.min(MAX_BYTES_HARD_CAP, this.config.maxBytes || 5_000_000));
  }

  private get allowedLicenses(): string[] {
    return (this.config.allowedLicenses ?? []).map(l => l.toLowerCase());
  }

  /** Search Openverse for openly-licensed images matching a query. */
  async searchImages(query: string): Promise<AssetSearchOutcome> {
    const generatedAt = new Date().toISOString();
    if (!this.enabled) {
      return { query, generatedAt, hits: [], warnings: ['Asset library is disabled in config (assetLibrary.enabled=false).'] };
    }
    const trimmed = query.trim();
    if (!trimmed) {
      return { query, generatedAt, hits: [], warnings: ['A non-empty search query is required.'] };
    }
    const params = new URLSearchParams({
      q: trimmed,
      license_type: 'commercial,modification',
      mature: 'false',
      page_size: String(this.maxResults),
    });
    try {
      const response = await this.request(`${OPENVERSE_API}?${params.toString()}`, {
        headers: { 'User-Agent': 'LocalMultiAgentCoder/1.0' },
      });
      if (!response.ok) {
        return { query, generatedAt, hits: [], warnings: [`Openverse search failed: HTTP ${response.status}`] };
      }
      const data = await response.json() as { results?: OpenverseResult[] };
      const allowed = this.allowedLicenses;
      const hits = (data.results ?? [])
        .filter(r => allowed.length === 0 || allowed.includes(String(r.license ?? '').toLowerCase()))
        .slice(0, this.maxResults)
        .map(r => this._toHit(r));
      const warnings = hits.length === 0 ? ['No results matched the allowed-license filter.'] : [];
      return { query, generatedAt, hits, warnings };
    } catch (err) {
      return { query, generatedAt, hits: [], warnings: [`Openverse search failed: ${err instanceof Error ? err.message : String(err)}`] };
    }
  }

  /**
   * Download a chosen image into the workspace and record its license +
   * attribution in ASSET_LICENSES.md. Rejects non-image responses, oversized
   * files, and destinations outside the workspace.
   */
  async fetchImage(imageUrl: string, destRelativePath: string, attribution: AssetAttribution): Promise<AssetFetchResult> {
    if (!this.enabled) {
      return { success: false, error: 'Asset library is disabled in config (assetLibrary.enabled=false).' };
    }
    let parsed: URL;
    try {
      parsed = new URL(imageUrl);
    } catch {
      return { success: false, error: `Invalid image URL: ${imageUrl}` };
    }
    if (parsed.protocol !== 'https:') {
      return { success: false, error: 'Only https image URLs are allowed.' };
    }
    const dest = this._resolveWorkspacePath(destRelativePath);
    if (!dest) {
      return { success: false, error: 'Destination path must stay inside the workspace.' };
    }
    try {
      const response = await this.request(imageUrl);
      if (!response.ok) {
        return { success: false, error: `Image download failed: HTTP ${response.status}` };
      }
      const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!ALLOWED_CONTENT_TYPES[contentType]) {
        return { success: false, error: `Unsupported or missing image content-type: ${contentType || '(none)'}` };
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) {
        return { success: false, error: 'Downloaded image was empty.' };
      }
      if (buffer.length > this.maxBytes) {
        return { success: false, error: `Image exceeds the ${this.maxBytes}-byte limit (${buffer.length} bytes).` };
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buffer);
      this._recordAttribution(destRelativePath, attribution, imageUrl);
      return { success: true, savedPath: destRelativePath, bytes: buffer.length };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private _toHit(r: OpenverseResult): AssetSearchHit {
    return {
      id: String(r.id ?? ''),
      title: String(r.title ?? '(untitled)'),
      imageUrl: String(r.url ?? ''),
      thumbnailUrl: String(r.thumbnail ?? ''),
      width: r.width,
      height: r.height,
      license: String(r.license ?? '').toLowerCase(),
      licenseVersion: String(r.license_version ?? ''),
      creator: String(r.creator ?? 'unknown'),
      creatorUrl: String(r.creator_url ?? ''),
      source: String(r.source ?? ''),
      foreignLandingUrl: String(r.foreign_landing_url ?? ''),
    };
  }

  private _resolveWorkspacePath(relativePath: string): string | null {
    if (!relativePath || path.isAbsolute(relativePath)) { return null; }
    const full = path.resolve(this.workspaceRoot, relativePath);
    const relative = path.relative(this.workspaceRoot, full);
    if (relative.startsWith('..')) { return null; }
    return full;
  }

  private _recordAttribution(savedPath: string, attribution: AssetAttribution, imageUrl: string): void {
    const manifestPath = path.join(this.workspaceRoot, 'ASSET_LICENSES.md');
    const entry = [
      `## ${savedPath}`,
      `- Title: ${attribution.title}`,
      `- Creator: ${attribution.creator}`,
      `- License: ${attribution.license}${attribution.licenseVersion ? ` ${attribution.licenseVersion}` : ''}`,
      `- Source: ${attribution.source}`,
      `- Landing page: ${attribution.foreignLandingUrl}`,
      `- Direct URL: ${imageUrl}`,
      `- Retrieved: ${new Date().toISOString()}`,
      '',
    ].join('\n');
    if (!fs.existsSync(manifestPath)) {
      fs.writeFileSync(
        manifestPath,
        '# Asset Licenses\n\nEvery image fetched through the asset-library tool is recorded here for ' +
          'attribution and license compliance. Review before shipping or publishing.\n\n' + entry
      );
    } else {
      fs.appendFileSync(manifestPath, entry);
    }
  }
}
