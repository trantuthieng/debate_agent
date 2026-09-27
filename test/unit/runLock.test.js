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

test('a live PID remains owner even when its heartbeat is old', () => {
  const lockPath = tmpLockPath();
  const lock = new RunLock(lockPath, 50);
  lock.acquire();
  assert.equal(lock.isStale(), false);
  const old = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  old.heartbeatAt = new Date(Date.now() - 5_000).toISOString();
  fs.writeFileSync(lockPath, JSON.stringify(old));
  assert.equal(lock.isStale(), false);
  assert.throws(() => new RunLock(lockPath).acquire(), /already held/);
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

test('a corrupt lock fails closed because ownership is unknown', () => {
  const lockPath = tmpLockPath();
  fs.writeFileSync(lockPath, '{not json');
  const lock = new RunLock(lockPath);
  assert.equal(lock.isStale(), false);
  assert.throws(() => lock.acquire(), /corrupt/);
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


test('two lock instances in the same PID cannot claim the same workspace', () => {
  const lockPath = tmpLockPath();
  const first = new RunLock(lockPath);
  first.acquire();
  const token = JSON.parse(fs.readFileSync(lockPath, 'utf8')).token;
  const second = new RunLock(lockPath);
  assert.throws(() => second.acquire(), /already held/);
  second.heartbeat();
  second.release();
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, token);
  first.release();
});

test('stale owner callbacks cannot overwrite or delete a new token in the same PID', () => {
  const lockPath = tmpLockPath();
  const first = new RunLock(lockPath);
  first.acquire();
  first.release();
  const second = new RunLock(lockPath);
  second.acquire();
  const before = fs.readFileSync(lockPath, 'utf8');
  first.heartbeat();
  first.release();
  assert.equal(fs.readFileSync(lockPath, 'utf8'), before);
  second.release();
  first.heartbeat();
  assert.equal(fs.existsSync(lockPath), false, 'heartbeat must never recreate a released lock');
});

test('lock acquisition and stale inspection fail closed on filesystem errors', () => {
  const lockPath = tmpLockPath();
  fs.mkdirSync(lockPath);
  const lock = new RunLock(lockPath);
  assert.throws(() => lock.acquire(), /EISDIR/);
  assert.equal(lock.isStale(), false);
});

test('a finished owner recovers failed unlink by its exact retired token, including from another instance', () => {
  const lockPath = tmpLockPath();
  const first = new RunLock(lockPath);
  first.acquire();
  const before = fs.readFileSync(lockPath, 'utf8');
  const unlink = fs.unlinkSync;
  fs.unlinkSync = function (file, ...args) {
    if (file === lockPath) { throw Object.assign(new Error('injected release EACCES'), { code: 'EACCES' }); }
    return unlink.call(this, file, ...args);
  };
  try { first.release(); } finally { fs.unlinkSync = unlink; }
  first.heartbeat();
  assert.equal(fs.readFileSync(lockPath, 'utf8'), before, 'retired heartbeat must remain inactive');
  assert.equal(first.isStale(), true, 'explicit retirement proves this exact owner ended');
  const second = new RunLock(lockPath);
  second.acquire();
  const newer = fs.readFileSync(lockPath, 'utf8');
  first.release();
  assert.equal(fs.readFileSync(lockPath, 'utf8'), newer, 'old cleanup cannot remove a replacement');
  second.release();
});

test('guard cleanup failure preserves acquisition and does not permit a second live owner', () => {
  const lockPath = tmpLockPath();
  const first = new RunLock(lockPath);
  const unlink = fs.unlinkSync;
  fs.unlinkSync = function (file, ...args) {
    if (String(file).startsWith(`${lockPath}.guard/`)) {
      throw Object.assign(new Error('injected guard EACCES'), { code: 'EACCES' });
    }
    return unlink.call(this, file, ...args);
  };
  try { assert.doesNotThrow(() => first.acquire()); } finally { fs.unlinkSync = unlink; }
  const second = new RunLock(lockPath);
  assert.throws(() => second.acquire(), /already held/);
  first.release();
  second.acquire();
  second.release();
});

test('retired token does not authorize recovery of a corrupt or unrecognized owner', () => {
  const lockPath = tmpLockPath();
  const first = new RunLock(lockPath);
  first.acquire();
  const unlink = fs.unlinkSync;
  fs.unlinkSync = function (file, ...args) {
    if (file === lockPath) { throw Object.assign(new Error('injected release EACCES'), { code: 'EACCES' }); }
    return unlink.call(this, file, ...args);
  };
  try { first.release(); } finally { fs.unlinkSync = unlink; }
  fs.writeFileSync(lockPath, '{invalid');
  const other = new RunLock(lockPath);
  assert.equal(other.isStale(), false);
  assert.throws(() => other.acquire(), /corrupt/);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'unrecognized-owner' }));
  assert.throws(() => other.acquire(), /already held/);
  first.release(); // forget the retired token after observing its replacement
});
