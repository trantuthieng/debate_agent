const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AgentOrchestrator } = require('../out/orchestrator/AgentOrchestrator');
const { GitRepositoryReader } = require('../out/git/GitRepositoryReader');

function makeTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'local-agent-orchestrator-test-'));
}

function makeState(overrides = {}) {
  const now = new Date().toISOString();
  return {
    projectGoal: 'Build a tiny Node.js CLI with real compile and test scripts.',
    status: 'running',
    currentPhase: 'testing',
    confirmedByUser: false,
    createdAt: now,
    updatedAt: now,
    openQuestions: [],
    decisions: [],
    activeTasks: [],
    completedTasks: [],
    failedTasks: [],
    currentTaskId: null,
    fixRetryCount: 0,
    ...overrides,
  };
}

function makeResult(command, success, output = '') {
  return {
    command,
    exitCode: success ? 0 : 1,
    stdout: success ? output : '',
    stderr: success ? '' : output || 'failed',
    durationMs: 1,
    success,
  };
}

function makeModelConfig(maxFixRetries = 0) {
  return {
    ollamaBaseUrl: 'http://localhost:11434',
    requestTimeoutMs: 30_000,
    safeMode: false,
    autonomousMode: true,
    askPolicy: 'never',
    debateRounds: 3,
    maxFixRetries,
    autoInstallDependencies: true,
    artifactDir: 'dist',
    createFinalArchive: true,
    requireVerificationScripts: true,
    selfHealing: {
      enabled: true,
      modelCallRetries: 0,
      retryDelayMs: 0,
      alternateModelLimit: 0,
      compactContextChars: 4000,
    },
    defaultOptions: {},
    agents: {
      briefBuilder: { model: 'brief', fallbackModel: 'brief' },
      brainstorm: { model: 'brainstorm', fallbackModel: 'brainstorm' },
      critic: { model: 'critic', fallbackModel: 'critic' },
      secondBrainstorm: { model: 'second', fallbackModel: 'second' },
      architect: { model: 'architect', fallbackModel: 'architect' },
      taskManager: { model: 'task-manager', fallbackModel: 'task-manager' },
      codeWorker: { model: 'code-worker', fallbackModel: 'code-worker' },
      reviewer: { model: 'reviewer', fallbackModel: 'reviewer' },
      tester: { model: 'tester', fallbackModel: 'tester' },
      fixer: { model: 'fixer', fallbackModel: 'fixer' },
      finalIntegrator: { model: 'final', fallbackModel: 'final' },
    },
  };
}

function makeTerminal({ scripts = [], compileSuccess = true, testSuccess = true } = {}) {
  const commands = [];
  const scriptSet = new Set(scripts);
  return {
    commands,
    detectPackageManager: () => 'npm',
    hasPackageScript: scriptName => scriptSet.has(scriptName),
    runSafeCommand: async command => {
      commands.push(command);
      return makeResult(command, compileSuccess, compileSuccess ? 'compile ok' : 'compile failed');
    },
    runTests: async () => {
      commands.push('npm test');
      return makeResult('npm test', testSuccess, testSuccess ? 'tests ok' : 'tests failed');
    },
  };
}

async function makeOrchestrator(root, { maxFixRetries = 0, terminal, testerOutput } = {}) {
  const orchestrator = new AgentOrchestrator(root);
  await orchestrator.workspace.initialize();
  orchestrator.workspace.writeUserPrompt('Build a tiny Node.js CLI with compile, start, and real tests.');
  orchestrator.workspace.writeProjectState(makeState());
  orchestrator.modelConfig = makeModelConfig(maxFixRetries);
  orchestrator.terminal = terminal ?? makeTerminal();
  orchestrator.ollama = {
    callWithFallbackJson: async () => testerOutput ?? {
      passed: true,
      testsRun: 1,
      errors: [],
      warnings: [],
      needsFix: false,
    },
  };
  return orchestrator;
}

test('git reader captures workspace repository status', async () => {
  try {
    cp.execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    return;
  }

  const root = makeTempWorkspace();
  cp.execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  fs.writeFileSync(path.join(root, 'README.md'), '# Demo\n');
  cp.execFileSync('git', ['add', 'README.md'], { cwd: root, stdio: 'ignore' });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/index.js'), 'console.log("hi");\n');

  const snapshot = await new GitRepositoryReader(root).readSnapshot();

  assert.equal(snapshot.isRepository, true);
  assert.equal(snapshot.changedFileCount, 2);
  assert.equal(snapshot.untrackedFileCount, 1);
  assert.ok(snapshot.changedFiles.some(file => file.path === 'README.md' && file.indexStatus === 'A'));
  assert.ok(snapshot.changedFiles.some(file => file.path === 'src/index.js' && file.rawStatus === '??'));
});

