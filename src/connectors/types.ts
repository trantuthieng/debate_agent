export type ConnectorCapability = 'research' | 'read' | 'write' | 'oauth' | 'upload' | 'scheduling' | 'publish';
export type PublishPolicy = 'draft-only' | 'auto-publish';

export interface ConnectorExecutionContext {
  approvedScopes: string[];
  publishPolicy: PublishPolicy;
  requestedBy: string;
  decidedByAgent: string;
}

export interface ConnectorResult {
  success: boolean;
  externalId?: string;
  output: Record<string, unknown>;
  rollbackToken?: string;
}

export interface ExternalConnector {
  readonly id: string;
  readonly capabilities: readonly ConnectorCapability[];
  execute(action: string, payload: Record<string, unknown>, context: ConnectorExecutionContext): Promise<ConnectorResult>;
  rollback?(token: string, context: ConnectorExecutionContext): Promise<ConnectorResult>;
}

export interface ConnectorJob {
  id: string;
  connectorId: string;
  action: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  status: 'queued' | 'running' | 'retrying' | 'completed' | 'failed' | 'rolled_back';
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  result?: ConnectorResult;
  error?: string;
}

export interface ConnectorAuditEvent {
  timestamp: string;
  jobId: string;
  requestedBy: string;
  decidedByAgent: string;
  connectorId: string;
  action: string;
  outcome: ConnectorJob['status'];
  detail: string;
}
