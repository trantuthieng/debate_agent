const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const { ModelLoadLock } = require('../../out/ollama/ModelLoadLock');

function tmpLockDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'model-load-lock-test-'));
}

test('acquire() grants the lock immediately when nothing else holds it', async () => {
  const lock = new ModelLoadLock('http://local.test', { lockDir: tmpLockDir() });
  const release = await lock.acquire('m1');
  assert.equal(typeof release, 'function');
  release();
});

test('two instances against the same baseUrl serialize: the second only proceeds after the first releases', async () => {
  const lockDir = tmpLockDir();
  const lockA = new ModelLoadLock('http://local.test', { lockDir, pollMs: 10 });
  const lockB = new ModelLoadLock('http://local.test', { lockDir, pollMs: 10 });

  const releaseA = await lockA.acquire('m1');
  let bAcquired = false;
  const bPromise = lockB.acquire('m2').then(release => { bAcquired = true; return release; });

  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(bAcquired, false, 'B must wait while A holds the lock');

  releaseA();
  const releaseB = await bPromise;
  assert.equal(bAcquired, true);
  releaseB();
});

test('different baseUrls never contend — each gets its own lock file', async () => {
  const lockDir = tmpLockDir();
  const lockA = new ModelLoadLock('http://host-a:11434', { lockDir, pollMs: 10 });
  const lockB = new ModelLoadLock('http://host-b:11434', { lockDir, pollMs: 10 });
  const releaseA = await lockA.acquire('m1');
  const releaseB = await lockB.acquire('m2'); // must not block on A's lock
  releaseA();
  releaseB();
});

test('a lock left by a dead pid is reclaimed immediately, not waited out', async () => {
  const lockDir = tmpLockDir();
  const lock = new ModelLoadLock('http://local.test', { lockDir, pollMs: 10, staleMs: 20 * 60_000 });
  // Manually plant a lock file "owned" by a pid that is guaranteed dead.
  const deadPid = cp.spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid || 999999;
  const hash = require('node:crypto').createHash('sha1').update('http://local.test').digest('hex');
  fs.writeFileSync(path.join(lockDir, `${hash}.lock`), JSON.stringify({ pid: deadPid, model: 'stale-model', acquiredAt: Date.now() }));

  const start = Date.now();
  const release = await lock.acquire('m1');
  assert.ok(Date.now() - start < 2_000, 'a dead-pid lock must be reclaimed immediately, not polled for the full staleMs window');
  release();
});

test('a live PID is never reclaimed by age; timeout throws without ownership', async () => {
  const lockDir = tmpLockDir();
  const hash = require('node:crypto').createHash('sha1').update('http://local.test').digest('hex');
  const lockFile = path.join(lockDir, `${hash}.lock`);
  const payload = JSON.stringify({ pid: process.pid, model: 'ancient', acquiredAt: 1 });
  fs.writeFileSync(lockFile, payload);
  const lock = new ModelLoadLock('http://local.test', { lockDir, pollMs: 5, staleMs: 1, timeoutMs: 30 });
  await assert.rejects(lock.acquire('m1'), /timed out/);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), payload);
});

test('shouldAbort stops the wait and throws UserAbortError instead of hanging', async () => {
  const { UserAbortError } = require('../../out/utils/errors');
  const lockDir = tmpLockDir();
  const lockA = new ModelLoadLock('http://local.test', { lockDir, pollMs: 10 });
  const lockB = new ModelLoadLock('http://local.test', { lockDir, pollMs: 10 });
  const releaseA = await lockA.acquire('m1');
  let aborted = false;
  setTimeout(() => { aborted = true; }, 30);
  await assert.rejects(
    lockB.acquire('m2', () => aborted),
    UserAbortError
  );
  releaseA();
});

