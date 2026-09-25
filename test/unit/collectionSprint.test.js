const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AgentOrchestrator } = require('../../out/orchestrator/AgentOrchestrator');

const binding = { collections: [{ label: 'levels', source: { kind: 'json-array', file: 'levels.json', pointer: '' } }] };
const state = () => ({ projectGoal: 'Build exactly 20 levels', status: 'running', currentPhase: 'testing',
  confirmedByUser: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  openQuestions: [], decisions: [], activeTasks: [], completedTasks: [], failedTasks: [], currentTaskId: null, fixRetryCount: 0 });

async function fixture(t, { count = 1, manifest = binding, testSuccess = true, maxFixRetries = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-sprint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(root, 'levels.json'), JSON.stringify(Array.from({ length: count }, (_, id) => ({ id }))));
  if (manifest) { fs.writeFileSync(path.join(root, 'acceptance.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest)); }
  const orchestrator = new AgentOrchestrator(root);
  await orchestrator.workspace.initialize();
  orchestrator.workspace.writeUserPrompt('Build exactly 20 distinct playable levels.');
  orchestrator.modelConfig = { ...orchestrator.workspace.readModelConfig(), maxFixRetries,
    appVerification: { enabled: false, startServer: false, httpSmokeTest: false, browserSmokeTest: false } };
  orchestrator.terminal = {
    detectPackageManager: () => 'npm', hasPackageScript: name => name === 'test',
    runTests: async () => ({ command: 'npm test', success: testSuccess, exitCode: testSuccess ? 0 : 1,
      stdout: testSuccess ? 'Current slice tests passed' : '', stderr: testSuccess ? '' : 'A real runtime assertion failed', durationMs: 1 }),
  };
  orchestrator._analyzeProjectChecks = async checks => ({ passed: !checks.failed, needsFix: checks.failed,
    errors: checks.failedCommands, warnings: [], testsRun: 1, fixDescription: 'Repair the failing checks.' });
  return { root, orchestrator };
}

test('a measured partial collection advances to sprint planning without spending fixer retries', async t => {
  const { root, orchestrator } = await fixture(t, { maxFixRetries: 3 });
  const checks = await orchestrator._runProjectChecks('npm');
  assert.equal(checks.failed, true, 'The strict project/final check must not be relaxed');
  assert.deepEqual(checks.failedCommands, ['collection acceptance']);
  assert.equal(checks.collectionAcceptance.checks[0].failureKind, 'too-few');
  orchestrator._executeFixer = () => { throw new Error('Incomplete content should be planned in the next sprint'); };
  orchestrator._analyzeProjectChecks = () => { throw new Error('No model is needed to classify a measured content deficit'); };
  await orchestrator._phaseTesting(state());
  assert.match(fs.readFileSync(orchestrator.workspace.testerPath, 'utf8'), /Incomplete Collection Scope.*\n.*original product scope is incomplete/);
  assert.match(fs.readFileSync(orchestrator.workspace.rollingSummaryPath, 'utf8'), /contains 1 levels.*requires exactly 20/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.agent-workspace/logs/collection_acceptance.json'), 'utf8')).failed, true);
});

test('a missing binding is repaired before the measured content deficit moves to the next sprint', async t => {
  const { root, orchestrator } = await fixture(t, { manifest: null, maxFixRetries: 3 });
  let fixes = 0;
  orchestrator._executeFixer = async task => {
    fixes++;
    assert.ok(task.allowedFiles.includes('acceptance.json'));
    return { reasoning: 'Bind the product data', files: [{ path: 'acceptance.json', action: 'create', content: JSON.stringify(binding) }],
      needUserInput: false, questions: [] };
  };
  orchestrator._applyCodeChanges = async (_id, output) => {
    for (const file of output.files) { fs.writeFileSync(path.join(root, file.path), file.content); }
    return true;
  };
  await orchestrator._phaseTesting(state());
  assert.equal(fixes, 1, 'Once the binding proves too-few entries, further code-fix attempts should not consume the sprint');
  assert.match(fs.readFileSync(orchestrator.workspace.testerPath, 'utf8'), /Incomplete Collection Scope/);
});

test('extra entries and invalid bindings remain fixable defects rather than deferred scope', async t => {
  for (const options of [{ count: 21 }, { manifest: '{invalid' }, { manifest: null }]) {
    const { orchestrator } = await fixture(t, options);
    const checks = await orchestrator._runProjectChecks('npm');
    assert.ok(['too-many', 'invalid-source', 'missing-binding'].includes(checks.collectionAcceptance.checks[0].failureKind));
    await assert.rejects(() => orchestrator._phaseTesting(state()), /Project checks still fail after 0 fix attempt/);
  }
});

test('a runtime or test failure is never hidden by a simultaneous content deficit', async t => {
  const { orchestrator } = await fixture(t, { count: 1, testSuccess: false });
  await assert.rejects(() => orchestrator._phaseTesting(state()), /Project checks still fail.*npm test/);
});

test('fresh collection evidence overrides unanimous STOP votes until all requested content exists', async t => {
  const { root, orchestrator } = await fixture(t);
  orchestrator._callWithFallbackJson = async () => ({ readyToStop: true, confidence: 'high', remainingWork: [],
    nextSprintGoal: '', rationale: 'The model claims all 20 levels are complete.' });
  const partial = await orchestrator._phaseImprovementConsensus(state(), 1);
  assert.equal(orchestrator._consensusReadyToStop(partial), false);
  assert.ok(partial.every(item => item.remainingWork.some(work => /Collection acceptance.*contains 1 levels/.test(work))));
  fs.writeFileSync(path.join(root, 'levels.json'), JSON.stringify(Array.from({ length: 20 }, (_, id) => ({ id }))));
  const complete = await orchestrator._phaseImprovementConsensus(state(), 2);
  assert.equal(orchestrator._consensusReadyToStop(complete), true, 'The gate should use current measured data, not stale deficits');
  assert.equal((await orchestrator._runProjectChecks('npm')).failed, false);
});
