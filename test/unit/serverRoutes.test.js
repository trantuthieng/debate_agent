const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');

const { handleGetConfig, handlePostConfig, handleGetModels } = require('../../out/server/routes');
const { ChatConfigStore, DEFAULT_CHAT_CONFIG } = require('../../out/server/chatConfig');
const { createServer } = require('../../out/server/index');
const { MIN_QA_AGENTS, MAX_QA_AGENTS } = require('../../out/prompts/qaPersonas');

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'server-routes-test-'));
}

function fakeOllama(models) {
  return { listModels: async () => models };
}

test('handleGetConfig returns persisted defaults plus the agent/round bounds', () => {
  const ctx = { configStore: new ChatConfigStore(tmpDataDir()), ollama: fakeOllama([]) };
  const { status, body } = handleGetConfig(ctx);
  assert.equal(status, 200);
  assert.deepEqual(body, { ...DEFAULT_CHAT_CONFIG, minAgents: MIN_QA_AGENTS, maxAgents: MAX_QA_AGENTS, maxRounds: 6 });
});

test('handlePostConfig persists and returns the updated config', () => {
  const ctx = { configStore: new ChatConfigStore(tmpDataDir()), ollama: fakeOllama([]) };
  const { status, body } = handlePostConfig(ctx, { rounds: 3, agentCount: 6, webSearchEnabled: false });
  assert.equal(status, 200);
  assert.equal(body.rounds, 3);
  assert.equal(body.agentCount, 6);
  assert.equal(body.webSearchEnabled, false);
  assert.deepEqual(ctx.configStore.read(), { rounds: 3, agentCount: 6, webSearchEnabled: false });
});

test('handlePostConfig rejects a non-object body with 400 instead of crashing', () => {
  const ctx = { configStore: new ChatConfigStore(tmpDataDir()), ollama: fakeOllama([]) };
  for (const bad of [null, 'not an object', 42, [1, 2, 3]]) {
    const { status, body } = handlePostConfig(ctx, bad);
    assert.equal(status, 400);
    assert.ok(body.error);
  }
});

test('handleGetModels returns the installed model list', async () => {
  const ctx = { configStore: new ChatConfigStore(tmpDataDir()), ollama: fakeOllama(['m1', 'm2', 'm3']) };
  const { status, body } = await handleGetModels(ctx);
  assert.equal(status, 200);
  assert.deepEqual(body.models, ['m1', 'm2', 'm3']);
});

test('handleGetModels reports 502 (not a crash) when Ollama is unreachable', async () => {
  const ctx = { configStore: new ChatConfigStore(tmpDataDir()), ollama: { listModels: async () => { throw new Error('ECONNREFUSED'); } } };
  const { status, body } = await handleGetModels(ctx);
  assert.equal(status, 502);
  assert.match(body.error, /ECONNREFUSED/);
});

// ------------------------------------------------------------------
// Full HTTP integration: spin up the real server on an ephemeral port with
// an injected fake Ollama client, so no network access is needed.
// ------------------------------------------------------------------

function listen(server) {
  return new Promise(resolve => server.listen(0, () => resolve(server.address().port)));
}

function fetchJson(port, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: options.method || 'GET', headers: options.body ? { 'Content-Type': 'application/json' } : {} }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        // Static-file responses (404/403) are plain text, not JSON — fall back to raw text.
        try { resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }); }
        catch { resolve({ status: res.statusCode, body: raw, isText: true }); }
      });
    });
    req.on('error', reject);
    if (options.body) { req.write(JSON.stringify(options.body)); }
    req.end();
  });
}

test('the real HTTP server serves /api/config and /api/models end to end', async t => {
  const dataDir = tmpDataDir();
  const server = createServer({ configStore: new ChatConfigStore(dataDir), ollama: fakeOllama(['a', 'b', 'c', 'd', 'e']) });
  const port = await listen(server);
  t.after(() => server.close());

  const getConfig = await fetchJson(port, '/api/config');
  assert.equal(getConfig.status, 200);
  assert.equal(getConfig.body.rounds, DEFAULT_CHAT_CONFIG.rounds);

  const postConfig = await fetchJson(port, '/api/config', { method: 'POST', body: { rounds: 4 } });
  assert.equal(postConfig.status, 200);
  assert.equal(postConfig.body.rounds, 4);

  const getConfigAgain = await fetchJson(port, '/api/config');
  assert.equal(getConfigAgain.body.rounds, 4, 'the POST must have persisted');

  const models = await fetchJson(port, '/api/models');
  assert.equal(models.status, 200);
  assert.deepEqual(models.body.models, ['a', 'b', 'c', 'd', 'e']);
});

