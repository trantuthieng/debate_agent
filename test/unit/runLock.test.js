const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const { RunLock } = require('../../out/workspace/RunLock');

function tmpLockPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-lock-test-'));
  return path.join(dir, 'run.lock');
}

test('isStale is true when the lock file has never been written', () => {
  const lock = new RunLock(tmpLockPath());
  assert.equal(lock.isStale(), true);
});

test('a freshly acquired lock (live pid, fresh heartbeat) is not stale', () => {
  const lock = new RunLock(tmpLockPath(), 90_000);
  lock.acquire();
  assert.equal(lock.isStale(), false);
});

test('a lock whose heartbeat is older than the stale threshold is stale, even with a live pid', () => {
  const lockPath = tmpLockPath();
  const lock = new RunLock(lockPath, 50);
  lock.acquire();
  assert.equal(lock.isStale(), false);
  const old = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  old.heartbeatAt = new Date(Date.now() - 5_000).toISOString();
  fs.writeFileSync(lockPath, JSON.stringify(old));
  assert.equal(lock.isStale(), true);
});

test('heartbeat() refreshes the timestamp so an actively running process never looks stale', () => {
  const lockPath = tmpLockPath();
  const lock = new RunLock(lockPath, 50);
  lock.acquire();
  const before = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.heartbeat();
  const after = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.ok(Date.parse(after.heartbeatAt) >= Date.parse(before.heartbeatAt));
  assert.equal(after.startedAt, before.startedAt, 'startedAt must not change on heartbeat');
  assert.equal(lock.isStale(), false);
});

test('a lock owned by a dead pid is stale immediately, regardless of heartbeat freshness', () => {
  const lockPath = tmpLockPath();
  // A pid that is guaranteed not to exist right now.
  const deadPid = cp.spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid || 999999;
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: deadPid, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
  }));
  const lock = new RunLock(lockPath, 90_000);
  assert.equal(lock.isStale(), true);
});

test('a corrupt lock file is treated as stale rather than crashing', () => {
  const lockPath = tmpLockPath();
  fs.writeFileSync(lockPath, '{not json');
  const lock = new RunLock(lockPath);
  assert.equal(lock.isStale(), true);
});

test('release() removes a lock owned by this process', () => {
  const lockPath = tmpLockPath();
  const lock = new RunLock(lockPath);
  lock.acquire();
  assert.ok(fs.existsSync(lockPath));
  lock.release();
  assert.ok(!fs.existsSync(lockPath));
});

test('release() never removes a lock now owned by a different (newer) process', () => {
  const lockPath = tmpLockPath();
  const lock = new RunLock(lockPath);
  lock.acquire();
  // Simulate another process having taken over the lock in the meantime.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid + 1, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }));
  lock.release();
  assert.ok(fs.existsSync(lockPath), 'release() must not delete a lock it no longer owns');
});
