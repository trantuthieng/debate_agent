const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { FileManager } = require('../../out/workspace/FileManager');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-symlink-'));
  const root = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'outside original');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, outside, manager: new FileManager(root) };
}

for (const kind of ['parent', 'file', 'dangling']) {
  test(`workspace rejects ${kind} symlinks for read, snapshot, write, append, delete and changes`, t => {
    const { root, outside, manager } = fixture(t);
    const target = kind === 'parent' ? 'linked/keep.txt' : 'linked';
    fs.symlinkSync(kind === 'parent' ? outside : path.join(outside, kind === 'file' ? 'keep.txt' : 'new.txt'), path.join(root, 'linked'));
    for (const operation of [
      () => manager.readWorkspaceFile(target),
      () => manager.getFileSnapshot(target),
      () => manager.fileExists(target),
      () => manager.writeWorkspaceFile(target, 'bad'),
      () => manager.appendWorkspaceFile(target, 'bad'),
      () => manager.deleteWorkspaceFile(target),
    ]) { assert.throws(operation, /symlink/); }
    for (const action of ['create', 'modify', 'append', 'delete']) {
      const result = manager.applyApprovedChanges([{ path: target, action, content: 'bad' }]);
      assert.equal(result.applied, false);
      assert.match(result.error, /symlink/);
    }
    if (kind === 'parent') {
      assert.throws(() => manager.writeWorkspaceFile('linked/new/deep/file.txt', 'bad'), /symlink/);
      assert.throws(() => manager.ensureDirectory(path.join(root, 'linked', 'new')), /symlink/);
      assert.throws(() => manager.listWorkspaceFiles('linked'), /symlink/);
    }
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'outside original');
    assert.deepEqual(fs.readdirSync(outside), ['keep.txt']);
  });
}

test('policy rejects internal symlinks while allowing a selected symlink root and real nested files', t => {
  const { base, root, manager } = fixture(t);
  manager.writeWorkspaceFile('real/nested.txt', 'original');
  fs.symlinkSync('real', path.join(root, 'linked'));
  assert.throws(() => manager.readWorkspaceFile('linked/nested.txt'), /symlink/);
  assert.throws(() => manager.writeWorkspaceFile('linked/nested.txt', 'bad'), /symlink/);
  assert.deepEqual(manager.listWorkspaceFiles(), ['real/nested.txt']);
  const alias = path.join(base, 'alias');
  fs.symlinkSync(root, alias);
  const aliased = new FileManager(alias);
  aliased.writeWorkspaceFile('real/nested.txt', 'updated');
  aliased.appendWorkspaceFile('real/nested.txt', '+append');
  assert.equal(aliased.readWorkspaceFile('real/nested.txt'), 'updated+append');
  assert.equal(aliased.getFileSnapshot('real/nested.txt').size, 14);
  aliased.deleteWorkspaceFile('real/nested.txt');
  assert.equal(aliased.fileExists('real/nested.txt'), false);
});

test('containment uses path segments, including new workspaces and binary writes', t => {
  const { base, root, manager } = fixture(t);
  manager.writeWorkspaceFile('..valid/file.bin', Uint8Array.from([0, 128, 255]));
  assert.deepEqual(fs.readFileSync(path.join(root, '..valid/file.bin')), Buffer.from([0, 128, 255]));
  for (const escape of ['../outside/keep.txt', '..\\outside\\keep.txt', root + '-sibling/keep.txt']) {
    assert.throws(() => manager.writeWorkspaceFile(escape, 'bad'), /outside the workspace/);
  }
  const fresh = new FileManager(path.join(base, 'new', 'root'));
  fresh.writeWorkspaceFile('nested/file.txt', 'created');
  assert.equal(fresh.readWorkspaceFile('nested/file.txt'), 'created');
});

test('patch audit rejects traversal IDs and symlink metadata directories or files', t => {
  const { root, outside, manager } = fixture(t);
  assert.throws(() => manager.savePatch('../escape', 'bad'), /Patch ID/);
  fs.symlinkSync(outside, path.join(root, '.agent-workspace'));
  assert.throws(() => manager.savePatch('audit', 'bad'), /symlink/);
  fs.unlinkSync(path.join(root, '.agent-workspace'));
  const saved = manager.savePatch('audit-1', 'preview');
  assert.equal(fs.readFileSync(saved, 'utf8'), 'preview');
  fs.unlinkSync(saved);
  fs.symlinkSync(path.join(outside, 'keep.txt'), saved);
  assert.throws(() => manager.savePatch('audit-1', 'bad'), /symlink/);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'outside original');
});

test('revalidates parents after directory creation before creating a new file', t => {
  const { root, outside, manager } = fixture(t);
  const original = manager.ensureDirectory.bind(manager);
  manager.ensureDirectory = directory => {
    original(directory);
    fs.rmdirSync(path.join(root, 'new'));
    fs.symlinkSync(outside, path.join(root, 'new'));
  };
  assert.throws(() => manager.writeWorkspaceFile('new/file.txt', 'bad'), /symlink/);
  assert.deepEqual(fs.readdirSync(outside), ['keep.txt']);
});

test('O_NOFOLLOW rejects a final symlink swapped immediately before open', t => {
  const { root, outside, manager } = fixture(t);
  const target = path.join(root, 'file.txt');
  fs.writeFileSync(target, 'inside');
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', function (file, ...args) {
    if (path.resolve(String(file)) === fs.realpathSync(target)) {
      fs.unlinkSync(target);
      fs.symlinkSync(path.join(outside, 'keep.txt'), target);
    }
    return open.call(fs, file, ...args);
  });
  assert.throws(() => manager.writeWorkspaceFile('file.txt', 'bad'), /ELOOP|symlink/);
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'outside original');
});

test('descriptor validation catches a parent swap at open before truncating an existing outside file', t => {
  const { root, outside, manager } = fixture(t);
  fs.mkdirSync(path.join(root, 'dir'));
  fs.writeFileSync(path.join(root, 'dir/keep.txt'), 'inside');
  const open = fs.openSync;
  let switched = false;
  t.mock.method(fs, 'openSync', function (file, ...args) {
    if (!switched && String(file).endsWith('/dir/keep.txt')) {
      switched = true;
      fs.renameSync(path.join(root, 'dir'), path.join(root, 'old-dir'));
      fs.symlinkSync(outside, path.join(root, 'dir'));
    }
    return open.call(fs, file, ...args);
  });
  assert.throws(() => manager.writeWorkspaceFile('dir/keep.txt', 'bad'), /symlink/);
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'outside original');
});

test('root replacement is detected after construction', t => {
  const { base, root, outside, manager } = fixture(t);
  fs.renameSync(root, path.join(base, 'old-workspace'));
  fs.symlinkSync(outside, root);
  assert.throws(() => manager.writeWorkspaceFile('keep.txt', 'bad'), /root changed|symlink/);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'outside original');
});
