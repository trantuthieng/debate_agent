const assert = require('node:assert/strict');
const test = require('node:test');
const { OllamaClient } = require('../../out/ollama/OllamaClient');
const { AgentWorkspace } = require('../../out/workspace/AgentWorkspace');
const { UserAbortError } = require('../../out/utils/errors');

function mockOllama(t, onGenerate = body => ({ message: { content: body.format ? '{"ok":true}' : 'READY' } })) {
  const requests = [];
  t.mock.method(global, 'fetch', async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url, body });
    if (url.endsWith('/api/tags')) {
      return Response.json({ models: ['primary:latest', 'fallback:latest'].map(name => ({ name, size: 9 * 1024 ** 3, digest: name })) });
    }
    if (url.endsWith('/api/show')) {
      return Response.json({ capabilities: ['completion'], model_info: { 'general.architecture': 'test', 'test.context_length': 4096 } });
    }
    if (body.messages.length === 0) { return Response.json({ done: true }); }
    const output = await onGenerate(body, init);
    return output instanceof Response ? output : Response.json(output);
  });
  return requests;
}

test('switching sequential models releases old weights using an empty-message unload', async t => {
  const requests = mockOllama(t);
  const client = new OllamaClient('http://local.test', undefined, 300000, 30, (url, init) => fetch(url, init));
  const messages = [{ role: 'user', content: 'test' }];
  await client.chat('primary', messages);
  await client.chat('primary:latest', messages);
  await client.chat('fallback', messages);
  const chat = requests.filter(request => request.url.endsWith('/api/chat')).map(request => request.body);
  assert.deepEqual(chat.map(body => [body.model, body.messages.length]), [
    ['primary', 1], ['primary:latest', 1], ['primary:latest', 0], ['fallback', 1],
  ]);
  assert.equal(chat[2].keep_alive, 0);
});

test('a failed primary is unloaded before a fallback starts generating', async t => {
  const requests = mockOllama(t, body => body.model === 'primary'
    ? Response.json({ error: 'runner terminated' }, { status: 500 })
    : { message: { content: 'recovered' } });
  const client = new OllamaClient('http://local.test', undefined, 300000, 30, (url, init) => fetch(url, init));
  assert.equal(await client.callWithFallback('primary', 'fallback', [{ role: 'user', content: 'test' }]), 'recovered');
  const chat = requests.filter(request => request.url.endsWith('/api/chat')).map(request => request.body);
  assert.deepEqual(chat.map(body => [body.model, body.messages.length]), [['primary', 1], ['primary', 0], ['fallback', 1]]);
});

test('overlapping coding requests only run one local model generation at a time', async t => {
  let releaseFirst;
  let markStarted;
  const firstReleased = new Promise(resolve => { releaseFirst = resolve; });
  const firstStarted = new Promise(resolve => { markStarted = resolve; });
  let inFlight = 0;
  let maximumInFlight = 0;
  const requests = mockOllama(t, async body => {
    inFlight += 1;
    maximumInFlight = Math.max(maximumInFlight, inFlight);
    if (body.model === 'primary') { markStarted(); await firstReleased; }
    inFlight -= 1;
    return { message: { content: 'READY' } };
  });
  const client = new OllamaClient('http://local.test', undefined, 300000, 30, (url, init) => fetch(url, init));
  const first = client.chat('primary', [{ role: 'user', content: 'task one' }]);
  const second = client.chat('fallback', [{ role: 'user', content: 'task two' }]);
  await firstStarted;
  assert.ok(!requests.some(request => request.body?.model === 'fallback'));
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(maximumInFlight, 1);
  const chat = requests.filter(request => request.url.endsWith('/api/chat')).map(request => request.body);
  assert.deepEqual(chat.map(body => [body.model, body.messages.length]), [['primary', 1], ['primary', 0], ['fallback', 1]]);
});

