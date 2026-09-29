const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AgentWorkspace } = require('../../out/workspace/AgentWorkspace');
const { FileManager } = require('../../out/workspace/FileManager');
const { PatchService } = require('../../out/services/patchService');
const { AssetLibraryService } = require('../../out/services/assetLibraryService');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-guard-integration-'));
  const root = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'original');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, outside };
}
function patch(file) {
  return `--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,1 @@\n-original\n+changed`;
}

test('unified patch headers cannot bypass containment through parent or final symlinks', t => {
  const { root, outside } = fixture(t);
  fs.symlinkSync(outside, path.join(root, 'linked'));
  fs.symlinkSync(path.join(outside, 'keep.txt'), path.join(root, 'linked.txt'));
  fs.writeFileSync(path.join(root, 'safe.txt'), 'original');
  for (const file of ['linked/keep.txt', 'linked.txt', '../outside/keep.txt']) {
    const result = new PatchService(root).applyFileChanges([
      { path: 'safe.txt', action: 'modify', patch: patch('safe.txt') },
      { path: 'innocent.txt', action: 'modify', patch: patch(file) },
    ]);
    assert.equal(result.applied, false);
    assert.match(result.error, /symlink|outside the workspace/);
    assert.equal(fs.readFileSync(path.join(root, 'safe.txt'), 'utf8'), 'original');
  }
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'original');
});

test('metadata initialization rejects a linked .agent-workspace directory', async t => {
  const { root, outside } = fixture(t);
  fs.symlinkSync(outside, path.join(root, '.agent-workspace'));
  await assert.rejects(new AgentWorkspace(root).initialize(), /symlink/);
  assert.deepEqual(fs.readdirSync(outside), ['keep.txt']);
});

test('metadata reads, writes, appends and checkpoint deletes guard symlink paths', async t => {
  const { root, outside } = fixture(t);
  const workspace = new AgentWorkspace(root);
  await workspace.initialize();
  fs.symlinkSync(path.join(outside, 'keep.txt'), workspace.userPromptPath);
  assert.throws(() => workspace.readFile(workspace.userPromptPath), /symlink/);
  assert.throws(() => workspace.writeFile(workspace.userPromptPath, 'bad'), /symlink/);
  assert.throws(() => workspace.appendFile(workspace.userPromptPath, 'bad'), /symlink/);
  fs.symlinkSync(outside, path.join(workspace.agentDir, 'linked'));
  workspace.deleteFile(path.join(workspace.agentDir, 'linked/keep.txt'));
  assert.throws(() => workspace.writeFile(path.join(outside, 'keep.txt'), 'bad'), /outside the workspace/);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'original');
});

test('metadata initialization rejects an existing symlinked configuration file', async t => {
  const { root, outside } = fixture(t);
  fs.mkdirSync(path.join(root, '.agent-workspace'));
  const workspace = new AgentWorkspace(root);
  fs.symlinkSync(path.join(outside, 'keep.txt'), workspace.modelConfigPath);
  await assert.rejects(workspace.initialize(), /symlink/);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'original');
});

test('atomic metadata writes retain the original checkpoint on failed rename and clean temporary files', t => {
  const { root } = fixture(t);
  const workspace = new AgentWorkspace(root);
  workspace.writeFile(workspace.userPromptPath, 'old checkpoint');
  t.mock.method(fs, 'renameSync', () => { const error = new Error('ENOSPC fixture'); error.code = 'ENOSPC'; throw error; });
  assert.throws(() => workspace.writeFile(workspace.userPromptPath, 'new checkpoint'), /ENOSPC/);
  t.mock.restoreAll();
  assert.equal(workspace.readFile(workspace.userPromptPath), 'old checkpoint');
  assert.deepEqual(fs.readdirSync(workspace.agentDir), ['user_prompt.md']);
});

test('atomic writes revalidate a destination replaced by a symlink after staging content', t => {
  const { root, outside } = fixture(t);
  const manager = new FileManager(root);
  manager.writeWorkspaceFile('target.txt', 'inside');
  const original = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (...args) => {
    const result = original(...args);
    fs.unlinkSync(path.join(root, 'target.txt'));
    fs.symlinkSync(path.join(outside, 'keep.txt'), path.join(root, 'target.txt'));
    return result;
  });
  assert.throws(() => manager.writeWorkspaceFileAtomic('target.txt', 'bad'), /symlink/);
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(root), ['target.txt']);
});

const attribution = { title: 'test', creator: 'fixture', license: 'cc0', licenseVersion: '', source: '', foreignLandingUrl: '' };
const imageResponse = () => ({ ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer });
for (const destination of ['directory', 'file', 'manifest']) {
  test(`asset download rejects linked ${destination} before requesting bytes`, async t => {
    const { root, outside } = fixture(t);
    if (destination === 'directory') { fs.symlinkSync(outside, path.join(root, 'assets')); }
    else if (destination === 'file') {
      fs.mkdirSync(path.join(root, 'assets'));
      fs.symlinkSync(path.join(outside, 'keep.txt'), path.join(root, 'assets/image.png'));
    } else { fs.symlinkSync(path.join(outside, 'keep.txt'), path.join(root, 'ASSET_LICENSES.md')); }
    let requests = 0;
    const service = new AssetLibraryService(root, { enabled: true }, async () => { requests++; return imageResponse(); });
    const result = await service.fetchImage('https://example.com/image.png', 'assets/image.png', attribution);
    assert.equal(result.success, false);
    assert.match(result.error, /symlink/);
    assert.equal(requests, 0);
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'original');
  });
}

test('asset download rechecks links introduced during the network request', async t => {
  const { root, outside } = fixture(t);
  const service = new AssetLibraryService(root, { enabled: true }, async () => {
    fs.symlinkSync(outside, path.join(root, 'assets'));
    return imageResponse();
  });
  const result = await service.fetchImage('https://example.com/image.png', 'assets/image.png', attribution);
  assert.equal(result.success, false);
  assert.match(result.error, /symlink/);
  assert.deepEqual(fs.readdirSync(outside), ['keep.txt']);
});
