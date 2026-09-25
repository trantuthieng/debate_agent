import * as fs from 'fs';
import * as path from 'path';
import type { SecretVault } from '../SecretVault';
import type { ConnectorExecutionContext, ConnectorResult, ExternalConnector } from '../types';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/youtube/v3';
const YOUTUBE_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';

export class YouTubeConnector implements ExternalConnector {
  readonly id = 'youtube';
  readonly capabilities = ['research', 'read', 'oauth', 'upload', 'scheduling', 'publish'] as const;

  constructor(
    private readonly secrets: SecretVault,
    private readonly workspaceRoot: string,
    private readonly request: typeof fetch = fetch
  ) {}

  async authorizationUrl(redirectUri: string, state: string): Promise<string> {
    const clientId = await this._requiredSecret('youtube.clientId');
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: YOUTUBE_UPLOAD_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchangeAuthorizationCode(code: string, redirectUri: string): Promise<void> {
    const [clientId, clientSecret] = await Promise.all([
      this._requiredSecret('youtube.clientId'),
      this._requiredSecret('youtube.clientSecret'),
    ]);
    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    const token = await this._jsonRequest(TOKEN_URL, { method: 'POST', body });
    await this._storeTokens(token);
  }

  async execute(
    action: string,
    payload: Record<string, unknown>,
    context: ConnectorExecutionContext
  ): Promise<ConnectorResult> {
    switch (action) {
      case 'research': return this._research(payload);
      case 'upload-draft': return this._upload(payload, context, false);
      case 'schedule': return this._upload(payload, context, true);
      case 'status': return this._status(String(payload.videoId ?? ''));
      case 'thumbnail': return this._thumbnail(payload, context);
      default: throw new Error(`Unsupported YouTube action: ${action}`);
    }
  }

  private async _research(payload: Record<string, unknown>): Promise<ConnectorResult> {
    const apiKey = await this.secrets.get('youtube.apiKey');
    if (!apiKey) { throw new Error('YouTube research requires youtube.apiKey in SecretStorage.'); }
    const params = new URLSearchParams({
      part: 'snippet', type: 'video', maxResults: String(payload.maxResults ?? 10),
      q: String(payload.query ?? ''), key: apiKey,
    });
    const data = await this._jsonRequest(`${API}/search?${params}`);
    return { success: true, output: data };
  }

  private async _upload(
    payload: Record<string, unknown>,
    context: ConnectorExecutionContext,
    scheduled: boolean
  ): Promise<ConnectorResult> {
    this._requireScope(context, YOUTUBE_UPLOAD_SCOPE);
    if (scheduled && context.publishPolicy !== 'auto-publish') {
      throw new Error('Scheduling/publishing is blocked by the draft-only policy.');
    }
    if (payload.musicRightsConfirmed !== true) {
      throw new Error('Upload blocked until musicRightsConfirmed is explicitly true.');
    }
    const file = this._workspaceFile(String(payload.videoPath ?? ''));
    const bytes = fs.readFileSync(file);
    const publishAt = scheduled ? String(payload.publishAt ?? '') : '';
    if (scheduled && (!publishAt || Number.isNaN(Date.parse(publishAt)))) {
      throw new Error('A valid ISO publishAt timestamp is required for scheduling.');
    }
    const accessToken = await this._accessToken();
    const metadata = {
      snippet: {
        title: String(payload.title ?? ''),
        description: String(payload.description ?? ''),
        tags: Array.isArray(payload.tags) ? payload.tags.map(String) : [],
        categoryId: String(payload.categoryId ?? '10'),
      },
      status: {
        privacyStatus: scheduled ? 'private' : 'private',
        selfDeclaredMadeForKids: Boolean(payload.madeForKids),
        ...(scheduled ? { publishAt } : {}),
      },
    };
    if (!metadata.snippet.title.trim()) { throw new Error('Video title is required.'); }

    const start = await this.request(`${UPLOAD_API}/videos?uploadType=resumable&part=snippet,status`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Length': String(bytes.length),
        'X-Upload-Content-Type': String(payload.mimeType ?? 'video/mp4'),
      },
      body: JSON.stringify(metadata),
    });
    await this._assertOk(start);
    const uploadUrl = start.headers.get('location');
    if (!uploadUrl) { throw new Error('YouTube did not return a resumable upload URL.'); }
    const uploaded = await this.request(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': String(payload.mimeType ?? 'video/mp4') },
      body: bytes,
    });
    const data = await this._responseJson(uploaded);
    return { success: true, externalId: String(data.id ?? ''), output: data };
  }

  private async _thumbnail(payload: Record<string, unknown>, context: ConnectorExecutionContext): Promise<ConnectorResult> {
    this._requireScope(context, YOUTUBE_UPLOAD_SCOPE);
    const videoId = String(payload.videoId ?? '');
    if (!videoId) { throw new Error('videoId is required.'); }
    const bytes = fs.readFileSync(this._workspaceFile(String(payload.thumbnailPath ?? '')));
    const token = await this._accessToken();
    const response = await this.request(`${UPLOAD_API}/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': String(payload.mimeType ?? 'image/jpeg') }, body: bytes,
    });
    return { success: true, externalId: videoId, output: await this._responseJson(response) };
  }

  private async _status(videoId: string): Promise<ConnectorResult> {
    if (!videoId) { throw new Error('videoId is required.'); }
    const token = await this._accessToken();
    const response = await this._jsonRequest(`${API}/videos?part=status,processingDetails&id=${encodeURIComponent(videoId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { success: true, externalId: videoId, output: response };
  }

  private async _accessToken(): Promise<string> {
    const access = await this.secrets.get('youtube.accessToken');
    const expiry = Number(await this.secrets.get('youtube.accessTokenExpiresAt') ?? 0);
    if (access && expiry > Date.now() + 60_000) { return access; }
    const refreshToken = await this.secrets.get('youtube.refreshToken');
    if (!refreshToken) { throw new Error('YouTube OAuth consent is required before upload.'); }
    const [clientId, clientSecret] = await Promise.all([
      this._requiredSecret('youtube.clientId'),
      this._requiredSecret('youtube.clientSecret'),
    ]);
    const body = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    });
    const token = await this._jsonRequest(TOKEN_URL, { method: 'POST', body });
    await this._storeTokens(token);
    const refreshed = await this.secrets.get('youtube.accessToken');
    if (!refreshed) { throw new Error('OAuth refresh did not return an access token.'); }
    return refreshed;
  }

  private async _storeTokens(token: Record<string, unknown>): Promise<void> {
    const access = String(token.access_token ?? '');
    if (!access) { throw new Error('OAuth token response did not contain access_token.'); }
    await this.secrets.store('youtube.accessToken', access);
    await this.secrets.store('youtube.accessTokenExpiresAt', String(Date.now() + Number(token.expires_in ?? 3600) * 1000));
    if (token.refresh_token) { await this.secrets.store('youtube.refreshToken', String(token.refresh_token)); }
  }

  private _requireScope(context: ConnectorExecutionContext, scope: string): void {
    if (!context.approvedScopes.includes(scope)) { throw new Error(`Approval scope is missing: ${scope}`); }
  }

  private _workspaceFile(relativePath: string): string {
    const full = path.resolve(this.workspaceRoot, relativePath);
    const relative = path.relative(this.workspaceRoot, full);
    if (!relativePath || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Media path must stay inside the workspace.');
    }
    try {
      if (!fs.statSync(full).isFile()) { throw new Error(); }
    } catch { throw new Error(`Media file not found: ${relativePath}`); }
    return full;
  }

  private async _requiredSecret(name: string): Promise<string> {
    const value = (await this.secrets.get(name))?.trim();
    if (!value) { throw new Error(`${name} is required in VS Code SecretStorage for YouTube OAuth.`); }
    return value;
  }

  private async _jsonRequest(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
    return this._responseJson(await this.request(url, init));
  }

  private async _responseJson(response: Response): Promise<Record<string, unknown>> {
    await this._assertOk(response);
    return await response.json() as Record<string, unknown>;
  }

  private async _assertOk(response: Response): Promise<void> {
    if (response.ok) { return; }
    const detail = (await response.text()).slice(0, 1000);
    throw new Error(`YouTube API failed (${response.status}): ${detail}`);
  }
}
