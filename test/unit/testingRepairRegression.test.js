const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AgentOrchestrator } = require('../../out/orchestrator/AgentOrchestrator');

for (const createsLockfile of [false, true]) {
test(`C06: regressing tester-requested repair restores baseline (new lockfile=${createsLockfile})`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testing-repair-regression-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const orchestrator = new AgentOrchestrator(root);
  await orchestrator.workspace.initialize();
  const original = 'module.exports = 42;\n';
  const broken = 'module.exports = missingName;\n';
  orchestrator.fileManager.writeWorkspaceFile('app.js', original);
  const originalPackage = JSON.stringify({ name: 'fixture', version: '1.0.0' });
  const repairedPackage = JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { fixture: '1.0.0' } });
  if (createsLockfile) orchestrator.fileManager.writeWorkspaceFile('package.json', originalPackage);
  orchestrator._phaseDependencyInstall = async () => {
    if (orchestrator.fileManager.readWorkspaceFile('package.json') === repairedPackage) {
      orchestrator.fileManager.writeWorkspaceFile('package-lock.json', '{"badRepairDependency":true}');
    } else {
      assert.equal(orchestrator.fileManager.fileExists('package-lock.json'), false,
        'Rollback must remove a lockfile newly created by the bad repair before reinstalling baseline dependencies');
    }
  };
  orchestrator.modelConfig = { maxFixRetries: 1 };
  orchestrator.terminal = { detectPackageManager: () => 'npm' };
  const state = {
    projectGoal: 'Keep the working module usable.', status: 'running', currentPhase: 'testing',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    openQuestions: [], decisions: [], activeTasks: [], completedTasks: [], failedTasks: [],
    currentTaskId: null, fixRetryCount: 0,
  };

  // Bound this test to testing/rollback control flow. No model or child process
  // is called; verification deterministically checks the actual fixture file.
  const verifiedStates = [];
  orchestrator._runProjectChecks = async () => {
    const passing = orchestrator.fileManager.readWorkspaceFile('app.js') === original;
    verifiedStates.push(passing);
    const output = passing ? '# tests 1\n# pass 1' : 'ReferenceError: missingName is not defined\n# tests 1\n# fail 1';
    return {
      compileResult: null,
      testResult: { command: 'npm test', success: passing, exitCode: passing ? 0 : 1, stdout: output, stderr: '', durationMs: 0 },
      output, failed: !passing, failedCommands: passing ? [] : ['npm test'], skippedChecks: [],
    };
  };
  orchestrator._analyzeProjectChecks = async () => ({
    passed: false, testsRun: 1, needsFix: true,
    errors: ['Improve the module implementation.'], warnings: [], fixDescription: 'Improve app.js.',
  });
  orchestrator._executeFixer = async () => ({
    reasoning: 'A deliberately regressing repair.',
    files: [{ path: 'app.js', action: 'modify', content: broken },
      ...(createsLockfile ? [{ path: 'package.json', action: 'modify', content: repairedPackage }] : [])],
  });
  orchestrator._collectTestFixAllowedFiles = () => ['app.js', 'package.json'];
  orchestrator._testFixFocus = () => null;
  orchestrator._normalizeAutonomousWorkerOutput = () => {};
  orchestrator._selfHealAllowedFiles = () => {};
  orchestrator._dropOutOfScopeChanges = () => [];
  orchestrator._validateTaskFileChanges = () => [];
  orchestrator._dropConflictingChanges = () => {};
  orchestrator._applyCodeChanges = async (_id, patch) => {
    for (const file of patch.files) { orchestrator.fileManager.writeWorkspaceFile(file.path, file.content); }
    return true;
  };
  orchestrator._recordActivity = () => {};
  orchestrator._updateTimeline = () => {};

  await orchestrator._phaseTesting(state);

  assert.equal(orchestrator.fileManager.readWorkspaceFile('app.js'), original,
    `Testing completed with the regressing repair still on disk; verification sequence: ${JSON.stringify(verifiedStates)}`);
  assert.deepEqual(verifiedStates, [true, false, true], 'the restored baseline must be checked again before completing');
});
}