test('the real HTTP server returns 404 for an unknown /api/ route and for a missing static file', async t => {
  const server = createServer({ configStore: new ChatConfigStore(tmpDataDir()), ollama: fakeOllama([]) });
  const port = await listen(server);
  t.after(() => server.close());

  const unknownApi = await fetchJson(port, '/api/does-not-exist');
  assert.equal(unknownApi.status, 404);

  const missingStatic = await fetchJson(port, '/this-file-does-not-exist.html');
  assert.equal(missingStatic.status, 404);
});

test('the real HTTP server rejects a path-traversal static-file request', async t => {
  const server = createServer({ configStore: new ChatConfigStore(tmpDataDir()), ollama: fakeOllama([]) });
  const port = await listen(server);
  t.after(() => server.close());

  const traversal = await fetchJson(port, '/..%2f..%2fpackage.json');
  assert.ok([403, 404].includes(traversal.status), `expected the traversal attempt to be blocked, got ${traversal.status}`);
});

// ------------------------------------------------------------------
// WebSocket "ask" flow end to end, against a fake Ollama-shaped client
// (checkConnection/listModels/listModelInventory/chat/callWithFallback —
// the exact slice ModelReadinessService + QaDebate actually call).
// ------------------------------------------------------------------

function fakeDebateOllama(models) {
  return {
    checkConnection: async () => true,
    listModels: async () => models,
    listModelInventory: async () => models.map(name => ({ name })),
    getModelDetails: async () => undefined,
    chat: async () => 'responsive',
    callWithFallback: async (_primary, _fallback, messages, agentRole) => {
      if (agentRole === 'qa-synthesizer') { return 'Final synthesized answer.'; }
      return `Position from ${agentRole}`;
    },
  };
}

function collectWsEvents(port, message) {
  return new Promise((resolve, reject) => {
    const events = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    socket.on('open', () => socket.send(JSON.stringify(message)));
    socket.on('message', raw => {
      const event = JSON.parse(raw.toString());
      events.push(event);
      if (event.type === 'answer' || event.type === 'error') { socket.close(); resolve(events); }
    });
    socket.on('error', reject);
  });
}

test('WebSocket ask flow streams progress and ends with an answer', async t => {
  const server = createServer({
    configStore: new ChatConfigStore(tmpDataDir()),
    ollama: fakeDebateOllama(['m1', 'm2', 'm3', 'm4', 'm5']),
  });
  const port = await listen(server);
  t.after(() => server.close());

  const events = await collectWsEvents(port, { type: 'ask', question: 'Should I buy iPhone 18?', rounds: 1, agentCount: 3, webSearch: false });

  assert.ok(events.some(e => e.type === 'round' && e.round === 1), 'must report round 1 starting');
  const answerEvent = events.find(e => e.type === 'answer');
  assert.ok(answerEvent, `expected an answer event, got types: ${events.map(e => e.type).join(',')}`);
  assert.equal(answerEvent.answer, 'Final synthesized answer.');
});

test('WebSocket ask flow reports an error (not a silent hang/crash) when too few models are ready', async t => {
  const server = createServer({
    configStore: new ChatConfigStore(tmpDataDir()),
    ollama: fakeDebateOllama(['only-one-model']),
  });
  const port = await listen(server);
  t.after(() => server.close());

  const events = await collectWsEvents(port, { type: 'ask', question: 'Q?', agentCount: 3, webSearch: false });
  const errorEvent = events.find(e => e.type === 'error');
  assert.ok(errorEvent, `expected an error event, got types: ${events.map(e => e.type).join(',')}`);
  assert.match(errorEvent.message, /at least/);
});

test('WebSocket ask flow rejects a malformed message instead of hanging', async t => {
  const server = createServer({ configStore: new ChatConfigStore(tmpDataDir()), ollama: fakeDebateOllama([]) });
  const port = await listen(server);
  t.after(() => server.close());

  const events = await collectWsEvents(port, { type: 'not-ask' });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'error');
});
