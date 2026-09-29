const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { TelegramNotifierService } = require('../../out/services/telegramNotifierService');

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

test('without botToken/chatId, notify() no-ops and warns exactly once', async () => {
  const warnings = [];
  const notifier = new TelegramNotifierService({ onWarn: msg => warnings.push(msg) });

  assert.equal(notifier.isConfigured, false);
  notifier.notify('first phase');
  notifier.notify('second phase');
  await notifier.flush();

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /not configured/);
});

test('sends a message to the configured chat via the Bot API sendMessage endpoint', async t => {
  const requests = [];
  const apiBaseUrl = await serverFor(t, (req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ path: req.url, body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  const notifier = new TelegramNotifierService({ botToken: 'abc123', chatId: '999', apiBaseUrl, minIntervalMs: 5 });
  notifier.notify('🔷 Phase: coding');
  await notifier.flush();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/botabc123/sendMessage');
  assert.equal(requests[0].body.chat_id, '999');
  assert.equal(requests[0].body.text, '🔷 Phase: coding');
});

test('serializes multiple notify() calls in order instead of racing them', async t => {
  const received = [];
  const apiBaseUrl = await serverFor(t, (req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push(JSON.parse(body).text);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });

  const notifier = new TelegramNotifierService({ botToken: 't', chatId: '1', apiBaseUrl, minIntervalMs: 5 });
  notifier.notify('one');
  notifier.notify('two');
  notifier.notify('three');
  await notifier.flush();

  assert.deepEqual(received, ['one', 'two', 'three']);
});

test('an HTTP error from the API is reported via onWarn instead of throwing', async t => {
  const warnings = [];
  const apiBaseUrl = await serverFor(t, (req, res) => {
    req.on('data', () => {});
    req.on('end', () => { res.writeHead(401); res.end('unauthorized'); });
  });

  const notifier = new TelegramNotifierService({ botToken: 'bad', chatId: '1', apiBaseUrl, minIntervalMs: 5, onWarn: msg => warnings.push(msg) });
  assert.doesNotThrow(() => notifier.notify('hello'));
  await notifier.flush();

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /HTTP 401/);
});

test('a message longer than Telegram\'s cap is truncated, not rejected', async t => {
  const received = [];
  const apiBaseUrl = await serverFor(t, (req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push(JSON.parse(body).text);
      res.writeHead(200); res.end('{}');
    });
  });

  const notifier = new TelegramNotifierService({ botToken: 't', chatId: '1', apiBaseUrl, minIntervalMs: 5 });
  notifier.notify('x'.repeat(5000));
  await notifier.flush();

  assert.ok(received[0].length <= 4001);
  assert.ok(received[0].endsWith('…'));
});
