import * as fs from 'fs';
import { createHash } from 'crypto';
import type { OllamaTransport } from './OllamaClient';

/**
 * Record every Ollama HTTP exchange of a run, and replay a recording without
 * Ollama. A benchmark that failed after hours can then be re-run in seconds
 * against changed gates or orchestration: the models "answer" exactly as they
 * did, and only our own code differs (ECC eval-driven loop: fast, repeatable
 * evidence before paying for another live run).
 *
 * Only a hash of each request is kept (prompts are large and derivable);
 * responses are stored verbatim.
 */
export interface ModelExchange {
  seq: number;
  at: string;
  method: string;
  path: string;
  model?: string;
  requestSha256: string;
  status?: number;
  contentType?: string;
  body?: string;
  error?: string;
}

export const REPLAY_EXHAUSTED = 'Model replay exhausted';

export function exchangeRequestHash(body: unknown): string {
  return createHash('sha256').update(typeof body === 'string' ? body : '').digest('hex');
}

function requestModel(body: unknown): string | undefined {
  if (typeof body !== 'string') { return undefined; }
  try {
    const parsed = JSON.parse(body) as { model?: unknown; name?: unknown };
    const model = parsed.model ?? parsed.name;
    return typeof model === 'string' ? model : undefined;
  } catch { return undefined; }
}

export class ModelExchangeRecorder {
  private seq = 0;
  constructor(private readonly filePath: string) {}

  record(url: string, init: RequestInit, outcome: { status: number; contentType?: string; body: string } | { error: string }): void {
    const entry: ModelExchange = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      method: init.method ?? 'GET',
      path: new URL(url).pathname,
      model: requestModel(init.body),
      requestSha256: exchangeRequestHash(init.body),
      ...outcome,
    };
    try { fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8'); } catch { /* evidence only; never fail a run */ }
  }
}

export interface ReplayStats { served: number; exactMatches: number; diverged: number; exhausted: number }

/**
 * Serves recorded responses. Chat calls replay strictly in the recorded order
 * per model, preferring an unconsumed exchange with the identical request;
 * when none matches (our prompts changed) the next one in order is served and
 * counted as a divergence. Metadata endpoints (tags, show, ps, unload) repeat
 * their last recorded answer once their queue is used up, because changed
 * code may probe them a different number of times.
 */
export function createReplayTransport(filePath: string): OllamaTransport & { stats: ReplayStats } {
  const queues = new Map<string, ModelExchange[]>();
  const last = new Map<string, ModelExchange>();
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) { continue; }
    let entry: ModelExchange;
    try { entry = JSON.parse(line) as ModelExchange; } catch { continue; }
    const key = replayKey(entry.method, entry.path, entry.model);
    if (!queues.has(key)) { queues.set(key, []); }
    queues.get(key)!.push(entry);
  }
  const stats: ReplayStats = { served: 0, exactMatches: 0, diverged: 0, exhausted: 0 };
  const transport = async (url: string, init: RequestInit): Promise<Response> => {
    if (init.signal?.aborted) { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }
    const method = init.method ?? 'GET';
    const pathname = new URL(url).pathname;
    const model = requestModel(init.body);
    const key = replayKey(method, pathname, model);
    const queue = queues.get(key) ?? [];
    const hash = exchangeRequestHash(init.body);
    let index = queue.findIndex(entry => entry.requestSha256 === hash);
    if (index >= 0) { stats.exactMatches += 1; } else if (queue.length > 0) { index = 0; if (pathname === '/api/chat') { stats.diverged += 1; } }
    let entry = index >= 0 ? queue.splice(index, 1)[0] : undefined;
    if (!entry && pathname !== '/api/chat') { entry = last.get(key); }
    if (!entry) {
      stats.exhausted += 1;
      throw new Error(`${REPLAY_EXHAUSTED}: no recorded ${method} ${pathname}${model ? ` for model "${model}"` : ''} remains.`);
    }
    last.set(key, entry);
    stats.served += 1;
    if (entry.error !== undefined) { throw new Error(entry.error); }
    return new Response([204, 205, 304].includes(entry.status ?? 200) ? null : entry.body ?? '', {
      status: entry.status ?? 200,
      headers: entry.contentType ? { 'Content-Type': entry.contentType } : {},
    });
  };
  return Object.assign(transport, { stats });
}

function replayKey(method: string, pathname: string, model: string | undefined): string {
  // Unloads and chats are per model; inventory calls are global.
  return pathname === '/api/chat' || pathname === '/api/generate' || pathname === '/api/show'
    ? `${method} ${pathname} ${model ?? ''}`
    : `${method} ${pathname}`;
}