test('toolchain discovery writes git snapshot for agent context', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  orchestrator.gitReader = {
    readSnapshot: async () => ({
      generatedAt: new Date().toISOString(),
      workspaceRoot: root,
      isRepository: true,
      repositoryRoot: root,
      branch: 'main',
      head: 'abc1234',
      branchStatus: '## main',
      changedFiles: [{ path: 'src/index.ts', rawStatus: ' M', indexStatus: ' ', workingTreeStatus: 'M' }],
      changedFileCount: 1,
      untrackedFileCount: 0,
      recentCommits: [],
      warnings: [],
    }),
  };

  await orchestrator._phaseToolchainDiscovery(makeState({ currentPhase: 'toolchain_discovery' }));

  const snapshot = JSON.parse(fs.readFileSync(orchestrator.workspace.gitSnapshotPath, 'utf8'));
  const rollingSummary = fs.readFileSync(orchestrator.workspace.rollingSummaryPath, 'utf8');
  assert.equal(snapshot.isRepository, true);
  assert.equal(snapshot.branch, 'main');
  assert.match(rollingSummary, /Git: main \(1 changed file\(s\)\)/);
});

test('testing skips npx tsc when no compile/build script exists', async () => {
  const root = makeTempWorkspace();
  const terminal = makeTerminal({ scripts: ['test'], testSuccess: true });
  const orchestrator = await makeOrchestrator(root, { terminal });

  await orchestrator._phaseTesting(makeState());

  assert.deepEqual(terminal.commands, ['npm test']);
});

test('architecture self-heals when the model does not return a JSON plan', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  orchestrator.ollama = {
    callWithFallback: async () => '# Architecture\n\nThis response forgot the required JSON block.',
  };

  await orchestrator._phaseArchitecture(makeState({ currentPhase: 'architecture' }));

  const plan = JSON.parse(fs.readFileSync(orchestrator.workspace.architectJsonPath, 'utf8'));
  const assumptions = fs.readFileSync(orchestrator.workspace.assumptionsPath, 'utf8');

  assert.equal(plan.needUserInput, false);
  assert.equal(plan.readyToCode, true);
  assert.match(assumptions, /Self-healed invalid architecture JSON/);
});

test('task planning self-heals when both configured models fail', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  orchestrator.workspace.writeFile(orchestrator.workspace.architectMdPath, '# Architecture\n\nUse a small TypeScript web app.');
  orchestrator.ollama = {
    callWithFallback: async () => {
      throw new Error('Both primary model "task-manager" and fallback "task-manager" failed.');
    },
  };

  await orchestrator._phaseTaskPlanning(makeState({ currentPhase: 'task_planning' }));

  const plan = JSON.parse(fs.readFileSync(orchestrator.workspace.taskPlanPath, 'utf8'));
  const assumptions = fs.readFileSync(orchestrator.workspace.assumptionsPath, 'utf8');

  assert.equal(plan.totalTasks, 3);
  assert.equal(plan.tasks[0].status, 'pending');
  assert.match(assumptions, /Self-healed failed task planning model call/);
});

test('prompt referenced files are read into agent context', async () => {
  const root = makeTempWorkspace();
  fs.writeFileSync(path.join(root, 'notes.md'), 'Build the tiny CLI with a cheerful status command.');
  const orchestrator = await makeOrchestrator(root);
  orchestrator.workspace.writeUserPrompt('Doc notes.md roi lam theo.');

  const enrichedPrompt = orchestrator._userPromptWithFileContext();

  assert.match(enrichedPrompt, /Prompt-Referenced Workspace Files/);
  assert.match(enrichedPrompt, /cheerful status command/);
  assert.deepEqual(orchestrator._promptReferencedFilePaths(), ['notes.md']);
});

test('bare note file references resolve when unique', async () => {
  const root = makeTempWorkspace();
  fs.writeFileSync(path.join(root, 'note.md'), 'Only build the feature described here.');
  const orchestrator = await makeOrchestrator(root);
  orchestrator.workspace.writeUserPrompt('doc file note de biet can lam gi');

  const enrichedPrompt = orchestrator._userPromptWithFileContext();

  assert.match(enrichedPrompt, /Only build the feature described here/);
  assert.deepEqual(orchestrator._promptReferencedFilePaths(), ['note.md']);
});

test('prompt file resolution avoids workspace scan when no file is mentioned', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  let scans = 0;
  orchestrator.fileManager.listWorkspaceFiles = () => {
    scans += 1;
    throw new Error('workspace scan should not run');
  };

  const files = orchestrator._resolvePromptReferencedFiles('Build a polished dashboard app.');

  assert.deepEqual(files, []);
  assert.equal(scans, 0);
});

