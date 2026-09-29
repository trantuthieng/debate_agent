const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { withFileLockMutation } = require('../../out/utils/fileLockMutation');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-mutation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'run.lock');
}

test('mutation guard recovers a dead owner without exposing partial ownership', t => {
  const lockPath = fixture(t);
  const deadPid = cp.spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  const guard = `${lockPath}.guard`;
  fs.mkdirSync(guard);
  fs.writeFileSync(path.join(guard, `${deadPid}-${'a'.repeat(32)}`), '');
  const result = withFileLockMutation(lockPath, () => 42);
  assert.deepEqual(result, { acquired: true, value: 42 });
  assert.equal(fs.existsSync(guard), false);
});

test('mutation guard treats a live or unknown owner as busy', t => {
  const lockPath = fixture(t);
  const guard = `${lockPath}.guard`;
  fs.mkdirSync(guard);
  const marker = path.join(guard, `${process.pid}-${'b'.repeat(32)}`);
  fs.writeFileSync(marker, '');
  assert.deepEqual(withFileLockMutation(lockPath, () => assert.fail('must not enter')), { acquired: false });
  fs.renameSync(marker, path.join(guard, 'unrecognized'));
  assert.deepEqual(withFileLockMutation(lockPath, () => assert.fail('must not enter')), { acquired: false });
});

const childScript = `
const fs = require('node:fs');
const path = require('node:path');
const { RunLock } = require(process.argv[1] + '/workspace/RunLock');
const { ModelLoadLock } = require(process.argv[1] + '/ollama/ModelLoadLock');
const target = process.argv[2];
const kind = process.argv[3];
let release;
process.on('message', async msg => {
  if (msg === 'release') { if (release) release(); process.exit(0); }
  if (msg !== 'go') return;
  try {
    if (kind === 'run') {
      const lock = new RunLock(target); lock.acquire(); release = () => lock.release();
      process.send({ result: 'acquired' });
    } else {
      const endpoint = process.pid % 2 ? 'http://localhost:11434/' : 'http://127.0.0.1:11434';
      const lock = new ModelLoadLock(endpoint, { lockDir: path.dirname(target), pollMs: 2, timeoutMs: 10000 });
      release = await lock.acquire('fixture');
      const occupied = target + '.occupied';
      fs.writeFileSync(occupied, String(process.pid), { flag: 'wx' });
      await new Promise(resolve => setTimeout(resolve, 10));
      fs.unlinkSync(occupied); release(); release = undefined;
      process.send({ result: 'acquired' });
    }
  } catch (error) { process.send({ result: 'rejected', error: error.message }); }
});
process.send({ ready: true });
`;

async function contend(t, lockPath, kind) {
  const children = Array.from({ length: 8 }, () => cp.spawn(process.execPath,
    ['-e', childScript, path.resolve(__dirname, '../../out'), lockPath, kind],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  t.after(() => children.forEach(child => child.kill()));
  const reports = children.map(child => new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('message', msg => { if (msg.result) resolve(msg); });
    child.on('exit', code => { if (code !== 0) reject(new Error(`Lock contender exited: ${code}`)); });
  }));
  await Promise.all(children.map(child => new Promise(resolve => {
    child.on('message', msg => { if (msg.ready) resolve(); });
  })));
  children.forEach(child => child.send('go'));
  const results = await Promise.all(reports);
  await Promise.all(children.map(child => new Promise(resolve => {
    child.once('exit', resolve);
    child.send('release');
  })));
  return results;
}

test('parallel processes claim an empty workspace exactly once', { timeout: 15000 }, async t => {
  const lockPath = fixture(t);
  const results = await contend(t, lockPath, 'run');
  assert.equal(results.filter(result => result.result === 'acquired').length, 1, JSON.stringify(results));
});

test('parallel stale-lock reclaimers cannot overwrite the winning owner', { timeout: 15000 }, async t => {
  const lockPath = fixture(t);
  const deadPid = cp.spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, heartbeatAt: '2000-01-01', startedAt: '2000-01-01' }));
  const results = await contend(t, lockPath, 'run');
  assert.equal(results.filter(result => result.result === 'acquired').length, 1, JSON.stringify(results));
});

test('parallel model processes and loopback aliases never overlap inference', { timeout: 15000 }, async t => {
  const lockPath = fixture(t);
  const results = await contend(t, lockPath, 'model');
  assert.equal(results.filter(result => result.result === 'acquired').length, 8, JSON.stringify(results));
});

test('delayed stale-guard cleanup cannot remove a replacement owner', t => {
  const lockPath = fixture(t);
  const deadPid = cp.spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  const guard = `${lockPath}.guard`;
  fs.mkdirSync(guard);
  fs.writeFileSync(path.join(guard, `${deadPid}-${'c'.repeat(32)}`), '');
  const replacementMarker = path.join(guard, `${process.pid}-${'d'.repeat(32)}`);
  const originalRmdir = fs.rmdirSync;
  let replaced = false;
  fs.rmdirSync = function (target, ...args) {
    if (target === guard && !replaced) {
      replaced = true;
      // Another contender has atomically published a nonempty replacement
      // after the dead marker was removed, but before this rmdir executes.
      fs.writeFileSync(replacementMarker, '');
    }
    return originalRmdir.call(this, target, ...args);
  };
  try {
    assert.deepEqual(withFileLockMutation(lockPath, () => assert.fail('replacement owns the guard')), { acquired: false });
    assert.equal(fs.existsSync(replacementMarker), true);
  } finally { fs.rmdirSync = originalRmdir; }
});

