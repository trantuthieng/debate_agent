const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ConnectorJobQueue } = require('../../out/connectors/ConnectorJobQueue');
const { ConnectorManager } = require('../../out/connectors/ConnectorManager');
const { YouTubeConnector } = require('../../out/connectors/youtube/YouTubeConnector');
const { AutonomousToolRegistry } = require('../../out/tools/AutonomousToolRegistry');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-connectors-'));
}

const context = {
  approvedScopes: ['scope:write'],
  publishPolicy: 'draft-only',
  requestedBy: 'boss',
  decidedByAgent: 'operator',
};

test('connector queue de-duplicates jobs and records successful audited execution', async () => {
  const root = tempDir();
  const queue = new ConnectorJobQueue(root);
  const first = queue.enqueue({ connectorId: 'demo', action: 'write', payload: { value: 1 }, idempotencyKey: 'same' });
  const duplicate = queue.enqueue({ connectorId: 'demo', action: 'write', payload: { value: 2 }, idempotencyKey: 'same' });
  assert.equal(first.id, duplicate.id);
  const connector = {
    id: 'demo', capabilities: ['write'],
    execute: async () => ({ success: true, externalId: 'external-1', output: { ok: true } }),
  };
  const completed = await queue.runNext(new Map([['demo', connector]]), context);
  assert.equal(completed.status, 'completed');
  const audit = fs.readFileSync(path.join(root, 'connectors', 'audit.jsonl'), 'utf8');
  assert.match(audit, /external-1/);
  assert.doesNotMatch(audit, /accessToken|refreshToken/);
});

test('connector queue retries with bounded attempts and never duplicates side effects', async () => {
  const queue = new ConnectorJobQueue(tempDir());
  queue.enqueue({ connectorId: 'demo', action: 'write', payload: {}, idempotencyKey: 'retry', maxAttempts: 2 });
  const connector = { id: 'demo', capabilities: ['write'], execute: async () => { throw new Error('temporary'); } };
  const registry = new Map([['demo', connector]]);
  assert.equal((await queue.runNext(registry, context)).status, 'retrying');
  assert.equal((await queue.runNext(registry, context)).status, 'failed');
  assert.equal(queue.list().length, 1);
});

test('YouTube connector blocks scheduling under draft-only policy before any network call', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'video.mp4'), 'video');
  let networkCalled = false;
  const vault = { get: async () => undefined, store: async () => {}, delete: async () => {} };
  const connector = new YouTubeConnector(vault, root, async () => { networkCalled = true; throw new Error('unexpected'); });
  await assert.rejects(
    () => connector.execute('schedule', {
      videoPath: 'video.mp4', title: 'Relax', musicRightsConfirmed: true,
      publishAt: '2030-01-01T00:00:00Z',
    }, {
      approvedScopes: ['https://www.googleapis.com/auth/youtube.upload'],
      publishPolicy: 'draft-only', requestedBy: 'boss', decidedByAgent: 'operator',
    }),
    /draft-only policy/i
  );
  assert.equal(networkCalled, false);
});

test('YouTube connector requires explicit music-rights confirmation', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'video.mp4'), 'video');
  const vault = { get: async () => undefined, store: async () => {}, delete: async () => {} };
  const connector = new YouTubeConnector(vault, root, async () => { throw new Error('network should not run'); });
  await assert.rejects(
    () => connector.execute('upload-draft', { videoPath: 'video.mp4', title: 'Relax' }, {
      approvedScopes: ['https://www.googleapis.com/auth/youtube.upload'],
      publishPolicy: 'draft-only', requestedBy: 'boss', decidedByAgent: 'operator',
    }),
    /musicRightsConfirmed/i
  );
});

test('autonomous tool registry exposes connector tools and delegates through the controlled executor', async () => {
  const calls = [];
  const registry = new AutonomousToolRegistry(
    null, null, null, null, null, undefined, undefined,
    { executeTool: async (name, args, agent) => { calls.push({ name, args, agent }); return '{"status":"completed"}'; } }
  );
  assert.ok(registry.definitions().some(tool => tool.name === 'youtube_upload_draft'));
  const result = await registry.execute({
    id: 'builder-job', name: 'youtube_status', args: { videoId: 'abc' },
  });
  assert.equal(result.success, true);
  assert.deepEqual(calls, [{ name: 'youtube_status', args: { videoId: 'abc' }, agent: 'builder-job' }]);
});

test('connector manager refuses autonomous actions until one-time scope approval exists', async () => {
  const values = new Map();
  const vault = {
    get: async key => values.get(key),
    store: async (key, value) => values.set(key, value),
    delete: async key => values.delete(key),
  };
  const manager = new ConnectorManager(vault, tempDir());
  await assert.rejects(
    () => manager.executeTool('youtube_status', { videoId: 'abc' }, 'verifier'),
    /has not been approved/i
  );
});
