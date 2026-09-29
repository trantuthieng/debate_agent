const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeFileAtomic, withFsRetry } = require('../../out/utils/atomicFile');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-file-test-'));
}

test('writeFileAtomic creates the file with the given content', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'checkpoint.json');
  writeFileAtomic(target, '{"a":1}');
  assert.equal(fs.readFileSync(target, 'utf8'), '{"a":1}');
});

test('writeFileAtomic leaves no stray temp file behind on success', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'checkpoint.json');
  writeFileAtomic(target, 'v1');
  writeFileAtomic(target, 'v2');
  const entries = fs.readdirSync(dir);
  assert.deepEqual(entries, ['checkpoint.json']);
  assert.equal(fs.readFileSync(target, 'utf8'), 'v2');
});

test('writeFileAtomic creates parent directories as needed', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'nested', 'deep', 'checkpoint.json');
  writeFileAtomic(target, 'content');
  assert.equal(fs.readFileSync(target, 'utf8'), 'content');
});

test('a stray leftover temp file from a killed process never corrupts the previous good version', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'checkpoint.json');
  writeFileAtomic(target, 'good version');
  // Simulate a crash between the temp write and the rename: a half-written
  // sibling temp file is left behind, but the real target must be untouched.
  fs.writeFileSync(path.join(dir, '.checkpoint.json.tmp-99999-deadbeef'), '{"tor');
  assert.equal(fs.readFileSync(target, 'utf8'), 'good version');
  // A later write still succeeds and does not collide with the stray temp file.
  writeFileAtomic(target, 'newer version');
  assert.equal(fs.readFileSync(target, 'utf8'), 'newer version');
});

test('writeFileAtomic cleans up its own temp file if the write itself throws', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'checkpoint.json');
  // Pass a value renameSync/writeFileSync cannot serialize as utf8 text is not
  // representative; instead force a failure by pointing at a directory path
  // that collides with the temp file name pattern — simplest is to make the
  // target's parent read-only-ish via an invalid nested path segment.
  const collidingDir = path.join(dir, 'checkpoint.json'); // a directory sharing the target's name
  fs.mkdirSync(collidingDir);
  assert.throws(() => writeFileAtomic(target, 'x'));
  // No leftover temp files despite the failure.
  const strays = fs.readdirSync(dir).filter(name => name.includes('.tmp-'));
  assert.deepEqual(strays, []);
});

test('withFsRetry retries a transient error and eventually succeeds', () => {
  let attempts = 0;
  const result = withFsRetry(() => {
    attempts += 1;
    if (attempts < 3) {
      const err = new Error('busy');
      err.code = 'EBUSY';
      throw err;
    }
    return 'ok';
  }, 5, 1);
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('withFsRetry does not retry a non-transient error', () => {
  let attempts = 0;
  assert.throws(() => withFsRetry(() => {
    attempts += 1;
    const err = new Error('nope');
    err.code = 'EISDIR';
    throw err;
  }, 5, 1), /nope/);
  assert.equal(attempts, 1);
});