test('parallel model reclaimers recover a dead payload and dead guard safely', { timeout: 15000 }, async t => {
  const lockPath = fixture(t);
  const deadPid = cp.spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  const key = require('node:crypto').createHash('sha1').update('http://127.0.0.1:11434').digest('hex');
  const modelPath = path.join(path.dirname(lockPath), `${key}.lock`);
  fs.writeFileSync(modelPath, JSON.stringify({ pid: deadPid, acquiredAt: 1, model: 'crashed' }));
  fs.mkdirSync(`${modelPath}.guard`);
  fs.writeFileSync(path.join(`${modelPath}.guard`, `${deadPid}-${'e'.repeat(32)}`), '');
  const results = await contend(t, lockPath, 'model');
  assert.equal(results.filter(result => result.result === 'acquired').length, 8, JSON.stringify(results));
});

test('failed guard cleanup preserves the original callback error and retries after recovery', t => {
  const lockPath = fixture(t);
  const unlink = fs.unlinkSync;
  fs.unlinkSync = function (file, ...args) {
    if (String(file).startsWith(`${lockPath}.guard/`)) {
      throw Object.assign(new Error('injected cleanup EACCES'), { code: 'EACCES' });
    }
    return unlink.call(this, file, ...args);
  };
  try {
    assert.throws(() => withFileLockMutation(lockPath, () => { throw new Error('original callback error'); }), /original callback error/);
  } finally { fs.unlinkSync = unlink; }
  assert.deepEqual(withFileLockMutation(lockPath, () => 42), { acquired: true, value: 42 });
});

test('retired guard retry cannot remove an unrecognized replacement in the same PID', t => {
  const lockPath = fixture(t);
  const guard = `${lockPath}.guard`;
  const unlink = fs.unlinkSync;
  fs.unlinkSync = function (file, ...args) {
    if (String(file).startsWith(`${guard}/`)) {
      throw Object.assign(new Error('injected cleanup EACCES'), { code: 'EACCES' });
    }
    return unlink.call(this, file, ...args);
  };
  try { withFileLockMutation(lockPath, () => 42); } finally { fs.unlinkSync = unlink; }
  for (const marker of fs.readdirSync(guard)) { fs.unlinkSync(path.join(guard, marker)); }
  const replacement = path.join(guard, `${process.pid}-${'f'.repeat(32)}`);
  fs.writeFileSync(replacement, '');
  assert.deepEqual(withFileLockMutation(lockPath, () => assert.fail('replacement owns guard')), { acquired: false });
  assert.equal(fs.existsSync(replacement), true);
});

test('a currently executing callback is never mistaken for retired local guard ownership', t => {
  const lockPath = fixture(t);
  withFileLockMutation(lockPath, () => {
    assert.deepEqual(withFileLockMutation(lockPath, () => assert.fail('nested claim')), { acquired: false });
  });
  assert.deepEqual(withFileLockMutation(lockPath, () => 42), { acquired: true, value: 42 });
});

test('recovery registries stay bounded without evicting known retired capabilities and drain after recovery', t => {
  const { retireLockToken, forgetRetiredLockToken, isRetiredLockToken } = require('../../out/utils/fileLockMutation');
  const lockPath = fixture(t);
  const tokens = Array.from({ length: 300 }, (_, i) => `retired-${i}`);
  try {
    tokens.forEach(token => retireLockToken(lockPath, token));
    const remembered = tokens.filter(token => isRetiredLockToken(lockPath, { pid: process.pid, token }));
    assert.ok(remembered.length > 0 && remembered.length < tokens.length, 'registry has a finite capacity');
    assert.equal(remembered[0], tokens[0], 'capacity must never evict older recovery evidence');
  } finally { tokens.forEach(token => forgetRetiredLockToken(lockPath, token)); }
  retireLockToken(lockPath, 'after-drain');
  assert.equal(isRetiredLockToken(lockPath, { pid: process.pid, token: 'after-drain' }), true);
  forgetRetiredLockToken(lockPath, 'after-drain');

  const unlink = fs.unlinkSync;
  fs.unlinkSync = function (file, ...args) {
    if (String(file).startsWith(path.dirname(lockPath)) && String(file).includes('.guard/')) {
      throw Object.assign(new Error('injected persistent cleanup EACCES'), { code: 'EACCES' });
    }
    return unlink.call(this, file, ...args);
  };
  let completed = 0;
  try {
    assert.throws(() => {
      for (let i = 0; i < 300; i++) {
        withFileLockMutation(`${lockPath}-${i}`, () => { completed++; });
      }
    }, /capacity exhausted/);
    assert.ok(completed > 0 && completed < 300);
  } finally { fs.unlinkSync = unlink; }
  assert.deepEqual(withFileLockMutation(lockPath, () => 42), { acquired: true, value: 42 });
  assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), [], 'successful retry drains all retired marker directories');
});
