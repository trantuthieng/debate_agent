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

test('a lock older than staleMs is reclaimed even if the owning pid happens to still be alive', async () => {
  const lockDir = tmpLockDir();
  fs.mkdirSync(lockDir, { recursive: true });
  const hash = require('node:crypto').createHash('sha1').update('http://local.test').digest('hex');
  fs.writeFileSync(path.join(lockDir, `${hash}.lock`), JSON.stringify({ pid: process.pid, model: 'ancient', acquiredAt: Date.now() - 1_000_000 }));

  const lock = new ModelLoadLock('http://local.test', { lockDir, pollMs: 10, staleMs: 10 });
  const start = Date.now();
  const release = await lock.acquire('m1');
  assert.ok(Date.now() - start < 2_000, 'an aged-out lock must be reclaimed even with a live pid');
  release();
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

test('release() only removes the lock if it is still the one this call acquired', async () => {
  const lockDir = tmpLockDir();
  const hash = require('node:crypto').createHash('sha1').update('http://local.test').digest('hex');
  const lockFile = path.join(lockDir, `${hash}.lock`);

  const lock = new ModelLoadLock('http://local.test', { lockDir, pollMs: 10 });
  const release = await lock.acquire('m1');
  // Age the lock (from a future acquirer's point of view) so `other` reclaims
  // it as abandoned, simulating a takeover race before the original release() runs.
  const current = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  fs.writeFileSync(lockFile, JSON.stringify({ ...current, acquiredAt: Date.now() - 1_000_000 }));

  const other = new ModelLoadLock('http://local.test', { lockDir, pollMs: 10, staleMs: 10 });
  const releaseOther = await other.acquire('m2'); // reclaims the "aged" lock
  release(); // stale call from the original acquirer — must be a no-op now
  assert.ok(fs.existsSync(lockFile), 'the newer holder\'s lock must survive the stale release() call');
  releaseOther();
});

test('proceeds without the lock (rather than hanging forever) once timeoutMs is exceeded', async () => {
  const lockDir = tmpLockDir();
  const lockA = new ModelLoadLock('http://local.test', { lockDir, pollMs: 10, staleMs: 10 * 60_000 });
  const lockB = new ModelLoadLock('http://local.test', { lockDir, pollMs: 10, timeoutMs: 50 });
  const releaseA = await lockA.acquire('m1');
  const release = await lockB.acquire('m2'); // should give up waiting after ~50ms and proceed
  assert.equal(typeof release, 'function');
  release();
  releaseA();
});
