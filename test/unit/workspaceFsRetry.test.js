const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AgentWorkspace } = require('../../out/workspace/AgentWorkspace');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workspace-fsretry-'));
}

function transientError(code) {
  const err = new Error(`${code}: simulated transient filesystem hiccup`);
  err.code = code;
  return err;
}

// Reproduces two real failures from live runs on a cloud-synced (OneDrive)
// workspace volume: a write hit ENOENT/EACCES exactly once, almost certainly
// the sync client briefly locking or not-yet-materializing a path.

test('writeFile recovers from one transient EACCES instead of throwing', t => {
  const root = tempDir();
  const workspace = new AgentWorkspace(root);
  const original = fs.writeFileSync;
  let calls = 0;
  t.mock.method(fs, 'writeFileSync', (...args) => {
    calls += 1;
    if (calls === 1) { throw transientError('EACCES'); }
    return original(...args);
  });
  const target = path.join(root, 'notes', 'note.md');
  workspace.writeFile(target, 'hello');
  assert.equal(calls, 2, 'expected exactly one retry after the transient failure');
  assert.equal(fs.readFileSync(target, 'utf8'), 'hello');
});

test('writeProjectState recovers from one transient ENOENT instead of throwing', t => {
  const root = tempDir();
  const workspace = new AgentWorkspace(root);
  fs.mkdirSync(path.join(root, '.agent-workspace'), { recursive: true });
  const original = fs.writeFileSync;
  let calls = 0;
  t.mock.method(fs, 'writeFileSync', (...args) => {
    calls += 1;
    if (calls === 1) { throw transientError('ENOENT'); }
    return original(...args);
  });
  const state = {
    projectGoal: 'g', status: 'running', currentPhase: 'intake', confirmedByUser: false,
    createdAt: '', updatedAt: '', openQuestions: [], decisions: [], activeTasks: [],
    completedTasks: [], failedTasks: [], currentTaskId: null, fixRetryCount: 0,
  };
  workspace.writeProjectState(state);
  assert.equal(calls, 2);
  assert.equal(workspace.readProjectState().status, 'running');
});

test('a non-transient error is never retried', t => {
  const root = tempDir();
  const workspace = new AgentWorkspace(root);
  let calls = 0;
  t.mock.method(fs, 'writeFileSync', () => {
    calls += 1;
    throw transientError('ENOSPC');
  });
  assert.throws(() => workspace.writeFile(path.join(root, 'x.md'), 'y'), /ENOSPC/);
  assert.equal(calls, 1, 'a non-transient error must not be retried');
});

test('a persistent transient error still gives up after exhausting retries', t => {
  const root = tempDir();
  const workspace = new AgentWorkspace(root);
  let calls = 0;
  t.mock.method(fs, 'writeFileSync', () => {
    calls += 1;
    throw transientError('EACCES');
  });
  assert.throws(() => workspace.writeFile(path.join(root, 'x.md'), 'y'), /EACCES/);
  assert.equal(calls, 3, 'expected exactly 3 attempts (1 initial + 2 retries) before giving up');
});
