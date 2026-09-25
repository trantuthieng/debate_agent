import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  ConnectorAuditEvent,
  ConnectorExecutionContext,
  ConnectorJob,
  ExternalConnector,
} from './types';

/** Persistent, idempotent queue for approved external side effects. */
export class ConnectorJobQueue {
  private readonly queuePath: string;
  private readonly auditPath: string;

  constructor(agentWorkspaceDir: string) {
    const dir = path.join(agentWorkspaceDir, 'connectors');
    fs.mkdirSync(dir, { recursive: true });
    this.queuePath = path.join(dir, 'jobs.json');
    this.auditPath = path.join(dir, 'audit.jsonl');
  }

  enqueue(input: {
    connectorId: string;
    action: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    maxAttempts?: number;
  }): ConnectorJob {
    const jobs = this.list();
    const existing = jobs.find(job => job.idempotencyKey === input.idempotencyKey);
    if (existing) { return existing; }
    const now = new Date().toISOString();
    const job: ConnectorJob = {
      id: crypto.randomUUID(),
      connectorId: input.connectorId,
      action: input.action,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
      status: 'queued',
      attempts: 0,
      maxAttempts: Math.max(1, input.maxAttempts ?? 3),
      createdAt: now,
      updatedAt: now,
    };
    jobs.push(job);
    this._write(jobs);
    return job;
  }

  list(): ConnectorJob[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.queuePath, 'utf8')) as unknown;
      return Array.isArray(parsed) ? parsed as ConnectorJob[] : [];
    } catch { return []; }
  }

  async runNext(
    connectors: Map<string, ExternalConnector>,
    context: ConnectorExecutionContext
  ): Promise<ConnectorJob | null> {
    const jobs = this.list();
    const job = jobs.find(candidate => candidate.status === 'queued' || candidate.status === 'retrying');
    if (!job) { return null; }
    const connector = connectors.get(job.connectorId);
    if (!connector) {
      job.status = 'failed';
      job.error = `Connector not registered: ${job.connectorId}`;
      job.updatedAt = new Date().toISOString();
      this._write(jobs);
      this._audit(job, context, job.error);
      return job;
    }

    job.status = 'running';
    job.attempts += 1;
    job.updatedAt = new Date().toISOString();
    this._write(jobs);
    try {
      job.result = await connector.execute(job.action, job.payload, context);
      if (!job.result.success) { throw new Error(String(job.result.output.error ?? 'Connector returned failure.')); }
      job.status = 'completed';
      job.error = undefined;
      this._audit(job, context, `External action completed${job.result.externalId ? ` (${job.result.externalId})` : ''}.`);
    } catch (err) {
      job.error = err instanceof Error ? err.message : String(err);
      job.status = job.attempts < job.maxAttempts ? 'retrying' : 'failed';
      this._audit(job, context, job.error);
    }
    job.updatedAt = new Date().toISOString();
    this._write(jobs);
    return job;
  }

  async rollback(
    jobId: string,
    connectors: Map<string, ExternalConnector>,
    context: ConnectorExecutionContext
  ): Promise<ConnectorJob> {
    const jobs = this.list();
    const job = jobs.find(candidate => candidate.id === jobId);
    if (!job) { throw new Error(`Job not found: ${jobId}`); }
    const connector = connectors.get(job.connectorId);
    if (!connector?.rollback || !job.result?.rollbackToken) {
      throw new Error(`Job ${jobId} is not rollback-capable.`);
    }
    const result = await connector.rollback(job.result.rollbackToken, context);
    if (!result.success) { throw new Error(String(result.output.error ?? 'Rollback failed.')); }
    job.status = 'rolled_back';
    job.updatedAt = new Date().toISOString();
    this._write(jobs);
    this._audit(job, context, 'External action rolled back.');
    return job;
  }

  private _write(jobs: ConnectorJob[]): void {
    const tmp = `${this.queuePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this.queuePath);
  }

  private _audit(job: ConnectorJob, context: ConnectorExecutionContext, detail: string): void {
    const event: ConnectorAuditEvent = {
      timestamp: new Date().toISOString(),
      jobId: job.id,
      requestedBy: context.requestedBy,
      decidedByAgent: context.decidedByAgent,
      connectorId: job.connectorId,
      action: job.action,
      outcome: job.status,
      detail,
    };
    fs.appendFileSync(this.auditPath, JSON.stringify(event) + '\n', 'utf8');
  }
}
