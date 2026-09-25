const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ChatConfigStore, clampChatConfig, DEFAULT_CHAT_CONFIG, MAX_ROUNDS } = require('../../out/server/chatConfig');
const { MIN_QA_AGENTS, MAX_QA_AGENTS } = require('../../out/prompts/qaPersonas');

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chat-config-test-'));
}

test('read() returns defaults when no config file exists yet', () => {
  const store = new ChatConfigStore(tmpDataDir());
  assert.deepEqual(store.read(), DEFAULT_CHAT_CONFIG);
});

test('write() then read() round-trips exactly', () => {
  const store = new ChatConfigStore(tmpDataDir());
  const written = store.write({ rounds: 4, agentCount: 6, webSearchEnabled: false });
  assert.deepEqual(written, { rounds: 4, agentCount: 6, webSearchEnabled: false });
  assert.deepEqual(store.read(), written);
});

test('write() merges a partial update onto the existing config instead of resetting it', () => {
  const store = new ChatConfigStore(tmpDataDir());
  store.write({ rounds: 3, agentCount: 5, webSearchEnabled: true });
  const merged = store.write({ agentCount: 8 });
  assert.deepEqual(merged, { rounds: 3, agentCount: 8, webSearchEnabled: true });
});

test('clampChatConfig clamps rounds to [1, MAX_ROUNDS] and agentCount to [MIN_QA_AGENTS, MAX_QA_AGENTS]', () => {
  assert.equal(clampChatConfig({ rounds: 0 }).rounds, 1);
  assert.equal(clampChatConfig({ rounds: 999 }).rounds, MAX_ROUNDS);
  assert.equal(clampChatConfig({ agentCount: 0 }).agentCount, MIN_QA_AGENTS);
  assert.equal(clampChatConfig({ agentCount: 999 }).agentCount, MAX_QA_AGENTS);
});

test('clampChatConfig falls back to defaults for non-finite or missing values, not NaN/undefined', () => {
  const result = clampChatConfig({ rounds: Number.NaN, agentCount: undefined, webSearchEnabled: undefined });
  assert.deepEqual(result, DEFAULT_CHAT_CONFIG);
});

test('a corrupt config file on disk is treated as "use defaults", not a crash', () => {
  const dataDir = tmpDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'chat_config.json'), '{not json');
  const store = new ChatConfigStore(dataDir);
  assert.deepEqual(store.read(), DEFAULT_CHAT_CONFIG);
});

test('write() creates the data directory if it does not exist yet', () => {
  const dataDir = path.join(tmpDataDir(), 'nested', 'deep');
  const store = new ChatConfigStore(dataDir);
  const written = store.write({ rounds: 2 });
  assert.equal(fs.existsSync(path.join(dataDir, 'chat_config.json')), true);
  assert.equal(written.rounds, 2);
});
