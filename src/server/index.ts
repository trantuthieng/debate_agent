import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { OllamaClient } from '../ollama/OllamaClient';
import { ChatConfigStore, clampChatConfig } from './chatConfig';
import { handleGetConfig, handlePostConfig, handleGetModels, type RouteContext } from './routes';
import { answerQuestion } from './askHandler';
import { logInfo, logError } from '../utils/logging';

const PORT = Number(process.env.PORT) || 8787;
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434';
const DATA_DIR = process.env.CHAT_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const PUBLIC_DIR = process.env.CHAT_PUBLIC_DIR || path.join(__dirname, '..', '..', 'public');
const MAX_REQUEST_BODY_BYTES = 1_000_000;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function respondJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
      if (raw.length > MAX_REQUEST_BODY_BYTES) {
        tooLarge = true;
        req.destroy();
        reject(new Error('Request body too large.'));
      }
    });
    req.on('end', () => {
      if (tooLarge) { return; }
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const resolved = path.normalize(path.join(PUBLIC_DIR, relative));
  // Reject any path that escapes PUBLIC_DIR (e.g. "../../etc/passwd").
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    // No-store: this is a small self-hosted tool, not a CDN-fronted site —
    // always serve the file on disk rather than risk a stale cached
    // index.html/app.js surviving a reload after a deploy.
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(resolved)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

/** `overrides` lets tests inject a fake `OllamaClient`/`ChatConfigStore` without touching the network or filesystem defaults. */
export function createServer(overrides: Partial<RouteContext> = {}): http.Server {
  const ctx: RouteContext = {
    ollama: overrides.ollama ?? new OllamaClient(OLLAMA_BASE_URL),
    configStore: overrides.configStore ?? new ChatConfigStore(DATA_DIR),
  };

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, ctx).catch(err => {
      logError(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) { respondJson(res, 500, { error: 'Internal error' }); }
    });
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (socket: WebSocket) => {
    socket.on('message', (raw: RawData) => {
      void handleAskMessage(socket, raw, ctx).catch(err => {
        logError(`WebSocket ask handler failed: ${err instanceof Error ? err.message : String(err)}`);
        safeSend(socket, { type: 'error', message: 'Internal error.' });
      });
    });
  });

  return server;
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, ctx: RouteContext): Promise<void> {
  const url = (req.url ?? '').split('?')[0];
  if (url === '/api/config' && req.method === 'GET') {
    const { status, body } = handleGetConfig(ctx);
    respondJson(res, status, body); return;
  }
  if (url === '/api/config' && req.method === 'POST') {
    let parsed: unknown;
    try { parsed = await readJsonBody(req); } catch (err) {
      respondJson(res, 400, { error: `Invalid JSON body: ${err instanceof Error ? err.message : String(err)}` }); return;
    }
    const { status, body } = handlePostConfig(ctx, parsed);
    respondJson(res, status, body); return;
  }
  if (url === '/api/models' && req.method === 'GET') {
    const { status, body } = await handleGetModels(ctx);
    respondJson(res, status, body); return;
  }
  if (url.startsWith('/api/')) {
    respondJson(res, 404, { error: 'Unknown API route.' }); return;
  }
  serveStatic(req, res);
}

function safeSend(socket: WebSocket, event: unknown): void {
  if (socket.readyState === socket.OPEN) { socket.send(JSON.stringify(event)); }
}

async function handleAskMessage(socket: WebSocket, raw: RawData, ctx: RouteContext): Promise<void> {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    safeSend(socket, { type: 'error', message: 'Invalid JSON message.' });
    return;
  }
  if (msg.type !== 'ask' || typeof msg.question !== 'string' || !msg.question.trim()) {
    safeSend(socket, { type: 'error', message: 'Expected {"type":"ask","question":"..."}.' });
    return;
  }

  // Per-question overrides (from the settings panel's current values in the
  // UI) fall back to the persisted defaults, WITHOUT overwriting them —
  // only the settings panel's own POST /api/config call persists a change.
  const persisted = ctx.configStore.read();
  const config = clampChatConfig({
    rounds: (msg.rounds as number | undefined) ?? persisted.rounds,
    agentCount: (msg.agentCount as number | undefined) ?? persisted.agentCount,
    webSearchEnabled: (msg.webSearch as boolean | undefined) ?? persisted.webSearchEnabled,
  });

  await answerQuestion(ctx.ollama, msg.question.trim(), config, event => safeSend(socket, event));
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, () => {
    logInfo(`Chatbot server listening on :${PORT} (Ollama at ${OLLAMA_BASE_URL}, data at ${DATA_DIR}, static at ${PUBLIC_DIR})`);
  });
}
