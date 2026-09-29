const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AgentOrchestrator } = require('../out/orchestrator/AgentOrchestrator');
const { UserAbortError } = require('../out/utils/errors');

const conflictingManifest = {
  name: 'dependency-repair-regression',
  scripts: { build: 'webpack', test: 'jest' },
  devDependencies: { '@babel/core': '^8.0.5', 'ts-jest': '^29.4.0' },
};
const compatibleManifest = {
  ...conflictingManifest,
  devDependencies: { ...conflictingManifest.devDependencies, '@babel/core': '^7.28.0' },
};
const conflictEvidence = 'npm error code ERESOLVE\nnpm error peer @babel/core@">=7.0.0-beta.0 <8" from ts-jest@29.4.0';

function result(command, success, output = '') {
  return { command, success, exitCode: success ? 0 : 1, stdout: success ? output : '',
    stderr: success ? '' : output, durationMs: 1 };
}

function fixFile(orchestrator, file, content, overrides = {}) {
  const output = { reasoning: 'Select compatible versions from the reported conflict.', needUserInput: false, questions: [],
    files: [{ path: file, action: 'modify', content: typeof content === 'string' ? content : JSON.stringify(content), ...overrides }] };
  orchestrator._attachChangeBaseline(output, orchestrator._captureFileBaselines([file], 'dependency-fix', 'fixer'));
  return output;
}

