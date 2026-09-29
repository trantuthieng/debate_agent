const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { OllamaClient } = require('../../out/ollama/OllamaClient');

const noLock = { acquire: async () => () => {} };

function fakeOllama(answers) {
  const calls = [];
  const transport = async (url, init) => {
    const pathname = new URL(url).pathname;
    calls.push(pathname);
    const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (pathname === '/api/tags') { return json({ models: [{ name: 'm1', size: 1 }, { name: 'm2', size: 1 }] }); }
    if (pathname === '/api/show') { return json({ model_info: {} }); }
    if (pathname === '/api/chat') { return json({ message: { content: answers.shift() } }); }
    return json({});
  };
  return { transport, calls };
}

test('a recorded run replays its model answers without Ollama, in order per model', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-replay-'));
  t.after(() => { delete process.env.DEBATE_MODEL_REPLAY; fs.rmSync(dir, { recursive: true, force: true }); });
  const ask = content => [{ role: 'user', content }];

  const live = fakeOllama(['first', 'second', 'third']);
  const recorder = new OllamaClient('http://ollama.test', path.join(dir, 'ollama_calls.jsonl'), 30_000, 0, live.transport, noLock);
  assert.equal(await recorder.chat('m1', ask('a')), 'first');
  assert.equal(await recorder.chat('m2', ask('b')), 'second');
  assert.equal(await recorder.chat('m1', ask('c')), 'third');
  const recording = path.join(dir, 'model_exchanges.jsonl');
  const entries = fs.readFileSync(recording, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(entries.filter(entry => entry.path === '/api/chat').length, 3);
  assert.ok(entries.every(entry => /^[0-9a-f]{64}$/.test(entry.requestSha256) && !('request' in entry)));

  process.env.DEBATE_MODEL_REPLAY = recording;
  const offline = async () => { throw new Error('Ollama must not be contacted during replay'); };
  const replay = new OllamaClient('http://ollama.test', path.join(dir, 'replay', 'ollama_calls.jsonl'), 30_000, 0, offline, noLock);
  assert.equal(await replay.chat('m1', ask('changed prompt')), 'first');   // diverged: next in order
  assert.equal(await replay.chat('m2', ask('b')), 'second');               // identical request
  assert.equal(await replay.chat('m1', ask('c')), 'third');                // identical request
  await assert.rejects(replay.chat('m1', ask('d')), /Model replay exhausted: no recorded POST \/api\/chat for model "m1"/);
  assert.equal(replay.replayStats.diverged, 1);
  assert.equal(replay.replayStats.exhausted, 1);
  assert.ok(replay.replayStats.exactMatches >= 2);
  assert.equal(fs.existsSync(path.join(dir, 'replay', 'model_exchanges.jsonl')), false, 'a replay is not re-recorded');
});

test('metadata probes keep answering after their recorded count is used up', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-replay-meta-'));
  t.after(() => { delete process.env.DEBATE_MODEL_REPLAY; fs.rmSync(dir, { recursive: true, force: true }); });
  const live = fakeOllama([]);
  const recorder = new OllamaClient('http://ollama.test', path.join(dir, 'ollama_calls.jsonl'), 30_000, 0, live.transport, noLock);
  assert.deepEqual(await recorder.listModels(), ['m1', 'm2']);
  process.env.DEBATE_MODEL_REPLAY = path.join(dir, 'model_exchanges.jsonl');
  const replay = new OllamaClient('http://ollama.test', undefined, 30_000, 0, async () => { throw new Error('offline'); }, noLock);
  for (let i = 0; i < 3; i++) { assert.deepEqual(await replay.listModels(), ['m1', 'm2']); }
});
