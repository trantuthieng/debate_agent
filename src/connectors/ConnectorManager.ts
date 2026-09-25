import * as crypto from 'crypto';
import type { SecretVault } from './SecretVault';
import { ConnectorJobQueue } from './ConnectorJobQueue';
import type { ConnectorExecutionContext, PublishPolicy } from './types';
import { YouTubeConnector } from './youtube/YouTubeConnector';

export interface ConnectorToolExecutor {
  executeTool(name: string, args: Record<string, unknown>, decidedByAgent: string): Promise<string>;
}

/** Bridges approved agent tool calls to the audited connector job queue. */
export class ConnectorManager implements ConnectorToolExecutor {
  private readonly queue: ConnectorJobQueue;
  private readonly youtube: YouTubeConnector;

  constructor(private readonly secrets: SecretVault, workspaceRoot: string) {
    this.queue = new ConnectorJobQueue(`${workspaceRoot}/.agent-workspace`);
    this.youtube = new YouTubeConnector(secrets, workspaceRoot);
  }

  async grantYouTube(scopes: string[], publishPolicy: PublishPolicy): Promise<void> {
    await this.secrets.store('connectors.youtube.approval', JSON.stringify({
      scopes: [...new Set(scopes)], publishPolicy, grantedAt: new Date().toISOString(),
    }));
  }

  async youtubeAuthorizationUrl(redirectUri: string, state: string): Promise<string> {
    return this.youtube.authorizationUrl(redirectUri, state);
  }

  async exchangeYoutubeAuthorizationCode(code: string, redirectUri: string): Promise<void> {
    await this.youtube.exchangeAuthorizationCode(code, redirectUri);
  }

  async executeTool(name: string, args: Record<string, unknown>, decidedByAgent: string): Promise<string> {
    const actions: Record<string, string> = {
      youtube_research: 'research',
      youtube_upload_draft: 'upload-draft',
      youtube_schedule: 'schedule',
      youtube_status: 'status',
      youtube_thumbnail: 'thumbnail',
    };
    const action = actions[name];
    if (!action) { throw new Error(`Unknown connector tool: ${name}`); }
    const context = await this._context(decidedByAgent);
    const payload = { ...args };
    delete payload.idempotencyKey;
    const defaultKey = action === 'research' || action === 'status'
      ? crypto.randomUUID()
      : this._key('youtube', action, payload);
    const idempotencyKey = String(args.idempotencyKey ?? defaultKey);
    const job = this.queue.enqueue({ connectorId: 'youtube', action, payload, idempotencyKey });
    if (job.status === 'completed') {
      return JSON.stringify({ jobId: job.id, status: job.status, result: job.result }, null, 2);
    }
    const result = await this.queue.runNext(new Map([['youtube', this.youtube]]), context);
    if (!result || result.id !== job.id) {
      throw new Error(`Connector job ${job.id} is queued behind earlier work.`);
    }
    if (result.status !== 'completed') {
      throw new Error(`Connector job ${result.status}: ${result.error ?? 'retry pending'}`);
    }
    return JSON.stringify({ jobId: result.id, status: result.status, result: result.result }, null, 2);
  }

  private async _context(decidedByAgent: string): Promise<ConnectorExecutionContext> {
    const raw = await this.secrets.get('connectors.youtube.approval');
    if (!raw) { throw new Error('YouTube connector has not been approved. Run “Configure YouTube Connector”.'); }
    let approval: { scopes?: unknown; publishPolicy?: unknown };
    try { approval = JSON.parse(raw); } catch { throw new Error('Stored YouTube approval policy is invalid.'); }
    const publishPolicy = approval.publishPolicy === 'auto-publish' ? 'auto-publish' : 'draft-only';
    return {
      approvedScopes: Array.isArray(approval.scopes) ? approval.scopes.map(String) : [],
      publishPolicy,
      requestedBy: 'boss',
      decidedByAgent,
    };
  }

  private _key(connector: string, action: string, payload: Record<string, unknown>): string {
    return crypto.createHash('sha256').update(JSON.stringify({ connector, action, payload })).digest('hex');
  }
}
