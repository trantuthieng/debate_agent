const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { OllamaClient } = require('../../out/ollama/OllamaClient');
const { UserAbortError } = require('../../out/utils/errors');

async function serverFor(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('production Ollama transport bypasses fetch and waits for delayed headers plus the full body', async t => {
  t.mock.method(global, 'fetch', async () => { throw new Error('Undici must not handle long inference'); });
  let requestBody = '';
  const url = await serverFor(t, (req, res) => {
    req.on('data', chunk => { requestBody += chunk; });
    req.on('end', () => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"message":');
        setTimeout(() => res.end('{"content":"complete"}}'), 25);
      }, 25);
    });
  });
  const client = new OllamaClient(url, undefined, 600000);
  const response = await client._fetchWithTimeout(`${url}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"model":"fixture"}',
  }, 1000);
  assert.deepEqual(await response.json(), { message: { content: 'complete' } });
  assert.equal(requestBody, '{"model":"fixture"}');
  assert.equal(global.fetch.mock.callCount(), 0);
});

test('native transport enforces the configured deadline while waiting for headers', async t => {
  const url = await serverFor(t, () => {});
  const client = new OllamaClient(url);
  await assert.rejects(client._fetchWithTimeout(`${url}/api/chat`, {}, 25), /timed out after 25ms/);
  assert.equal(client.activeControllers.size, 0);
});

test('native transport enforces the same deadline while a response body is unfinished', async t => {
  const url = await serverFor(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"message":');
  });
  const client = new OllamaClient(url);
  await assert.rejects(client._fetchWithTimeout(`${url}/api/chat`, {}, 25), /timed out after 25ms/);
});

test('Stop destroys an unfinished native HTTP request and preserves UserAbortError', async t => {
  let started;
  const responseStarted = new Promise(resolve => { started = resolve; });
  const url = await serverFor(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"message":');
    started();
  });
  const client = new OllamaClient(url);
  const request = assert.rejects(client._fetchWithTimeout(`${url}/api/chat`, {}, 1000), UserAbortError);
  await responseStarted;
  client.cancelActiveRequests();
  await request;
  assert.equal(client.activeControllers.size, 0);
});

test('truncated native HTTP responses reject instead of returning partial model output', async t => {
  const url = await serverFor(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 1000 });
    res.end('{"incomplete":');
  });
  const client = new OllamaClient(url);
  await assert.rejects(client._fetchWithTimeout(`${url}/api/chat`, {}, 1000), /aborted|reset|socket/i);
});