test('Stop rejects queued generations before they can load a model', async t => {
  let markStarted;
  const firstStarted = new Promise(resolve => { markStarted = resolve; });
  const requests = mockOllama(t, (_body, init) => new Response(new ReadableStream({
    start(controller) {
      init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
      markStarted();
    },
  })));
  const client = new OllamaClient('http://local.test', undefined, 300000, 30, (url, init) => fetch(url, init));
  const first = assert.rejects(client.chat('primary', [{ role: 'user', content: 'one' }]), UserAbortError);
  const second = assert.rejects(client.chat('fallback', [{ role: 'user', content: 'two' }]), UserAbortError);
  await firstStarted;
  client.cancelActiveRequests();
  await Promise.all([first, second]);
  assert.ok(!requests.some(request => request.body?.model === 'fallback'));
});

test('requested context respects native capacity without mutating the callers options', async t => {
  const requests = mockOllama(t);
  const client = new OllamaClient('http://local.test', undefined, 300000, 30, (url, init) => fetch(url, init));
  const options = { temperature: 0.1, num_ctx: 32768, num_predict: 2048 };
  await client.chat('primary', [{ role: 'user', content: 'test' }], 'tester', options);
  const request = requests.find(item => item.url.endsWith('/api/chat'));
  assert.equal(request.body.options.num_ctx, 4096);
  assert.equal(request.body.options.num_predict, 2048);
  assert.equal(options.num_ctx, 32768);
});

test('completed JSON calls do not reload the model just to unload it during a later switch', async t => {
  const requests = mockOllama(t);
  const client = new OllamaClient('http://local.test', undefined, 300000, 30, (url, init) => fetch(url, init));
  await client.chatJson('primary', [{ role: 'user', content: 'test' }]);
  await client.chat('fallback', [{ role: 'user', content: 'test' }]);
  const chat = requests.filter(item => item.url.endsWith('/api/chat')).map(item => item.body);
  assert.equal(chat.length, 2);
  assert.equal(chat[0].keep_alive, 0);
});

test('request deadlines remain active after headers arrive while the response body is stalled', async t => {
  t.mock.method(global, 'fetch', async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
    },
  })));
  const client = new OllamaClient('http://local.test', undefined, 300000, 30, (url, init) => fetch(url, init));
  await assert.rejects(client._fetchWithTimeout('http://local.test/api/chat', {}, 25), /timed out after 25ms/);
});

test('Stop can cancel a response body after HTTP headers have already arrived', async t => {
  let bodyStarted;
  const bodyReady = new Promise(resolve => { bodyStarted = resolve; });
  t.mock.method(global, 'fetch', async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
      bodyStarted();
    },
  })));
  const client = new OllamaClient('http://local.test', undefined, 300000, 30, (url, init) => fetch(url, init));
  const request = client._fetchWithTimeout('http://local.test/api/chat', {}, 10000);
  const rejection = assert.rejects(request, UserAbortError);
  await bodyReady;
  client.cancelActiveRequests();
  await rejection;
});

test('new workspaces default to six stable text models and automatic browser evidence', () => {
  const config = new AgentWorkspace('/a/nonexistent/workspace/for/defaults').readModelConfig();
  const roster = new Set(Object.values(config.agents).flatMap(agent => [agent.model, agent.fallbackModel]));
  assert.ok(roster.size >= 6);
  assert.ok(!roster.has('qwen3-coder:30b'));
  assert.equal(config.agents.brainstorm.model, 'devstral-small-2');
  assert.equal(config.appVerification.browserSmokeTest, true);
  assert.equal(config.resourceGuard.targetFreeGb, 0);
  assert.equal(config.maxDevelopmentSprints, 5);
  assert.equal(config.selfHealing.allowProductTemplates, false);
});

test('per-run settings cannot mutate the defaults used by a later workspace', () => {
  const workspace = new AgentWorkspace('/a/nonexistent/workspace/for/defaults');
  const first = workspace.readModelConfig();
  first.agents.brainstorm.model = 'custom-for-one-run';
  first.defaultOptions.num_ctx = 1024;
  first.appVerification.browserSmokeTest = false;
  const second = workspace.readModelConfig();
  assert.equal(second.agents.brainstorm.model, 'devstral-small-2');
  assert.equal(second.defaultOptions.num_ctx, 32768);
  assert.equal(second.appVerification.browserSmokeTest, true);
});
