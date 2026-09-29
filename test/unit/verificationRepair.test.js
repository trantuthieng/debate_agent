const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AgentOrchestrator } = require('../../out/orchestrator/AgentOrchestrator');

test('nullable patch fields do not override complete corrected file content', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nullable-patch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agent = new AgentOrchestrator(root);
  await agent.workspace.initialize();
  agent._loadConfig();
  const output = { files: [{ path: 'fixed.js', action: 'create', content: 'module.exports = 42;', patch: null }] };
  agent._normalizeWorkerOutputShape('fixer', { id: 'repair' }, output);
  assert.equal(output.files[0].patch, undefined);
  assert.equal(await agent._applyCodeChanges('nullable', output, {}), true);
  assert.equal(agent.fileManager.readWorkspaceFile('fixed.js'), 'module.exports = 42;');
});

test('import repair diagnostics resolve from the nested importing file, without guessing ambiguous targets', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-repair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agent = new AgentOrchestrator(root);
  await agent.workspace.initialize();
  agent.fileManager.writeWorkspaceFile('tests/unit/levelManager.test.js', 'test source');
  agent.fileManager.writeWorkspaceFile('src/utils/levelManager.js', 'export default class LevelManager {}');
  const diagnostic = "Cannot find module '../src/utils/levelManager.js' from 'tests/unit/levelManager.test.js'";
  const hints = agent._resolvedImportDiagnostics(diagnostic);
  assert.equal(hints.length, 1);
  assert.match(hints[0], /relative specifier from this importer is ..\/..\/src\/utils\/levelManager.js/);
  assert.match(hints[0], /ESM\/CommonJS/);
  agent.fileManager.writeWorkspaceFile('alternate/levelManager.js', 'module.exports = {};');
  assert.deepEqual(agent._resolvedImportDiagnostics(diagnostic), []);
});

test('third verification repair uses the configured alternate model with bounded diagnostic context', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-alternate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agent = new AgentOrchestrator(root);
  await agent.workspace.initialize();
  agent._loadConfig();
  agent.modelConfig.agents.fixer = { model: 'primary', fallbackModel: 'alternate' };
  agent.fileManager.writeWorkspaceFile('main.js', 'module.exports = 1;');
  const task = { id: 'test-fix-3', title: 'Repair', description: 'Fix errors', allowedFiles: ['main.js'], acceptanceCriteria: ['tests pass'] };
  const review = { issues: ['incorrect result'], securityConcerns: [], fixSuggestions: [] };
  let model;
  agent._callWithFallbackJson = async (role, primary, fallback, messages) => {
    model = primary;
    assert.equal(fallback, 'primary');
    assert.ok(messages.map(message => message.content).join('').length < 50_000);
    return { files: [{ path: 'main.js', action: 'modify', content: 'module.exports = 2;' }], reasoning: 'Fixed', questions: [] };
  };
  const output = await agent._executeFixer(task, review, { fixRetryCount: 3 }, false);
  assert.equal(model, 'alternate');
  assert.equal(output.files[0].content, 'module.exports = 2;');
  assert.equal(agent.fileManager.readWorkspaceFile('main.js'), 'module.exports = 1;');
});