async function setup(t, { maxFixRetries = 2, manifest = conflictingManifest, requirements } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-self-heal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const orchestrator = new AgentOrchestrator(root);
  await orchestrator.workspace.initialize();
  orchestrator.modelConfig = { ...orchestrator.workspace.readModelConfig(), maxFixRetries,
    autoInstallDependencies: true, safeMode: false, autonomousMode: true, askPolicy: 'never' };
  const state = orchestrator.workspace.readProjectState();
  orchestrator.workspace.writeUserPrompt('Build a browser game with all required functionality and real tests.');
  if (manifest !== null) {
    fs.writeFileSync(path.join(root, 'package.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  }
  if (requirements) {
    fs.writeFileSync(path.join(root, 'requirements.txt'), requirements);
    orchestrator.workspace.writeFile(orchestrator.workspace.toolchainReportPath, JSON.stringify({
      checks: [{ name: 'pip3', available: true }],
    }));
  }
  const commands = [];
  orchestrator.terminal = {
    detectPackageManager: () => 'npm',
    runSafeCommand: async command => { commands.push(command); return result(command, true); },
    // The orchestrator's own install is pre-approved (audit C08); the tests
    // below script both paths through runSafeCommand.
    runApprovedCommand(command, timeoutMs) { return this.runSafeCommand(command, timeoutMs); },
  };
  return { root, orchestrator, state, commands,
    installLog: () => fs.readFileSync(orchestrator.workspace.dependencyInstallLogPath, 'utf8') };
}

test('ERESOLVE feeds real evidence and current manifest to the fixer, then verifies a compatible reinstall', async t => {
  const { root, orchestrator, state, commands, installLog } = await setup(t);
  let fixerCalls = 0;
  orchestrator.terminal.runSafeCommand = async command => {
    commands.push(command);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return result(command, manifest.devDependencies['@babel/core'] === '^7.28.0', conflictEvidence);
  };
  orchestrator._executeFixer = async (task, review, _state, allowToolCalls) => {
    fixerCalls++;
    assert.equal(allowToolCalls, false);
    assert.match(review.issues.join('\n'), /Command: npm install\nExit: 1/);
    assert.match(review.issues.join('\n'), /ERESOLVE/);
    assert.match(review.issues.join('\n'), /ts-jest@29\.4\.0/);
    assert.ok(task.allowedFiles.includes('package.json'));
    assert.ok(!task.allowedFiles.includes('src/game.js'));
    return fixFile(orchestrator, 'package.json', compatibleManifest);
  };

  await orchestrator._phaseDependencyInstall(state);

  assert.equal(fixerCalls, 1);
  assert.deepEqual(commands, ['npm install', 'npm install']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')), compatibleManifest);
  assert.match(installLog(), /Install Attempt 1[\s\S]*ERESOLVE[\s\S]*Install Attempt 2[\s\S]*Exit: 0/);
});

test('bad diff is rejected with feedback and a later complete manifest repair succeeds', async t => {
  const { root, orchestrator, state, commands, installLog } = await setup(t);
  orchestrator.terminal.runSafeCommand = async command => {
    commands.push(command);
    return result(command, commands.length === 3, conflictEvidence);
  };
  let calls = 0;
  orchestrator._executeFixer = async (_task, review) => {
    calls++;
    if (calls === 1) { return fixFile(orchestrator, 'package.json', undefined, { patch: '@@ -1 +1 @@\n-stale\n-fixed' }); }
    assert.match(review.issues.join('\n'), /complete replacement content/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')), conflictingManifest);
    return fixFile(orchestrator, 'package.json', compatibleManifest);
  };

  await orchestrator._phaseDependencyInstall(state);

  assert.equal(calls, 2);
  assert.equal(commands.length, 3);
  assert.match(installLog(), /Repair rejected before applying/);
});

test('unsafe repair cannot remove scripts or dependencies, enable a bypass, or edit source files', async t => {
  const { root, orchestrator, state, commands, installLog } = await setup(t, { maxFixRetries: 4 });
  const sourcePath = path.join(root, 'source.js');
  fs.writeFileSync(sourcePath, 'user code');
  const proposals = [
    fixFile(orchestrator, 'package.json', { ...compatibleManifest, scripts: {} }),
    fixFile(orchestrator, 'package.json', { ...compatibleManifest, devDependencies: {} }),
    fixFile(orchestrator, 'package.json', { ...compatibleManifest, config: { 'legacy-peer-deps': true } }),
    fixFile(orchestrator, 'source.js', 'unrelated overwrite'),
  ];
  orchestrator._executeFixer = async () => proposals.shift();
  orchestrator.terminal.runSafeCommand = async command => {
    commands.push(command);
    return result(command, false, conflictEvidence);
  };

  await assert.rejects(() => orchestrator._phaseDependencyInstall(state), /still fails after 4 fix attempt/);

  assert.equal(commands.length, 5);
  assert.deepEqual(new Set(commands), new Set(['npm install']));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')), conflictingManifest);
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'user code');
  assert.match(installLog(), /preserve all existing package scripts/);
  assert.match(installLog(), /preserve the declared dependency/);
  assert.match(installLog(), /bypasses are not allowed/);
  assert.match(installLog(), /outside the task allowedFiles/);
});

test('empty fixer output never turns a persistent installation failure into success', async t => {
  const { orchestrator, state, commands, installLog } = await setup(t);
  let calls = 0;
  orchestrator._executeFixer = async () => { calls++; return null; };
  orchestrator.terminal.runSafeCommand = async command => { commands.push(command); return result(command, false, 'registry unreachable'); };

  await assert.rejects(() => orchestrator._phaseDependencyInstall(state), /Dependency install still fails after 2 fix attempt/);

  assert.equal(calls, 2);
  assert.equal(commands.length, 3);
  assert.match(installLog(), /registry unreachable/);
  assert.match(installLog(), /no usable output/);
});

test('an applied but ineffective repair still fails when the real reinstall fails', async t => {
  const { orchestrator, state, commands } = await setup(t, { maxFixRetries: 1 });
  orchestrator._executeFixer = async () => fixFile(orchestrator, 'package.json', compatibleManifest);
  orchestrator.terminal.runSafeCommand = async command => { commands.push(command); return result(command, false, 'another unresolved peer dependency'); };

  await assert.rejects(() => orchestrator._phaseDependencyInstall(state), /still fails after 1 fix attempt/);
  assert.equal(commands.length, 2);
});

test('terminal exceptions and unavailable fixer are bounded recoverable attempts', async t => {
  const { orchestrator, state, commands, installLog } = await setup(t);
  orchestrator._executeFixer = async () => { throw new Error('model connection lost'); };
  orchestrator.terminal.runSafeCommand = async command => {
    commands.push(command);
    if (commands.length === 1) { throw new Error('temporary child-process failure'); }
    return result(command, true, 'installed');
  };

  await orchestrator._phaseDependencyInstall(state);

  assert.equal(commands.length, 2);
  assert.match(installLog(), /temporary child-process failure/);
  assert.match(installLog(), /model connection lost/);
  assert.match(installLog(), /Exit: 0/);
});

test('zero retry budget preserves a hard failure after exactly one command', async t => {
  const { orchestrator, state, commands } = await setup(t, { maxFixRetries: 0 });
  orchestrator._executeFixer = async () => { throw new Error('Must not call fixer with zero budget'); };
  orchestrator.terminal.runSafeCommand = async command => { commands.push(command); return result(command, false, conflictEvidence); };

  await assert.rejects(() => orchestrator._phaseDependencyInstall(state), /still fails after 0 fix attempt/);
  assert.equal(commands.length, 1);
});

test('Python dependency conflicts also repair and reinstall requirements.txt', async t => {
  const { root, orchestrator, state, commands, installLog } = await setup(t, { manifest: null, requirements: 'example>=3\n' });
  orchestrator.terminal.runSafeCommand = async command => {
    commands.push(command);
    return result(command, fs.readFileSync(path.join(root, 'requirements.txt'), 'utf8').includes('<3'), 'ResolutionImpossible: incompatible example constraint');
  };
  orchestrator._executeFixer = async (task, review) => {
    assert.deepEqual(task.allowedFiles, ['requirements.txt']);
    assert.match(review.issues.join('\n'), /ResolutionImpossible/);
    return fixFile(orchestrator, 'requirements.txt', 'example>=2,<3\n');
  };

  await orchestrator._phaseDependencyInstall(state);

  assert.deepEqual(commands, ['pip3 install -r requirements.txt', 'pip3 install -r requirements.txt']);
  assert.match(installLog(), /Python Dependency Install/);
});

test('mixed Node and Python projects must reinstall both ecosystems after repair', async t => {
  const { orchestrator, state, commands } = await setup(t, { requirements: 'example>=3\n' });
  orchestrator.terminal.runSafeCommand = async command => {
    commands.push(command);
    return result(command, commands.length !== 2, 'ResolutionImpossible');
  };
  orchestrator._executeFixer = async () => fixFile(orchestrator, 'requirements.txt', 'example>=2,<3\n');

  await orchestrator._phaseDependencyInstall(state);

  assert.deepEqual(commands, ['npm install', 'pip3 install -r requirements.txt', 'npm install', 'pip3 install -r requirements.txt']);
});

test('missing manifests and contradictory command success flags do not skip failed installation', async t => {
  const { root, orchestrator, state, commands } = await setup(t, { maxFixRetries: 1 });
  orchestrator.terminal.runSafeCommand = async command => {
    commands.push(command);
    return { ...result(command, false, conflictEvidence), success: true };
  };
  orchestrator._executeFixer = async () => {
    fs.unlinkSync(path.join(root, 'package.json'));
    return null;
  };

  await assert.rejects(() => orchestrator._phaseDependencyInstall(state), /still fails after 1 fix attempt/);
  assert.equal(commands.length, 1);
});

test('dependency repair does not overwrite manifests edited after the model read them', async t => {
  const { root, orchestrator, state, commands, installLog } = await setup(t, { maxFixRetries: 1 });
  const userManifest = { ...conflictingManifest, description: 'concurrent user edit' };
  orchestrator.terminal.runSafeCommand = async command => { commands.push(command); return result(command, false, conflictEvidence); };
  orchestrator._executeFixer = async () => {
    const baseline = orchestrator._captureFileBaselines(['package.json'], 'dependency-fix-1', 'fixer');
    const output = fixFile(orchestrator, 'package.json', compatibleManifest);
    orchestrator._attachChangeBaseline(output, baseline);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(userManifest));
    return output;
  };

  await assert.rejects(() => orchestrator._phaseDependencyInstall(state), /still fails after 1 fix attempt/);

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')), userManifest);
  assert.match(installLog(), /Repair could not be applied/);
});

test('cancellation is propagated without installing or repairing again', async t => {
  const { orchestrator, state, commands } = await setup(t);
  orchestrator._executeFixer = async () => { throw new Error('Must not repair after cancellation'); };
  orchestrator.terminal.runSafeCommand = async command => { commands.push(command); throw new UserAbortError(); };

  await assert.rejects(() => orchestrator._phaseDependencyInstall(state), UserAbortError);
  assert.equal(commands.length, 1);
});

test('real fixer receives install diagnostics and manifest content without executing proposed tools', async t => {
  const { orchestrator, state, commands } = await setup(t);
  let capturedContext = '';
  let toolRounds = 0;
  orchestrator._ensureCapabilityServices = () => {};
  orchestrator.toolRegistry = { manifestForPrompt: () => 'terminal.run' };
  orchestrator._runWorkerToolLoop = async () => { toolRounds++; throw new Error('Dependency repair must not execute tools'); };
  orchestrator._callWithFallbackJson = async (_role, _model, _fallback, messages) => {
    capturedContext = JSON.stringify(messages);
    return { ...fixFile(orchestrator, 'package.json', compatibleManifest),
      toolRequests: [{ id: 'unsafe-tool', name: 'terminal.run', args: { command: 'npm install --legacy-peer-deps' } }] };
  };
  orchestrator.terminal.runSafeCommand = async command => {
    commands.push(command);
    return result(command, commands.length > 1, conflictEvidence);
  };

  await orchestrator._phaseDependencyInstall(state);

  assert.equal(toolRounds, 0);
  assert.match(capturedContext, /ERESOLVE/);
  assert.match(capturedContext, /\^8\.0\.5/);
  assert.match(capturedContext, /ts-jest/);
  assert.deepEqual(commands, ['npm install', 'npm install']);
});

test('invalid package JSON can be repaired with a valid full manifest including scripts', async t => {
  const { orchestrator, state, commands } = await setup(t, { manifest: '{"scripts":{"test":"jest"},' });
  orchestrator._executeFixer = async () => fixFile(orchestrator, 'package.json', compatibleManifest);
  orchestrator.terminal.runSafeCommand = async command => {
    commands.push(command);
    return result(command, commands.length > 1, 'EJSONPARSE: unexpected end of JSON input');
  };

  await orchestrator._phaseDependencyInstall(state);

  assert.equal(commands.length, 2);
});

test('Python repair cannot silently drop a conflicting requirement', async t => {
  const { root, orchestrator, state, commands, installLog } = await setup(t, {
    manifest: null, requirements: 'requests>=2\nurllib3>=1,<2\n', maxFixRetries: 1,
  });
  orchestrator._executeFixer = async () => fixFile(orchestrator, 'requirements.txt', 'requests>=2\n');
  orchestrator.terminal.runSafeCommand = async command => { commands.push(command); return result(command, false, 'ResolutionImpossible'); };

  await assert.rejects(() => orchestrator._phaseDependencyInstall(state), /still fails after 1 fix attempt/);

  assert.match(fs.readFileSync(path.join(root, 'requirements.txt'), 'utf8'), /urllib3/);
  assert.match(installLog(), /preserve the declared dependency urllib3/);
});

function projectChecks(failed) {
  return { failed, failedCommands: failed ? ['npm test'] : [], output: failed ? 'Tests failed: missing module' : 'All tests passed' };
}

test('test-fixer dependency changes are installed before checks rerun', async t => {
  const { orchestrator, state } = await setup(t, { maxFixRetries: 1 });
  const order = [];
  orchestrator._runProjectChecks = async () => { order.push('checks'); return projectChecks(order.length === 1); };
  orchestrator._analyzeProjectChecks = async () => ({ passed: false, testsRun: 1, errors: ['Missing module'], warnings: [], needsFix: true });
  orchestrator._collectTestFixAllowedFiles = () => ['package.json'];
  orchestrator._executeFixer = async () => fixFile(orchestrator, 'package.json', compatibleManifest);
  orchestrator.terminal.runSafeCommand = async command => { order.push(command); return result(command, true, 'Installed compatible dependencies'); };

  await orchestrator._phaseTesting(state);

  assert.deepEqual(order, ['checks', 'npm install', 'checks']);
  assert.equal(state.currentPhase, 'testing');
});

test('source-only test fixes do not redundantly install dependencies', async t => {
  const { root, orchestrator, state } = await setup(t, { maxFixRetries: 1 });
  fs.writeFileSync(path.join(root, 'source.js'), 'broken');
  const order = [];
  orchestrator._runProjectChecks = async () => { order.push('checks'); return projectChecks(order.length === 1); };
  orchestrator._analyzeProjectChecks = async () => ({ passed: false, testsRun: 1, errors: ['Source error'], warnings: [], needsFix: true });
  orchestrator._collectTestFixAllowedFiles = () => ['source.js'];
  orchestrator._executeFixer = async () => fixFile(orchestrator, 'source.js', 'fixed');
  orchestrator.terminal.runSafeCommand = async command => { order.push(command); return result(command, true); };

  await orchestrator._phaseTesting(state);

  assert.deepEqual(order, ['checks', 'checks']);
});

test('test-fixer dependency failures block verification instead of using stale node_modules', async t => {
  const { orchestrator, state } = await setup(t, { maxFixRetries: 1 });
  const order = [];
  orchestrator._runProjectChecks = async () => { order.push('checks'); return projectChecks(true); };
  orchestrator._analyzeProjectChecks = async () => ({ passed: false, testsRun: 1, errors: ['Missing module'], warnings: [], needsFix: true });
  orchestrator._collectTestFixAllowedFiles = () => ['package.json'];
  orchestrator._executeFixer = async task => task.id.startsWith('dependency-fix-') ? null : fixFile(orchestrator, 'package.json', compatibleManifest);
  orchestrator.terminal.runSafeCommand = async command => { order.push(command); return result(command, false, conflictEvidence); };

  await assert.rejects(() => orchestrator._phaseTesting(state), /Dependency install still fails/);

  assert.deepEqual(order, ['checks', 'npm install', 'npm install']);
});

test('restart during dependency reinstall resumes installation before entering testing', async t => {
  const { root, orchestrator, state } = await setup(t, { maxFixRetries: 1 });
  state.status = 'running';
  state.sprintStage = 'testing';
  orchestrator._runProjectChecks = async () => projectChecks(true);
  orchestrator._analyzeProjectChecks = async () => ({ passed: false, testsRun: 1, errors: ['Missing module'], warnings: [], needsFix: true });
  orchestrator._collectTestFixAllowedFiles = () => ['package.json'];
  orchestrator._executeFixer = async () => fixFile(orchestrator, 'package.json', compatibleManifest);
  orchestrator.terminal.runSafeCommand = async () => { throw new UserAbortError(); };

  await assert.rejects(() => orchestrator._phaseTesting(state), UserAbortError);
  const checkpoint = orchestrator.workspace.readProjectState();
  assert.equal(checkpoint.sprintStage, 'dependency_install');
  assert.equal(checkpoint.currentPhase, 'dependency_install');

  const restarted = new AgentOrchestrator(root);
  restarted.modelConfig = orchestrator.modelConfig;
  restarted.workspace.writeFile(restarted.workspace.projectBriefPath, JSON.stringify({ goal: 'Test dependency repair restart' }));
  restarted.workspace.writeFile(restarted.workspace.toolchainReportPath, JSON.stringify({ checks: [] }));
  const order = [];
  restarted.terminal = {
    detectPackageManager: () => 'npm',
    runSafeCommand: async command => { order.push(command); return result(command, true); },
    runApprovedCommand(command, timeoutMs) { return this.runSafeCommand(command, timeoutMs); },
  };
  for (const phase of ['_phaseBrainstorm', '_phaseCritique', '_phaseSecondBrainstorm', '_phaseDebateResponse', '_phaseDebateScoring', '_phaseBriefing', '_phaseToolchainDiscovery', '_phaseArchitecture', '_phaseTaskPlanning', '_phaseCoding']) {
    restarted[phase] = async () => { throw new Error(`Resume must not repeat ${phase}`); };
  }
  restarted._phaseTesting = async () => { order.push('checks'); };
  restarted._phaseImprovementConsensus = async () => [];
  restarted._consensusReadyToStop = () => true;
  restarted._loadTaskPlan = () => null;
  restarted._phaseArtifactDelivery = async () => {};
  restarted._phaseFinalIntegration = async () => {};

  await restarted._runWorkflow(checkpoint);

  assert.deepEqual(order, ['npm install', 'checks']);
});

test('testing refreshes the package manager after a lockfile repair', async t => {
  const { root, orchestrator, state } = await setup(t, { maxFixRetries: 1 });
  const order = [];
  orchestrator.terminal.detectPackageManager = () => fs.existsSync(path.join(root, 'yarn.lock')) ? 'yarn' : 'npm';
  orchestrator._runProjectChecks = async pm => { order.push(`checks:${pm}`); return projectChecks(order.length === 1); };
  orchestrator._analyzeProjectChecks = async () => ({ passed: false, testsRun: 1, errors: ['Missing lockfile'], warnings: [], needsFix: true });
  orchestrator._collectTestFixAllowedFiles = () => ['yarn.lock'];
  orchestrator._executeFixer = async () => fixFile(orchestrator, 'yarn.lock', '# yarn lockfile v1\n', { action: 'create' });
  orchestrator.terminal.runSafeCommand = async command => { order.push(command); return result(command, true); };

  await orchestrator._phaseTesting(state);

  assert.deepEqual(order, ['checks:npm', 'yarn install', 'checks:yarn']);
  assert.equal(orchestrator.workspace.readProjectState().sprintStage, 'testing');
});

test('test repairs that make things worse twice in a row are rolled back to the best state', async t => {
  const { root, orchestrator, state } = await setup(t, { maxFixRetries: 4, manifest: null });
  fs.writeFileSync(path.join(root, 'source.js'), 'v0');
  const errorsFor = { v0: 1, v1: 1, v2: 5, v3: 9, v4: 9 };
  const logs = [];
  orchestrator.setCallbacks({ onLog: message => logs.push(message) });
  orchestrator._runProjectChecks = async () => {
    const version = fs.readFileSync(path.join(root, 'source.js'), 'utf8');
    return { failed: true, failedCommands: ['npm test'], output: Array.from({ length: errorsFor[version] }, (_, i) => `error ${i} in source.js`).join('\n') };
  };
  orchestrator._analyzeProjectChecks = async () => ({ passed: false, testsRun: 1, errors: ['Source error'], warnings: [], needsFix: true });
  orchestrator._collectTestFixAllowedFiles = () => ['source.js'];
  let attempt = 0;
  orchestrator._executeFixer = async () => fixFile(orchestrator, 'source.js', `v${++attempt}`);

  await assert.rejects(() => orchestrator._phaseTesting(state), /still fail/);

  assert.equal(fs.readFileSync(path.join(root, 'source.js'), 'utf8'), 'v0', 'the best (initial) state is left on disk');
  assert.ok(logs.some(message => /rolled back to the best state/.test(message)), logs.join('\n'));
});

function versionedChecks(root, spec) {
  return async () => {
    const version = fs.readFileSync(path.join(root, 'source.js'), 'utf8');
    const { errors = 0, tests = null } = spec(version);
    const testOutput = tests === null ? '' : `ℹ tests ${tests}\nℹ pass ${tests - Math.min(errors, tests)}`;
    return {
      failed: errors > 0, failedCommands: errors > 0 ? ['npm test'] : [], skippedChecks: [], compileResult: null,
      testResult: { command: 'npm test', success: errors === 0, exitCode: errors ? 1 : 0, stdout: testOutput, stderr: '', durationMs: 1 },
      output: [testOutput, ...Array.from({ length: errors }, (_, i) => `error ${i} in source.js`)].join('\n'),
    };
  };
}

function scriptedFixer(orchestrator, versions) {
  let attempt = 0;
  orchestrator._analyzeProjectChecks = async () => ({ passed: false, testsRun: 1, errors: ['Source error'], warnings: [], needsFix: true });
  orchestrator._collectTestFixAllowedFiles = () => ['source.js'];
  orchestrator._executeFixer = async () => fixFile(orchestrator, 'source.js', versions[attempt++] ?? `v${attempt}`);
}

test('audit C06: a rollback whose restored state passes ends the test phase as a success', async t => {
  const { root, orchestrator, state } = await setup(t, { maxFixRetries: 4, manifest: null });
  fs.writeFileSync(path.join(root, 'source.js'), 'v0');
  let v0Checks = 0;
  // The initial state only fails until something external settles (e.g. a reinstall).
  orchestrator._runProjectChecks = versionedChecks(root, v => v === 'v0' ? { errors: ++v0Checks > 1 ? 0 : 1, tests: 3 } : { errors: v === 'v1' ? 5 : 9, tests: 3 });
  scriptedFixer(orchestrator, ['v1', 'v2']);

  await orchestrator._phaseTesting(state);
  assert.equal(fs.readFileSync(path.join(root, 'source.js'), 'utf8'), 'v0');
});

test('audit C06: a rollback does not overwrite a file someone else changed after the repair', async t => {
  const { root, orchestrator, state } = await setup(t, { maxFixRetries: 2, manifest: null });
  fs.writeFileSync(path.join(root, 'source.js'), 'v0');
  orchestrator._runProjectChecks = versionedChecks(root, v => ({ errors: v === 'v0' ? 1 : 9, tests: 3 }));
  scriptedFixer(orchestrator, ['v1', 'v2']);
  const analyze = orchestrator._analyzeProjectChecks;
  let analyses = 0;
  orchestrator._analyzeProjectChecks = async checks => {
    if (++analyses === 3) { fs.writeFileSync(path.join(root, 'source.js'), 'edited by someone else'); }
    return analyze(checks);
  };

  await assert.rejects(() => orchestrator._phaseTesting(state), /still fail after 2 fix attempt/);
  assert.equal(fs.readFileSync(path.join(root, 'source.js'), 'utf8'), 'edited by someone else');
});

test('audit C06: the lockfile an install rewrote during a repair is restored with the source', async t => {
  const { root, orchestrator, state } = await setup(t, { maxFixRetries: 2, manifest: null });
  fs.writeFileSync(path.join(root, 'source.js'), 'v0');
  fs.writeFileSync(path.join(root, 'package-lock.json'), 'lock-v0');
  const checks = versionedChecks(root, v => ({ errors: v === 'v0' ? 1 : 9, tests: 3 }));
  orchestrator._runProjectChecks = async pm => {
    if (fs.readFileSync(path.join(root, 'source.js'), 'utf8') !== 'v0') { fs.writeFileSync(path.join(root, 'package-lock.json'), 'lock-rewritten'); }
    return checks(pm);
  };
  scriptedFixer(orchestrator, ['v1', 'v2']);

  await assert.rejects(() => orchestrator._phaseTesting(state), /still fail/);
  assert.equal(fs.readFileSync(path.join(root, 'source.js'), 'utf8'), 'v0');
  assert.equal(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'), 'lock-v0');
});

test('audit C06: a repair that passes by running fewer tests is not a pass and not the best state', async t => {
  const { root, orchestrator, state } = await setup(t, { maxFixRetries: 1, manifest: null });
  fs.writeFileSync(path.join(root, 'source.js'), 'v0');
  const logs = [];
  orchestrator.setCallbacks({ onLog: message => logs.push(message) });
  orchestrator._runProjectChecks = versionedChecks(root, v => v === 'v0' ? { errors: 2, tests: 5 } : { errors: 0, tests: 1 });
  scriptedFixer(orchestrator, ['tests deleted']);

  await assert.rejects(() => orchestrator._phaseTesting(state), /still fail after 1 fix attempt/);
  assert.equal(fs.readFileSync(path.join(root, 'source.js'), 'utf8'), 'v0', 'the shrunken state is rolled back');
  assert.ok(logs.some(message => /ran less than before \(1 test\(s\) executed instead of 5\)/.test(message)), logs.join('\n'));
});

test('audit C06: the failure message counts the attempts actually run when repairs stop early', async t => {
  const { root, orchestrator, state } = await setup(t, { maxFixRetries: 8, manifest: null });
  fs.writeFileSync(path.join(root, 'source.js'), 'v0');
  const errors = { v0: 1, v1: 5, v2: 9, v3: 20, v4: 30 };
  orchestrator._runProjectChecks = versionedChecks(root, v => ({ errors: errors[v] ?? 40, tests: 3 }));
  scriptedFixer(orchestrator, ['v1', 'v2', 'v3', 'v4']);

  await assert.rejects(() => orchestrator._phaseTesting(state), /still fail after 4 fix attempt\(s\)/);
});

test('audit D03: a test-fix attempt without focus does not reuse the previous sprint\'s focus text', async t => {
  const { root, orchestrator, state } = await setup(t, { maxFixRetries: 1, manifest: null });
  fs.writeFileSync(path.join(root, 'source.js'), 'v0');
  orchestrator._testFixFocusText.set('test-fix-1', 'stale diagnostics from sprint 1');
  orchestrator._testFixFocus = () => null;
  orchestrator._runProjectChecks = versionedChecks(root, v => ({ errors: v === 'v0' ? 1 : 0, tests: 3 }));
  scriptedFixer(orchestrator, ['v1']);
  await orchestrator._phaseTesting(state);
  assert.equal(orchestrator._testFixFocusText.has('test-fix-1'), false);
});