test('task manager receives prompt referenced file content', async () => {
  const root = makeTempWorkspace();
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/spec.md'), 'IMPORTANT REQ: expose a --status command.');
  const orchestrator = await makeOrchestrator(root);
  orchestrator.workspace.writeUserPrompt('Read docs/spec.md and create the project.');
  orchestrator.workspace.writeFile(orchestrator.workspace.architectMdPath, '# Architecture\n\nUse TypeScript.');

  let capturedMessages = null;
  orchestrator.ollama = {
    callWithFallback: async (_model, _fallback, messages) => {
      capturedMessages = messages;
      return JSON.stringify({
        tasks: [
          {
            id: 'task-001',
            title: 'Implement CLI',
            description: 'Implement the CLI from the spec.',
            assignedAgent: 'codeWorker',
            dependsOn: [],
            allowedFiles: ['package.json', 'src/index.ts'],
            forbiddenActions: [],
            acceptanceCriteria: ['Status command works'],
            status: 'pending',
            createdAt: new Date().toISOString(),
          },
        ],
        totalTasks: 1,
        estimatedComplexity: 'low',
        createdAt: new Date().toISOString(),
      });
    },
  };

  await orchestrator._phaseTaskPlanning(makeState({ currentPhase: 'task_planning' }));

  assert.match(capturedMessages[1].content, /IMPORTANT REQ/);
});

test('autonomous architecture records assumptions instead of pausing for user input', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  orchestrator.ollama = {
    callWithFallback: async () => JSON.stringify({
      summary: 'Build a mobile arcade game.',
      technology: ['Expo', 'React Native', 'TypeScript'],
      projectStructure: ['package.json', 'src/App.tsx'],
      keyDecisions: ['Use one cross-platform codebase.'],
      constraints: ['Local-first build workflow.'],
      needUserInput: true,
      questions: ['Which visual style should the game use?'],
      readyToCode: false,
    }),
  };

  await orchestrator._phaseArchitecture(makeState({ currentPhase: 'architecture' }));

  const plan = JSON.parse(fs.readFileSync(orchestrator.workspace.architectJsonPath, 'utf8'));
  const assumptions = fs.readFileSync(orchestrator.workspace.assumptionsPath, 'utf8');

  assert.equal(plan.needUserInput, false);
  assert.equal(plan.readyToCode, true);
  assert.match(assumptions, /Which visual style should the game use/);
});

test('testing fails instead of completing when checks keep failing', async () => {
  const root = makeTempWorkspace();
  const terminal = makeTerminal({
    scripts: ['compile', 'test'],
    compileSuccess: false,
    testSuccess: false,
  });
  const orchestrator = await makeOrchestrator(root, {
    maxFixRetries: 0,
    terminal,
    testerOutput: {
      passed: false,
      testsRun: 1,
      errors: ['tests failed'],
      warnings: [],
      needsFix: true,
      fixDescription: 'Fix the failing checks.',
    },
  });

  await assert.rejects(
    () => orchestrator._phaseTesting(makeState()),
    /Project checks still fail after 0 fix attempt/
  );
});

test('testing fails when autonomous quality gate has no verification scripts', async () => {
  const root = makeTempWorkspace();
  const terminal = makeTerminal({ scripts: [] });
  const orchestrator = await makeOrchestrator(root, {
    terminal,
    testerOutput: {
      passed: true,
      testsRun: 0,
      errors: [],
      warnings: [],
      needsFix: false,
    },
  });

  await assert.rejects(
    () => orchestrator._phaseTesting(makeState()),
    /Project checks still fail after 0 fix attempt/
  );
});

test('testing uses xcode project verification when no package scripts exist', async () => {
  const root = makeTempWorkspace();
  fs.mkdirSync(path.join(root, 'TinyApp.xcodeproj'), { recursive: true });
  const terminal = makeTerminal({ scripts: [] });
  const orchestrator = await makeOrchestrator(root, {
    terminal,
    testerOutput: {
      passed: true,
      testsRun: 0,
      errors: [],
      warnings: [],
      needsFix: false,
    },
  });

  await orchestrator._phaseTesting(makeState());

  assert.deepEqual(terminal.commands, ['xcodebuild -list -project "TinyApp.xcodeproj"']);
});

