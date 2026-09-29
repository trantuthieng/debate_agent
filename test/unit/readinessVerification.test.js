const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ModelReadinessService } = require('../../out/services/modelReadinessService');
const { VerificationPlanner } = require('../../out/services/verificationPlanner');
const { runSidebarGoal } = require('../../out/webview/sidebarWorkflow');
const { finalizeCompletedState } = require('../../out/orchestrator/workflowState');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-readiness-verification-'));
}

function readinessClient(installed, failures = []) {
  const calls = [];
  return {
    calls,
    checkConnection: async () => true,
    listModels: async () => installed,
    chat: async model => {
      calls.push(model);
      if (failures.includes(model)) { throw new Error('probe failed'); }
      return 'READY';
    },
    unloadModel: async () => {},
  };
}

test('model readiness only grants strict mode to five installed responsive distinct models', async () => {
  const models = ['m1', 'm2', 'm3', 'm4', 'm5'];
  const client = readinessClient(models.map(model => `${model}:latest`));
  const report = await new ModelReadinessService(client).assess(models);
  assert.equal(report.status, 'strict-5-model');
  assert.equal(new Set(report.selectedModels).size, 5);
  assert.equal(client.calls.length, 5);
});

test('model readiness probes and reserves one independent tie-breaker when available', async () => {
  const models = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
  const report = await new ModelReadinessService(readinessClient(models)).assess(models);
  assert.deepEqual(report.selectedModels, models.slice(0, 5));
  assert.deepEqual(report.reserveModels, ['m6']);
});

test('model readiness uses a real installed substitute but marks the verdict degraded', async () => {
  const configured = ['m1', 'm2', 'm3', 'm4', 'missing'];
  const client = readinessClient(['m1', 'm2', 'm3', 'm4', 'substitute']);
  const report = await new ModelReadinessService(client).assess(configured);
  assert.equal(report.status, 'degraded');
  assert.ok(report.selectedModels.includes('substitute'));
  assert.deepEqual(report.missingConfiguredModels, ['missing']);
});

test('model readiness blocks before debate when fewer than five models answer', async () => {
  const client = readinessClient(['m1', 'm2', 'm3', 'm4', 'm5'], ['m5']);
  const report = await new ModelReadinessService(client).assess(['m1', 'm2', 'm3', 'm4', 'm5']);
  assert.equal(report.status, 'blocked');
  assert.equal(report.selectedModels.length, 4);
  assert.match(report.guidance.join(' '), /only 4 responded/i);
});

test('automatic readiness discovery skips unstable and embedding-only models, including tie-breakers', async () => {
  const models = ['m1', 'm2', 'm3', 'm4', 'm5'];
  const client = readinessClient([...models, 'qwen3-coder:30b', 'qwen3-embedding:8b', 'reserve']);
  const report = await new ModelReadinessService(client).assess(models);
  assert.deepEqual(report.reserveModels, ['reserve']);
  assert.ok(!client.calls.includes('qwen3-coder:30b'));
  assert.ok(!client.calls.includes('qwen3-embedding:8b'));
});

test('an explicitly configured previously unstable model remains an opt-in', async () => {
  const models = ['m1', 'm2', 'm3', 'm4', 'qwen3-coder:30b'];
  const report = await new ModelReadinessService(readinessClient(models)).assess(models);
  assert.equal(report.status, 'strict-5-model');
  assert.ok(report.selectedModels.includes('qwen3-coder:30b'));
});

test('readiness does not count aliases with identical model digests as diversity', async () => {
  const models = ['m1', 'alias-of-m1', 'm2', 'm3', 'm4', 'm5'];
  const client = readinessClient(models);
  client.listModelInventory = async () => models.map(model => ({
    name: model, digest: model === 'alias-of-m1' ? 'm1' : model,
  }));
  const report = await new ModelReadinessService(client).assess(models);
  assert.deepEqual(report.selectedModels, ['m1', 'm2', 'm3', 'm4', 'm5']);
  assert.ok(!client.calls.includes('alias-of-m1'));
});

test('metadata rejects embedding capabilities even when the model name looks conversational', async () => {
  const client = readinessClient(['chatty', 'm1', 'm2', 'm3', 'm4', 'm5']);
  client.getModelDetails = async model => ({ capabilities: model === 'chatty' ? ['embedding'] : ['completion'] });
  const report = await new ModelReadinessService(client).assess(['chatty']);
  assert.equal(report.selectedModels.length, 5);
  assert.ok(!client.calls.includes('chatty'));
});

test('readiness propagates user cancellation instead of probing remaining models', async () => {
  const { UserAbortError } = require('../../out/utils/errors');
  const client = readinessClient(['m1', 'm2', 'm3', 'm4', 'm5']);
  client.chat = async model => { client.calls.push(model); throw new UserAbortError(); };
  await assert.rejects(new ModelReadinessService(client).assess(['m1']), UserAbortError);
  assert.deepEqual(client.calls, ['m1']);
});

test('cancellation during readiness cleanup also prevents the next model load', async () => {
  const { UserAbortError } = require('../../out/utils/errors');
  const client = readinessClient(['m1', 'm2', 'm3', 'm4', 'm5']);
  client.unloadModel = async () => { throw new UserAbortError(); };
  await assert.rejects(new ModelReadinessService(client).assess(['m1']), UserAbortError);
  assert.deepEqual(client.calls, ['m1']);
});

test('sidebar routing always invokes the autonomous entry point', async () => {
  const calls = [];
  await runSidebarGoal({ runAutonomousGoal: async goal => calls.push(goal) }, 'boss prompt');
  assert.deepEqual(calls, ['boss prompt']);
});

test('completed state invariant clears active tasks and current task', () => {
  const state = {
    status: 'running', currentPhase: 'coding', activeTasks: ['t1'], currentTaskId: 't1',
    fixRetryCount: 2, updatedAt: '', projectGoal: '', confirmedByUser: false,
    createdAt: '', openQuestions: [], decisions: [], completedTasks: [], failedTasks: [],
  };
  finalizeCompletedState(state);
  assert.equal(state.status, 'completed');
  assert.equal(state.currentPhase, 'completed');
  assert.deepEqual(state.activeTasks, []);
  assert.equal(state.currentTaskId, null);
});

test('verification planner detects Python stack, manifest, real test command, and placeholders', () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'pyproject.toml'), '[project]\nname = "demo"\nversion = "0.1.0"\n');
  fs.writeFileSync(path.join(root, 'app.py'), 'def add(a, b):\n    return a + b\n');
  fs.writeFileSync(path.join(root, 'tests', 'test_app.py'), 'def test_placeholder():\n    assert True\n');
  const plan = new VerificationPlanner(root).plan();
  assert.deepEqual(plan.stacks, ['python']);
  assert.ok(plan.commands.some(item => item.command === 'python3 -m pytest'));
  assert.ok(plan.blockingIssues.some(issue => /placeholder/i.test(issue)));
});

test('verification planner uses package scripts and rejects a missing Node test script', () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
  const plan = new VerificationPlanner(root).plan('npm');
  assert.deepEqual(plan.commands.map(item => item.command), ['npm run build']);
  assert.ok(plan.blockingIssues.some(issue => /no package\.json test script/i.test(issue)));
});