test('a stale release never removes a newer token in the same PID', async () => {
  const lockDir = tmpLockDir();
  const hash = require('node:crypto').createHash('sha1').update('http://local.test').digest('hex');
  const lockFile = path.join(lockDir, `${hash}.lock`);
  const lock = new ModelLoadLock('http://local.test', { lockDir, pollMs: 5 });
  const release = await lock.acquire('m1');
  release();
  const releaseOther = await lock.acquire('m2');
  const newer = fs.readFileSync(lockFile, 'utf8');
  release();
  assert.equal(fs.readFileSync(lockFile, 'utf8'), newer);
  releaseOther();
});

test('filesystem failures never grant an unlocked model operation', async () => {
  const dir = tmpLockDir();
  const badDir = path.join(dir, 'not-a-directory');
  fs.writeFileSync(badDir, 'file');
  await assert.rejects(new ModelLoadLock('http://local.test', { lockDir: badDir }).acquire('m1'), /EEXIST|ENOTDIR/);
});

test('partial lock JSON fails closed and remains untouched', async () => {
  const lockDir = tmpLockDir();
  const hash = require('node:crypto').createHash('sha1').update('http://local.test').digest('hex');
  const lockFile = path.join(lockDir, `${hash}.lock`);
  fs.writeFileSync(lockFile, '{"pid":');
  await assert.rejects(new ModelLoadLock('http://local.test', { lockDir }).acquire('m1'), /corrupt/);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), '{"pid":');
});

test('loopback aliases, default ports and trailing slashes share ownership', async () => {
  const lockDir = tmpLockDir();
  const first = new ModelLoadLock('http://localhost:11434/', { lockDir });
  const release = await first.acquire('m1');
  try {
    for (const url of ['http://127.0.0.1:11434', 'http://[::1]:11434/', 'http://LOCALHOST.:11434///']) {
      await assert.rejects(new ModelLoadLock(url, { lockDir, timeoutMs: 10, pollMs: 2 }).acquire('m2'), /timed out/);
    }
    const anotherPort = await new ModelLoadLock('http://localhost:11435', { lockDir }).acquire('m3');
    anotherPort();
  } finally { release(); }
  const defaultPort = await new ModelLoadLock('http://localhost:80/', { lockDir }).acquire('m4');
  await assert.rejects(new ModelLoadLock('http://127.0.0.1', { lockDir, timeoutMs: 10, pollMs: 2 }).acquire('m5'), /timed out/);
  defaultPort();
});

test('model lock retries failed release through the exact retired token', async () => {
  const lockDir = tmpLockDir();
  const lock = new ModelLoadLock('http://local.test', { lockDir, timeoutMs: 30, pollMs: 2 });
  const release = await lock.acquire('m1');
  const lockFile = path.join(lockDir, fs.readdirSync(lockDir).find(file => file.endsWith('.lock')));
  const unlink = fs.unlinkSync;
  fs.unlinkSync = function (file, ...args) {
    if (file === lockFile) { throw Object.assign(new Error('injected release EACCES'), { code: 'EACCES' }); }
    return unlink.call(this, file, ...args);
  };
  try { release(); } finally { fs.unlinkSync = unlink; }
  const other = new ModelLoadLock('http://local.test', { lockDir, timeoutMs: 30, pollMs: 2 });
  const releaseOther = await other.acquire('m2');
  const newer = fs.readFileSync(lockFile, 'utf8');
  release();
  assert.equal(fs.readFileSync(lockFile, 'utf8'), newer);
  releaseOther();
});

test('model acquisition survives deferred guard cleanup while retaining exclusive ownership', async () => {
  const lockDir = tmpLockDir();
  const lock = new ModelLoadLock('http://local.test', { lockDir, timeoutMs: 10, pollMs: 2 });
  const unlink = fs.unlinkSync;
  fs.unlinkSync = function (file, ...args) {
    if (String(file).startsWith(lockDir) && String(file).includes('.guard/')) {
      throw Object.assign(new Error('injected guard EACCES'), { code: 'EACCES' });
    }
    return unlink.call(this, file, ...args);
  };
  let release;
  try { release = await lock.acquire('m1'); } finally { fs.unlinkSync = unlink; }
  await assert.rejects(lock.acquire('m2'), /timed out/);
  release();
  const releaseNext = await lock.acquire('m3');
  releaseNext();
});