test('testing continues with warning when fixer agent produces no output', async () => {
  const root = makeTempWorkspace();
  fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"compile":"node --check src/index.js","test":"node --test"}}');
  const terminal = makeTerminal({
    scripts: ['compile', 'test'],
    compileSuccess: false,
    testSuccess: false,
  });
  const orchestrator = await makeOrchestrator(root, {
    maxFixRetries: 1,
    terminal,
    testerOutput: {
      passed: false,
      testsRun: 1,
      errors: ['tests failed'],
      warnings: [],
      needsFix: true,
      fixDescription: 'Fix the failing checks.',
    },
  });
  orchestrator._executeFixer = async () => null;

  await orchestrator._phaseTesting(makeState());

  const testerNote = fs.readFileSync(orchestrator.workspace.testerPath, 'utf8');
  assert.match(testerNote, /Self-Healing Verification Warning/);
});

test('self-healing expands underspecified allowedFiles for safe task-local swift models', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const now = new Date().toISOString();
  const task = {
    id: 'task-002',
    title: 'Define Core Models',
    description: 'Create Swift model files under Core/Models for game domain objects.',
    assignedAgent: 'codeWorker',
    dependsOn: [],
    allowedFiles: ['Game.xcodeproj'],
    forbiddenActions: [],
    acceptanceCriteria: ['Core models exist'],
    status: 'in_progress',
    createdAt: now,
  };
  const output = {
    reasoning: 'Create individual model files.',
    files: [
      { path: 'Core/Models/Game.swift', action: 'create', content: 'struct Game {}' },
      { path: 'Core/Models/PlayerProfile.swift', action: 'create', content: 'struct PlayerProfile {}' },
    ],
    needUserInput: false,
    questions: [],
  };

  const added = orchestrator._selfHealAllowedFiles(task, output, 'codeWorker');
  const errors = orchestrator._validateTaskFileChanges(task, output);

  assert.deepEqual(added, ['Core/Models/Game.swift', 'Core/Models/PlayerProfile.swift']);
  assert.deepEqual(errors, []);
});

test('self-healing does not expand allowedFiles for unsafe paths or deletes', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const now = new Date().toISOString();
  const task = {
    id: 'task-unsafe',
    title: 'Define Core Models',
    description: 'Create Swift model files.',
    assignedAgent: 'codeWorker',
    dependsOn: [],
    allowedFiles: ['Game.xcodeproj'],
    forbiddenActions: [],
    acceptanceCriteria: [],
    status: 'in_progress',
    createdAt: now,
  };
  const output = {
    reasoning: 'Unsafe changes.',
    files: [
      { path: '.agent-workspace/project_state.json', action: 'create', content: '{}' },
      { path: 'Core/Models/Game.swift', action: 'delete' },
    ],
    needUserInput: false,
    questions: [],
  };

  const added = orchestrator._selfHealAllowedFiles(task, output, 'codeWorker');
  const errors = orchestrator._validateTaskFileChanges(task, output);

  assert.deepEqual(added, []);
  assert.equal(errors.length, 2);
});

test('test fixer receives a bounded allowedFiles list from changed files', async () => {
  const root = makeTempWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"compile":"node --check src/index.js","test":"node --test"}}');
  fs.writeFileSync(path.join(root, 'src/index.js'), 'module.exports = {};');
  fs.writeFileSync(path.join(root, 'test/index.test.js'), 'throw new Error("boom");');

  const terminal = makeTerminal({
    scripts: ['compile', 'test'],
    compileSuccess: true,
    testSuccess: false,
  });
  const orchestrator = await makeOrchestrator(root, {
    maxFixRetries: 1,
    terminal,
    testerOutput: {
      passed: false,
      testsRun: 1,
      errors: ['test/index.test.js failed'],
      warnings: [],
      needsFix: true,
      fixDescription: 'Fix the failing test file.',
    },
  });

  orchestrator.workspace.writeFile(orchestrator.workspace.taskResultsPath, JSON.stringify({
    results: {
      'task-001': {
        taskId: 'task-001',
        status: 'completed',
        files: [
          { path: 'package.json', action: 'create', content: '{}' },
          { path: 'src/index.js', action: 'create', content: '' },
          { path: 'test/index.test.js', action: 'create', content: '' },
        ],
        completedAt: new Date().toISOString(),
      },
    },
    updatedAt: new Date().toISOString(),
  }));

  let capturedAllowedFiles = null;
  orchestrator._executeFixer = async task => {
    capturedAllowedFiles = task.allowedFiles;
    return {
      reasoning: 'No-op for test.',
      files: [],
      needUserInput: false,
      questions: [],
    };
  };

  await assert.rejects(
    () => orchestrator._phaseTesting(makeState()),
    /Project checks still fail after 1 fix attempt/
  );

  assert.deepEqual(capturedAllowedFiles, [
    'package.json',
    'src/index.js',
    'test/index.test.js',
  ]);
});
