const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AgentOrchestrator } = require('../../out/orchestrator/AgentOrchestrator');
const { FileManager } = require('../../out/workspace/FileManager');

test('explicit directory descriptions without a slash produce writable directories and pass structural review', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'directory-scaffold-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agent = new AgentOrchestrator(root);
  const files = ['src/assets/images', 'src/assets/sounds', 'tests/unit', 'tests/e2e']
    .map(name => ({ path: name, action: 'create', content: '', description: `${name} directory created.` }));
  const output = { files };
  agent._normalizeWorkerOutputShape('codeWorker', { id: 'setup' }, output);
  assert.ok(output.files.every(file => file.path.endsWith('/')));
  assert.deepEqual(agent._heuristicReviewIssues(output), []);
  const manager = new FileManager(root);
  assert.equal(manager.applyApprovedChanges(output.files).applied, true);
  manager.writeWorkspaceFile('tests/unit/physics.test.js', 'module.exports = true;\n');
  assert.equal(fs.statSync(path.join(root, 'src/assets/images')).isDirectory(), true);
  assert.match(manager.readWorkspaceFile('tests/unit/physics.test.js'), /true/);
  assert.equal(manager.readWorkspaceFile('tests/unit'), null);
});

test('a resumed directory operation repairs only zero-byte regular placeholders', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'directory-repair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = new FileManager(root);
  fs.writeFileSync(path.join(root, 'assets'), '');
  assert.equal(manager.applyApprovedChanges([{ path: 'assets/', action: 'create', content: '' }]).applied, true);
  assert.equal(fs.statSync(path.join(root, 'assets')).isDirectory(), true);
  fs.writeFileSync(path.join(root, 'valuable'), 'keep me');
  assert.equal(manager.applyApprovedChanges([{ path: 'valuable/', action: 'create', content: '' }]).applied, false);
  assert.equal(fs.readFileSync(path.join(root, 'valuable'), 'utf8'), 'keep me');
  fs.symlinkSync('valuable', path.join(root, 'linked'));
  assert.equal(manager.applyApprovedChanges([{ path: 'linked/', action: 'create', content: '' }]).applied, false);
  assert.equal(fs.lstatSync(path.join(root, 'linked')).isSymbolicLink(), true);
});

test('empty real files and content disguised as a directory remain invalid', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'directory-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agent = new AgentOrchestrator(root);
  const output = { files: [
    { path: 'Dockerfile', action: 'create', content: '', description: 'Build file in the project directory.' },
    { path: 'src/main.js', action: 'create', content: '', description: 'Source file.' },
    { path: 'src/', action: 'create', content: 'real content' },
  ] };
  agent._normalizeWorkerOutputShape('codeWorker', { id: 'setup' }, output);
  assert.equal(output.files[0].path, 'Dockerfile');
  assert.equal(output.files[1].path, 'src/main.js');
  const issues = agent._heuristicReviewIssues(output);
  assert.equal(issues.length, 3);
  assert.match(issues[2], /directory entry/);
  assert.equal(new FileManager(root).applyApprovedChanges([output.files[2]]).applied, false);
});
