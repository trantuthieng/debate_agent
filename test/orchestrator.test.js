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

/** A minimal, valid 5-agent AgentTeamPlan for the given goal, staffed the way AgentFactory would. */
function makeTeamPlan(goal, generatedAt = new Date().toISOString()) {
  const roles = ['researcher', 'strategist', 'architect', 'builder', 'critic'];
  return {
    goal,
    rationale: 'Test team composed to cover the goal across complementary specialties.',
    agents: roles.map((role, i) => ({
      id: role,
      name: role[0].toUpperCase() + role.slice(1),
      specialty: `${role} specialty`,
      mission: `${role} mission`,
      systemPrompt: `You are the ${role}.`,
      model: `model-${role}`,
      fallbackModel: `model-${role}-fallback`,
      tools: [],
      temperature: 0.4,
      teamRole: role,
    })),
    generatedAt,
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

function makeSwiftOnlyTerminal() {
  return {
    detectPackageManager: () => 'npm',
    hasPackageScript: () => false,
    runSafeCommand: async command => {
      if (command.startsWith('swift ')) { return makeResult(command, true, 'swift-driver version 1.0'); }
      if (command.startsWith('xcodebuild')) { return makeResult(command, false, 'xcode-select: error'); }
      return makeResult(command, false, 'not found');
    },
    runTests: async () => makeResult('npm test', true, 'ok'),
  };
}

// Reproduces a real run: this constraint used to fire whenever Swift CLI tools
// were merely installed, worded as "All Apple platform projects MUST...", and
// a fixer working on an unrelated browser/Phaser.js game read it out of context
// and invented a Package.swift for it, which then got "swift test" wired up as
// the verification command and never passed.
test('the Swift/Package.swift toolchain constraint is not injected for a non-Apple project', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  orchestrator.terminal = makeSwiftOnlyTerminal();
  orchestrator.workspace.writeFile(orchestrator.workspace.projectBriefPath, JSON.stringify({
    projectName: 'brick-breaker-game',
    goal: 'Build a brick breaker browser game',
    appType: 'game',
    targetPlatforms: ['modern web browser'],
    chosenStack: ['JavaScript', 'Phaser.js', 'HTML5 Canvas'],
    coreFeatures: [], assumptions: [], nonGoals: [], acceptanceCriteria: [],
    deliveryArtifacts: [], buildAndRunCommands: [], verificationCommands: [],
  }));

  await orchestrator._phaseToolchainDiscovery(makeState({ currentPhase: 'toolchain_discovery' }));

  const assumptions = fs.readFileSync(orchestrator.workspace.assumptionsPath, 'utf8');
  assert.doesNotMatch(assumptions, /TOOLCHAIN CONSTRAINT/);
});

test('the Swift/Package.swift toolchain constraint IS injected for a genuine native Apple project', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  orchestrator.terminal = makeSwiftOnlyTerminal();
  orchestrator.workspace.writeFile(orchestrator.workspace.projectBriefPath, JSON.stringify({
    projectName: 'weather-app',
    goal: 'Build a native iOS weather app',
    appType: 'mobile',
    targetPlatforms: ['iOS'],
    chosenStack: ['Swift', 'SwiftUI'],
    coreFeatures: [], assumptions: [], nonGoals: [], acceptanceCriteria: [],
    deliveryArtifacts: [], buildAndRunCommands: [], verificationCommands: [],
  }));

  await orchestrator._phaseToolchainDiscovery(makeState({ currentPhase: 'toolchain_discovery' }));

  const assumptions = fs.readFileSync(orchestrator.workspace.assumptionsPath, 'utf8');
  assert.match(assumptions, /TOOLCHAIN CONSTRAINT/);
  assert.match(assumptions, /Package\.swift/);
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

// Boss feedback (2026-09-18): AgentFactory designs a bespoke specialist team
// (Researcher/Strategist/Architect/Builder/Critic/Verifier), but that team
// previously only ever debated the direction — every line of actual code was
// then written by one single generic codeWorker model, regardless of which
// specialist's domain a task fell into. These tests cover the fix: the task
// manager sees the designed roster and can assign a task to a specific
// specialist by id, and normalization only trusts an id that is really a
// member of the CURRENT run's team.
test('task planning surfaces the dynamic team roster so tasks can be assigned to the right specialist', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const state = makeState({ currentPhase: 'task_planning', createdAt: new Date(Date.now() - 5000).toISOString() });
  const plan = makeTeamPlan(state.projectGoal);
  orchestrator.workspace.writeFile(orchestrator.workspace.agentNotePath('dynamic_team_plan.json'), JSON.stringify(plan));

  let capturedMessages = null;
  orchestrator.ollama = {
    callWithFallback: async (_model, _fallback, messages) => {
      capturedMessages = messages;
      return JSON.stringify({
        tasks: [{
          id: 'task-001', title: 'Build the UI', description: 'd', assignedAgent: 'codeWorker',
          specialistId: 'builder', dependsOn: [], allowedFiles: ['src/ui.js'], forbiddenActions: [],
          acceptanceCriteria: ['works'], status: 'pending', createdAt: new Date().toISOString(),
        }],
        totalTasks: 1, estimatedComplexity: 'low', createdAt: new Date().toISOString(),
      });
    },
  };

  await orchestrator._phaseTaskPlanning(state);

  assert.match(capturedMessages[1].content, /Specialist Team Roster/);
  assert.match(capturedMessages[1].content, /id: "builder"/);
  assert.match(capturedMessages[1].content, /builder specialty/);
  const savedPlan = JSON.parse(fs.readFileSync(orchestrator.workspace.taskPlanPath, 'utf8'));
  assert.equal(savedPlan.tasks[0].specialistId, 'builder');
});

test('task planning omits the roster section and specialistId when no dynamic team was designed', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);

  let capturedMessages = null;
  orchestrator.ollama = {
    callWithFallback: async (_model, _fallback, messages) => {
      capturedMessages = messages;
      return JSON.stringify({
        tasks: [{
          id: 'task-001', title: 'Setup', description: 'd', assignedAgent: 'codeWorker',
          dependsOn: [], allowedFiles: ['package.json'], forbiddenActions: [],
          acceptanceCriteria: ['works'], status: 'pending', createdAt: new Date().toISOString(),
        }],
        totalTasks: 1, estimatedComplexity: 'low', createdAt: new Date().toISOString(),
      });
    },
  };

  await orchestrator._phaseTaskPlanning(makeState({ currentPhase: 'task_planning' }));

  assert.doesNotMatch(capturedMessages[1].content, /Specialist Team Roster/);
  const savedPlan = JSON.parse(fs.readFileSync(orchestrator.workspace.taskPlanPath, 'utf8'));
  assert.equal(savedPlan.tasks[0].specialistId, undefined);
});

test('task normalization drops a specialistId that is not a real member of the current team plan', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const task = {
    id: 'task-001', title: 'Build the UI', description: 'd', assignedAgent: 'codeWorker',
    specialistId: 'nonexistent-agent', dependsOn: [], allowedFiles: ['src/ui.js'], forbiddenActions: [],
    acceptanceCriteria: ['works'], status: 'pending', createdAt: '',
  };

  const validIds = new Set(['builder', 'critic']);
  const normalized = orchestrator._normalizeTaskItem(task, 0, new Date().toISOString(), validIds);

  assert.equal(normalized.specialistId, undefined);
  const assumptions = orchestrator.workspace.readFile(orchestrator.workspace.assumptionsPath) ?? '';
  assert.match(assumptions, /nonexistent-agent/);
  assert.match(assumptions, /not a member of the current team plan/);
});

test('task normalization keeps a specialistId that is a real member of the current team plan', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const task = {
    id: 'task-001', title: 'Build the UI', description: 'd', assignedAgent: 'codeWorker',
    specialistId: 'builder', dependsOn: [], allowedFiles: ['src/ui.js'], forbiddenActions: [],
    acceptanceCriteria: ['works'], status: 'pending', createdAt: '',
  };

  const normalized = orchestrator._normalizeTaskItem(task, 0, new Date().toISOString(), new Set(['builder', 'critic']));

  assert.equal(normalized.specialistId, 'builder');
});

test('coding routes a specialist-assigned task to that specialist\'s own model, framed but not replacing the code worker contract', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const state = makeState({ currentPhase: 'coding', createdAt: new Date(Date.now() - 5000).toISOString() });
  const plan = makeTeamPlan(state.projectGoal);
  orchestrator.workspace.writeFile(orchestrator.workspace.agentNotePath('dynamic_team_plan.json'), JSON.stringify(plan));
  orchestrator.toolRegistry = { manifestForPrompt: () => '' };

  let capturedModel, capturedFallback, capturedSystemPrompt;
  orchestrator.ollama = {
    callWithFallbackJson: async (model, fallback, messages) => {
      capturedModel = model; capturedFallback = fallback; capturedSystemPrompt = messages[0].content;
      return { reasoning: 'done', files: [{ path: 'src/ui.js', action: 'create', content: 'x' }], needUserInput: false, questions: [] };
    },
  };

  const task = {
    id: 'task-001', title: 'Build the UI', description: 'd', assignedAgent: 'codeWorker',
    specialistId: 'builder', dependsOn: [], allowedFiles: ['src/ui.js'], forbiddenActions: [],
    acceptanceCriteria: ['works'], status: 'pending', createdAt: new Date().toISOString(),
  };

  await orchestrator._executeCodeWorker(task, '', '', state);

  assert.equal(capturedModel, 'model-builder');
  assert.equal(capturedFallback, 'model-builder-fallback');
  assert.match(capturedSystemPrompt, /SPECIALIST ASSIGNMENT/);
  assert.match(capturedSystemPrompt, /Builder/);
  assert.match(capturedSystemPrompt, /builder specialty/);
});

test('coding falls back to the standard code worker model when a task has no specialist assigned', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const state = makeState({ currentPhase: 'coding' });
  orchestrator.toolRegistry = { manifestForPrompt: () => '' };

  let capturedModel;
  orchestrator.ollama = {
    callWithFallbackJson: async model => {
      capturedModel = model;
      return { reasoning: 'done', files: [{ path: 'src/index.js', action: 'create', content: 'x' }], needUserInput: false, questions: [] };
    },
  };

  const task = {
    id: 'task-001', title: 'Setup', description: 'd', assignedAgent: 'codeWorker',
    dependsOn: [], allowedFiles: ['src/index.js'], forbiddenActions: [],
    acceptanceCriteria: ['works'], status: 'pending', createdAt: new Date().toISOString(),
  };

  await orchestrator._executeCodeWorker(task, '', '', state);

  assert.equal(capturedModel, orchestrator.modelConfig.agents.codeWorker.model);
});

test('fixing a specialist-assigned task stays with the same specialist, not the generic fixer model', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const state = makeState({ currentPhase: 'fixing', createdAt: new Date(Date.now() - 5000).toISOString() });
  const plan = makeTeamPlan(state.projectGoal);
  orchestrator.workspace.writeFile(orchestrator.workspace.agentNotePath('dynamic_team_plan.json'), JSON.stringify(plan));
  orchestrator.toolRegistry = { manifestForPrompt: () => '' };

  let capturedModel, capturedFallback, capturedSystemPrompt;
  orchestrator.ollama = {
    callWithFallbackJson: async (model, fallback, messages) => {
      capturedModel = model; capturedFallback = fallback; capturedSystemPrompt = messages[0].content;
      return { reasoning: 'fixed', files: [{ path: 'src/ui.js', action: 'modify', content: 'x' }], needUserInput: false, questions: [] };
    },
  };

  const task = {
    id: 'task-001', title: 'Build the UI', description: 'd', assignedAgent: 'codeWorker',
    specialistId: 'builder', dependsOn: [], allowedFiles: ['src/ui.js'], forbiddenActions: [],
    acceptanceCriteria: ['works'], status: 'pending', createdAt: new Date().toISOString(),
  };
  const review = { taskId: task.id, approved: false, issues: ['broken'], suggestions: [], securityConcerns: [], needsFix: true, fixSuggestions: ['fix it'], reviewedAt: new Date().toISOString() };

  await orchestrator._executeFixer(task, review, state, false);

  assert.equal(capturedModel, 'model-builder');
  assert.equal(capturedFallback, 'model-builder-fallback');
  assert.match(capturedSystemPrompt, /SPECIALIST ASSIGNMENT/);
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

// Boss feedback (2026-09-18, part 2): specialist dispatch should not stop at
// coding/fixing — the SAME designed team already argued for this project's
// direction, so the planning phases (brief, architecture, task plan) should
// route to whichever specialist's teamRole naturally owns that phase (the
// "architect" teamRole specialist formalizes the architecture doc, etc.)
// instead of always using the fixed generic briefBuilder/architect/
// taskManager model, EVEN when a dynamic team was designed for this run.
test('architecture is routed to the team\'s "architect" specialist when a dynamic team was designed', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const state = makeState({ currentPhase: 'architecture', createdAt: new Date(Date.now() - 5000).toISOString() });
  const plan = makeTeamPlan(state.projectGoal);
  orchestrator.workspace.writeFile(orchestrator.workspace.agentNotePath('dynamic_team_plan.json'), JSON.stringify(plan));

  let capturedModel, capturedFallback, capturedSystemPrompt;
  orchestrator.ollama = {
    callWithFallback: async (model, fallback, messages) => {
      capturedModel = model; capturedFallback = fallback; capturedSystemPrompt = messages[0].content;
      return JSON.stringify({
        summary: 's', technology: ['t'], projectStructure: ['p'], keyDecisions: ['d'],
        constraints: [], needUserInput: false, questions: [], readyToCode: true,
      });
    },
  };

  await orchestrator._phaseArchitecture(state);

  assert.equal(capturedModel, 'model-architect');
  assert.equal(capturedFallback, 'model-architect-fallback');
  assert.match(capturedSystemPrompt, /SPECIALIST ASSIGNMENT/);
  assert.match(capturedSystemPrompt, /Architect/);
});

test('architecture uses the standard fixed model when no dynamic team was designed', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);

  let capturedModel;
  orchestrator.ollama = {
    callWithFallback: async model => {
      capturedModel = model;
      return JSON.stringify({
        summary: 's', technology: ['t'], projectStructure: ['p'], keyDecisions: ['d'],
        constraints: [], needUserInput: false, questions: [], readyToCode: true,
      });
    },
  };

  await orchestrator._phaseArchitecture(makeState({ currentPhase: 'architecture' }));

  assert.equal(capturedModel, orchestrator.modelConfig.agents.architect.model);
});

test('the project brief is routed to the team\'s "strategist" specialist when a dynamic team was designed', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const state = makeState({ currentPhase: 'briefing', createdAt: new Date(Date.now() - 5000).toISOString() });
  const plan = makeTeamPlan(state.projectGoal);
  orchestrator.workspace.writeFile(orchestrator.workspace.agentNotePath('dynamic_team_plan.json'), JSON.stringify(plan));

  let capturedModel, capturedSystemPrompt;
  orchestrator.ollama = {
    callWithFallbackJson: async (model, _fallback, messages) => {
      capturedModel = model; capturedSystemPrompt = messages[0].content;
      return {
        projectName: 'p', goal: 'g', appType: 'web', targetPlatforms: [], chosenStack: ['x'],
        coreFeatures: [], assumptions: [], nonGoals: [], acceptanceCriteria: ['a'],
        deliveryArtifacts: [], buildAndRunCommands: [], verificationCommands: [],
      };
    },
  };

  await orchestrator._phaseBriefing(state);

  assert.equal(capturedModel, 'model-strategist');
  assert.match(capturedSystemPrompt, /SPECIALIST ASSIGNMENT/);
  assert.match(capturedSystemPrompt, /Strategist/);
});

test('task planning model itself is routed to the team\'s "strategist" specialist', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const state = makeState({ currentPhase: 'task_planning', createdAt: new Date(Date.now() - 5000).toISOString() });
  const plan = makeTeamPlan(state.projectGoal);
  orchestrator.workspace.writeFile(orchestrator.workspace.agentNotePath('dynamic_team_plan.json'), JSON.stringify(plan));

  let capturedModel;
  orchestrator.ollama = {
    callWithFallback: async model => {
      capturedModel = model;
      return JSON.stringify({
        tasks: [{
          id: 'task-001', title: 't', description: 'd', assignedAgent: 'codeWorker',
          dependsOn: [], allowedFiles: ['x.js'], forbiddenActions: [], acceptanceCriteria: ['c'],
          status: 'pending', createdAt: new Date().toISOString(),
        }],
        totalTasks: 1, estimatedComplexity: 'low', createdAt: new Date().toISOString(),
      });
    },
  };

  await orchestrator._phaseTaskPlanning(state);

  assert.equal(capturedModel, 'model-strategist');
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
  orchestrator.workspace.writeFile(orchestrator.workspace.toolchainReportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    checks: [{ name: 'xcodebuild', command: 'xcodebuild -version', available: true }],
  }));

  await orchestrator._phaseTesting(makeState());

  assert.deepEqual(terminal.commands, ['xcodebuild -list -project "TinyApp.xcodeproj"']);
});

test('testing fails honestly when fixer agent produces no output', async () => {
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

  await assert.rejects(
    () => orchestrator._phaseTesting(makeState()),
    /fixer model produced no usable output/i
  );

  const testerNote = fs.readFileSync(orchestrator.workspace.testerPath, 'utf8');
  assert.match(testerNote, /Fixer Unavailable On Attempt 1/);
});

// The same retry loop had a second, identically-shaped gap a few lines above
// the one reproduced below: attempt 1 finding no safe target files used to
// abort the whole run instead of letting attempt 2+ try again.
test('a fix attempt that finds no safe target files retries instead of aborting the run', async () => {
  const root = makeTempWorkspace();
  const terminal = makeTerminal({
    scripts: ['compile', 'test'],
    compileSuccess: false,
    testSuccess: false,
  });
  const orchestrator = await makeOrchestrator(root, {
    maxFixRetries: 2,
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
  let fixerCalls = 0;
  orchestrator._executeFixer = async () => { fixerCalls += 1; return null; };
  orchestrator._collectTestFixAllowedFiles = () => [];

  await assert.rejects(
    () => orchestrator._phaseTesting(makeState()),
    /Project checks still fail after 2 fix attempt/
  );
  // The fixer was never even reachable (no safe files), but the loop still
  // ran both attempts rather than aborting after the first.
  assert.equal(fixerCalls, 0);
  const testerNote = fs.readFileSync(orchestrator.workspace.testerPath, 'utf8');
  assert.match(testerNote, /Fix Attempt 1 Had No Safe Target Files/);
  assert.match(testerNote, /Fix Attempt 2 Had No Safe Target Files/);
});

// A third instance of the same gap: the per-task coding-phase fixer loop
// already treats "unsafe file changes" as discard-and-retry (break, then
// deterministic recovery), never as a reason to kill the whole run — but this
// loop used to throw here instead, for no good reason once the other two
// spots in this same loop were fixed to retry.
test('a fix attempt producing unsafe file changes retries instead of aborting the run', async () => {
  const root = makeTempWorkspace();
  fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"compile":"node --check src/index.js","test":"node --test"}}');
  const terminal = makeTerminal({
    scripts: ['compile', 'test'],
    compileSuccess: false,
    testSuccess: false,
  });
  const orchestrator = await makeOrchestrator(root, {
    maxFixRetries: 2,
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
  orchestrator._executeFixer = async () => ({
    reasoning: 'Attempting a fix',
    files: [{ path: 'evil.sh', action: 'create', content: 'rm -rf /' }],
    needUserInput: false,
    questions: [],
  });
  orchestrator._validateTaskFileChanges = () => ['File "evil.sh" is outside the task allowedFiles list.'];

  await assert.rejects(
    () => orchestrator._phaseTesting(makeState()),
    /Project checks still fail after 2 fix attempt/
  );
  const testerNote = fs.readFileSync(orchestrator.workspace.testerPath, 'utf8');
  assert.match(testerNote, /Fix Attempt 1 Produced Unsafe File Changes/);
  assert.match(testerNote, /Fix Attempt 2 Produced Unsafe File Changes/);
});

// Reproduces a real run: the fixer's only proposed change on attempt 2 of an
// 8-attempt budget was a fragile diff to package.json that failed to apply
// (0 files applied), which used to throw and abort the entire workflow right
// there instead of just counting that as one failed attempt and retrying.
test('a fix attempt whose only change fails to apply retries instead of aborting the run', async () => {
  const root = makeTempWorkspace();
  fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"compile":"node --check src/index.js","test":"node --test"}}');
  const terminal = makeTerminal({
    scripts: ['compile', 'test'],
    compileSuccess: false,
    testSuccess: false,
  });
  const orchestrator = await makeOrchestrator(root, {
    maxFixRetries: 2,
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
  let fixerCalls = 0;
  orchestrator._executeFixer = async () => {
    fixerCalls += 1;
    return {
      reasoning: 'Attempting a fix',
      files: [{ path: 'package.json', action: 'modify', patch: 'not a real unified diff' }],
      needUserInput: false,
      questions: [],
    };
  };
  // Every attempt's only change fails to apply, exactly like a fragile diff
  // that gets skipped by the patch service, leaving nothing applied.
  orchestrator._applyCodeChanges = async () => false;

  await assert.rejects(
    () => orchestrator._phaseTesting(makeState()),
    /Project checks still fail after 2 fix attempt/
  );
  // Both attempts were actually tried — the first failed-apply did not abort early.
  assert.equal(fixerCalls, 2);
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

test('worker output normalization prevents missing files from crashing coding', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const now = new Date().toISOString();
  const task = {
    id: 'task-missing-files',
    title: 'Run checks',
    description: 'No file changes are required.',
    assignedAgent: 'codeWorker',
    dependsOn: [],
    allowedFiles: ['package.json'],
    forbiddenActions: [],
    acceptanceCriteria: [],
    status: 'in_progress',
    createdAt: now,
  };
  const output = {
    reasoning: undefined,
    needUserInput: true,
    questions: 'What should I do?',
  };

  orchestrator._normalizeAutonomousWorkerOutput('codeWorker', task, output);

  assert.deepEqual(output.files, []);
  assert.deepEqual(output.questions, []);
  assert.equal(output.needUserInput, false);
  assert.match(output.reasoning, /incomplete response/);
});

test('coding recovers a known CLI task when the model returns an empty files array', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  orchestrator.workspace.writeUserPrompt('Build a complete CLI called Focus Tool with add list done stats commands and node:test coverage.');
  const now = new Date().toISOString();
  const task = {
    id: 'task-empty-cli',
    title: 'Create project scaffold and scripts',
    description: 'Create a runnable command line tool.',
    assignedAgent: 'codeWorker',
    dependsOn: [],
    allowedFiles: ['package.json', 'src/cli.js', 'test/cli.test.js', 'README.md'],
    forbiddenActions: [],
    acceptanceCriteria: ['npm test passes'],
    status: 'pending',
    createdAt: now,
  };
  orchestrator.workspace.writeFile(orchestrator.workspace.taskPlanPath, JSON.stringify({
    tasks: [task],
    totalTasks: 1,
    estimatedComplexity: 'low',
    createdAt: now,
  }));
  orchestrator._executeCodeWorker = async () => ({
    reasoning: 'The implementation is complete.',
    files: [],
    needUserInput: false,
    questions: [],
  });
  orchestrator._executeReviewer = async () => ({
    taskId: task.id,
    approved: true,
    issues: [],
    suggestions: [],
    securityConcerns: [],
    needsFix: false,
    fixSuggestions: [],
    reviewedAt: new Date().toISOString(),
  });

  const state = makeState({ currentPhase: 'coding' });
  await orchestrator._phaseCoding(state);

  assert.deepEqual(state.completedTasks, [task.id]);
  assert.deepEqual(state.failedTasks, []);
  assert.ok(fs.existsSync(path.join(root, 'src/cli.js')));
  const result = cp.spawnSync('npm', ['test'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('resumed no-op reviews existing outputs and does not bypass a rejecting reviewer', async t => {
  for (const approved of [true, false]) {
    const root = makeTempWorkspace();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const agent = await makeOrchestrator(root);
    agent.modelConfig.selfHealing.allowProductTemplates = false;
    agent.fileManager.writeWorkspaceFile('src/main.js', 'module.exports = 42;\n');
    const task = { id: 'existing', title: 'Existing implementation', description: 'Verify implementation',
      allowedFiles: ['src/main.js'], dependsOn: [], forbiddenActions: [], acceptanceCriteria: ['Meets the task'],
      status: 'pending', assignedAgent: 'codeWorker', createdAt: new Date().toISOString() };
    agent.workspace.writeFile(agent.workspace.taskPlanPath, JSON.stringify({ tasks: [task], totalTasks: 1 }));
    agent._executeCodeWorker = async () => ({ reasoning: 'Already implemented', files: [], needUserInput: false, questions: [] });
    let reviewed = 0;
    agent._executeReviewer = async (_, output) => {
      reviewed++;
      assert.equal(output.files[0].content, 'module.exports = 42;\n');
      return { approved, needsFix: !approved, issues: approved ? [] : ['Incorrect behavior'], suggestions: [], fixSuggestions: [], securityConcerns: [] };
    };
    agent._applyCodeChanges = async () => { assert.fail('Review-only snapshots must not be written'); };
    agent._runMicroSprintChecks = async () => {};
    const state = makeState({ currentPhase: 'coding', activeTasks: [task.id] });
    if (approved) { await agent._phaseCoding(state); }
    else { await assert.rejects(agent._phaseCoding(state), /Build is not viable/); }
    assert.equal(reviewed, 1);
    assert.deepEqual(state.completedTasks, approved ? [task.id] : []);
    assert.equal(agent.fileManager.readWorkspaceFile('src/main.js'), 'module.exports = 42;\n');
    assert.equal(agent._existingTaskReviewOutput({ allowedFiles: ['src/main.js', 'missing.js'] }, { files: [] }), null);
    agent.fileManager.writeWorkspaceFile('empty.js', '');
    assert.equal(agent._existingTaskReviewOutput({ allowedFiles: ['empty.js'] }, { files: [] }), null);
  }
});

test('patch application blocks stale file baselines instead of overwriting user edits', async () => {
  const root = makeTempWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/index.js'), 'module.exports = "before";\n');
  const orchestrator = await makeOrchestrator(root);
  const output = {
    reasoning: 'Update implementation.',
    files: [
      { path: 'src/index.js', action: 'modify', content: 'module.exports = "agent";\n' },
    ],
    needUserInput: false,
    questions: [],
  };

  const baseline = orchestrator._captureFileBaselines(['src/index.js'], 'task-stale', 'codeWorker');
  orchestrator._attachChangeBaseline(output, baseline);
  fs.writeFileSync(path.join(root, 'src/index.js'), 'module.exports = "user edit";\n');

  const applied = await orchestrator._applyCodeChanges('patch-stale', output, makeState({ currentPhase: 'coding' }));

  assert.equal(applied, false);
  assert.equal(fs.readFileSync(path.join(root, 'src/index.js'), 'utf8'), 'module.exports = "user edit";\n');
  const memoryEvents = fs.readFileSync(orchestrator.workspace.memoryEventsPath, 'utf8');
  assert.match(memoryEvents, /blocked because target files changed/);
});

test('a directory-scaffold entry ("src/") creates a real directory, not an empty file that later breaks writes', async () => {
  // Reproduces a real failure: the code worker's file list included a
  // directory-only scaffold entry from the project structure ("src/",
  // "public/", "styles/"). Writing it as a literal empty file left `src`
  // unable to hold `src/game.js`, failing with ENOTDIR.
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const scaffold = {
    reasoning: 'Create project structure.',
    files: [
      { path: 'src/', action: 'create', content: '' },
      { path: 'public/', action: 'create', content: '' },
    ],
    needUserInput: false,
    questions: [],
  };
  const applied = await orchestrator._applyCodeChanges('patch-scaffold', scaffold, makeState({ currentPhase: 'coding' }));
  assert.equal(applied, true);
  assert.equal(fs.statSync(path.join(root, 'src')).isDirectory(), true);
  assert.equal(fs.statSync(path.join(root, 'public')).isDirectory(), true);

  // A later task writing a real file inside that directory must succeed.
  const followUp = {
    reasoning: 'Add game entry point.',
    files: [{ path: 'src/game.js', action: 'create', content: 'console.log("game");\n' }],
    needUserInput: false,
    questions: [],
  };
  const appliedFollowUp = await orchestrator._applyCodeChanges('patch-followup', followUp, makeState({ currentPhase: 'coding' }));
  assert.equal(appliedFollowUp, true);
  assert.equal(fs.readFileSync(path.join(root, 'src/game.js'), 'utf8'), 'console.log("game");\n');
});

test('re-creating an already-existing directory-scaffold entry across sprints is not blocked as a baseline conflict', async () => {
  // Reproduces a real failure: sprint 1 created src/; sprint 2's fresh task
  // plan re-listed "src/" as a create-without-baseline (a fresh planning
  // cycle has no read baseline for it), which the safety guard treated as an
  // unsafe overwrite and blocked — skipping every dependent task and failing
  // the whole sprint even though nothing would actually have been overwritten.
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });

  const sprintTwoScaffold = {
    reasoning: 'Re-affirm project structure.',
    files: [{ path: 'src/', action: 'create', content: '' }],
    needUserInput: false,
    questions: [],
  };
  const applied = await orchestrator._applyCodeChanges('patch-sprint-2-scaffold', sprintTwoScaffold, makeState({ currentPhase: 'coding' }));
  assert.equal(applied, true, 'a directory marker for an existing directory must never be treated as an overwrite conflict');

  // A real file still gets the full baseline-conflict protection.
  fs.writeFileSync(path.join(root, 'src/existing.js'), 'module.exports = "real file";\n');
  const conflicting = {
    reasoning: 'Recreate an existing real file without reading it first.',
    files: [{ path: 'src/existing.js', action: 'create', content: 'overwritten' }],
    needUserInput: false,
    questions: [],
  };
  const appliedConflict = await orchestrator._applyCodeChanges('patch-conflict', conflicting, makeState({ currentPhase: 'coding' }));
  assert.equal(appliedConflict, false, 'a real file without a baseline must still be protected');
  assert.equal(fs.readFileSync(path.join(root, 'src/existing.js'), 'utf8'), 'module.exports = "real file";\n');
});

test('tester receives a focused diagnostic bundle before raw logs', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  let capturedMessages = null;
  orchestrator.ollama = {
    callWithFallbackJson: async (_model, _fallback, messages) => {
      capturedMessages = messages;
      return {
        passed: false,
        testsRun: 1,
        errors: ['TypeError in test/cli.test.js'],
        warnings: [],
        needsFix: true,
        fixDescription: 'Fix src/cli.js export used by test/cli.test.js.',
      };
    },
  };

  const result = await orchestrator._analyzeProjectChecks({
    compileResult: null,
    testResult: makeResult('npm test', false, 'TypeError: runCli is not a function\n    at test/cli.test.js:3:1'),
    output: '## Tests\nCommand: npm test\nExit: 1\nTypeError: runCli is not a function\n    at test/cli.test.js:3:1',
    failed: true,
    failedCommands: ['npm test'],
    skippedChecks: ['compile/build script not found'],
  });

  assert.equal(result.needsFix, true);
  assert.match(capturedMessages[1].content, /# Diagnostic Bundle/);
  assert.match(capturedMessages[1].content, /Likely files: test\/cli.test.js/);
  assert.match(capturedMessages[1].content, /Failed commands: npm test/);
});

test('workflow router skips debate for focused maintenance prompts', async () => {
  const root = makeTempWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/index.js'), 'module.exports = {};\n');
  const orchestrator = await makeOrchestrator(root);

  const route = orchestrator._selectWorkflowRoute(makeState({
    projectGoal: 'Fix the failing node:test coverage in src/index.js.',
  }));

  assert.equal(route.kind, 'maintenance');
  assert.equal(route.skipDebate, true);
});

test('static quality gate blocks dependency-free Node projects with external imports and Jest tests', async () => {
  const root = makeTempWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    scripts: { test: 'node --test test/*.test.js' },
  }));
  fs.writeFileSync(path.join(root, 'src/cli.js'), "const { program } = require('commander');\n");
  fs.writeFileSync(path.join(root, 'test/cli.test.js'), "describe('cli', () => { it('works', () => expect(true).toBe(true)); });\n");

  const orchestrator = await makeOrchestrator(root);
  orchestrator.workspace.writeUserPrompt('Build a dependency-free Node.js CLI with no external runtime dependencies and node:test tests.');

  const result = orchestrator._runStaticQualityGate();

  assert.equal(result.failed, true);
  assert.match(result.output, /commander/);
  assert.match(result.output, /Jest-style globals/);
});

test('task normalization removes contradictory forbidden actions for required files', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const task = {
    id: 'task-setup',
    title: 'Setup project',
    description: 'Create package metadata.',
    assignedAgent: 'codeWorker',
    dependsOn: [],
    allowedFiles: ['package.json', 'README.md'],
    forbiddenActions: ['do not modify package.json'],
    acceptanceCriteria: ['package.json contains start and test scripts'],
    status: 'pending',
    createdAt: '',
  };

  const normalized = orchestrator._normalizeTaskItem(task, 0, new Date().toISOString());

  assert.deepEqual(normalized.forbiddenActions, []);
  assert.deepEqual(normalized.allowedFiles, ['package.json', 'README.md']);
});

// Reproduces a real failed run (2026-09-17): the task plan assigned
// src/assets/spritesheet.png to task-001. A text-only code worker always
// writes such a file 0 bytes; the heuristic "file is empty" review issue
// then recurred identically across every fix attempt, tripping the stuck-loop
// guard and failing the whole build (0/5 tasks) over a plan step no model
// could ever satisfy. Task normalization must strip binary asset paths
// before a code worker is ever asked to author them.
test('task normalization strips binary asset paths a text-only model cannot author', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const task = {
    id: 'sprint-01-task-001',
    title: 'Setup project structure and initial files',
    description: 'Create the basic project structure.',
    assignedAgent: 'codeWorker',
    dependsOn: [],
    allowedFiles: [
      'index.html', 'src/game.js', 'src/levels.json',
      'src/assets/spritesheet.png', 'src/assets/spritesheet.json',
      'src/assets/theme.mp3', 'README.md', 'package.json',
    ],
    forbiddenActions: [],
    acceptanceCriteria: ['Project structure is created with all necessary directories and files'],
    status: 'pending',
    createdAt: '',
  };

  const normalized = orchestrator._normalizeTaskItem(task, 0, new Date().toISOString());

  assert.deepEqual(normalized.allowedFiles, [
    'index.html', 'src/game.js', 'src/levels.json',
    'src/assets/spritesheet.json', 'README.md', 'package.json',
  ]);
  const assumptions = orchestrator.workspace.readFile(orchestrator.workspace.assumptionsPath) ?? '';
  assert.match(assumptions, /spritesheet\.png/);
  assert.match(assumptions, /procedurally/);
});

// Reproduces a real failed run (2026-09-18, re-run after the fix above): with
// the binary-asset bug fixed, task-001 failed a DIFFERENT way — the task
// manager (violating its own rule 9) wrote acceptance criteria "All required
// files are present and empty." No matter what the code worker did, the
// heuristic "file is empty" review check (correctly) rejected it identically
// on every fix attempt, tripping the stuck-loop guard and failing the whole
// build (0/30 tasks) over a task that was unwinnable by construction.
test('task normalization reconciles acceptance criteria that contradict the "no empty files" review rule', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const task = {
    id: 'sprint-01-task-001',
    title: 'Create initial project structure',
    description: 'Set up the project with the required directory structure and initial files.',
    assignedAgent: 'codeWorker',
    dependsOn: [],
    allowedFiles: ['src/main.js', 'src/gameLoop.js'],
    forbiddenActions: [],
    acceptanceCriteria: ['Project structure matches the architecture plan', 'All required files are present and empty'],
    status: 'pending',
    createdAt: '',
  };

  const normalized = orchestrator._normalizeTaskItem(task, 0, new Date().toISOString());

  // Original wording is kept (it may carry other real information) but a
  // corrective criterion is appended so the task is actually achievable.
  assert.ok(normalized.acceptanceCriteria.includes('All required files are present and empty'));
  assert.ok(normalized.acceptanceCriteria.some(c => /real, minimal, working content/.test(c)));
  const assumptions = orchestrator.workspace.readFile(orchestrator.workspace.assumptionsPath) ?? '';
  assert.match(assumptions, /empty.*blank|blank.*empty/i);
});

test('task normalization leaves ordinary acceptance criteria untouched (no false positive on unrelated "empty" mentions)', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const task = {
    id: 'task-001',
    title: 'Validate form input',
    description: 'd',
    assignedAgent: 'codeWorker',
    dependsOn: [],
    allowedFiles: ['src/form.js'],
    forbiddenActions: [],
    acceptanceCriteria: ['Shows a validation error when the input field is empty', 'src/form.js exports a validate function'],
    status: 'pending',
    createdAt: '',
  };

  const normalized = orchestrator._normalizeTaskItem(task, 0, new Date().toISOString());

  assert.deepEqual(normalized.acceptanceCriteria, task.acceptanceCriteria);
});

test('every phase change and error is pushed to Telegram so the boss can follow a run from their phone', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const sent = [];
  orchestrator.telegram.notify = message => sent.push(message);

  orchestrator._setPhase(makeState(), 'coding', 'Code Workers: Executing tasks...');
  orchestrator._emit('error', 'Task "task-001" produced unsafe file changes: nope.');

  assert.equal(sent.length, 2);
  assert.match(sent[0], /coding/i);
  assert.match(sent[0], /Executing tasks/);
  assert.match(sent[1], /^❌/);
  assert.match(sent[1], /task-001/);
});

test('Telegram notify() is never called synchronously when unconfigured (no crash without credentials)', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);

  assert.equal(orchestrator.telegram.isConfigured, false);
  assert.doesNotThrow(() => orchestrator._setPhase(makeState(), 'architecture', 'deciding stack'));
});

test('sprint task scoping prevents repeated planning cycles from colliding', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const now = new Date().toISOString();
  const plan = {
    tasks: [
      {
        id: 'task-001',
        title: 'Setup',
        description: 'Create setup files.',
        assignedAgent: 'codeWorker',
        dependsOn: [],
        allowedFiles: ['package.json'],
        forbiddenActions: [],
        acceptanceCriteria: ['package exists'],
        status: 'completed',
        createdAt: now,
        completedAt: now,
        error: 'old error',
      },
      {
        id: 'task-002',
        title: 'Feature',
        description: 'Create feature files.',
        assignedAgent: 'codeWorker',
        dependsOn: ['task-001'],
        allowedFiles: ['src/index.js'],
        forbiddenActions: [],
        acceptanceCriteria: ['feature exists'],
        status: 'pending',
        createdAt: now,
      },
    ],
    totalTasks: 2,
    estimatedComplexity: 'low',
    createdAt: now,
  };
  orchestrator.workspace.writeFile(orchestrator.workspace.taskPlanPath, JSON.stringify(plan, null, 2));

  orchestrator._scopeTaskPlanForSprint(2);

  const scoped = JSON.parse(fs.readFileSync(orchestrator.workspace.taskPlanPath, 'utf8'));
  assert.deepEqual(scoped.tasks.map(task => task.id), ['sprint-02-task-001', 'sprint-02-task-002']);
  assert.deepEqual(scoped.tasks[1].dependsOn, ['sprint-02-task-001']);
  assert.equal(scoped.tasks[0].status, 'pending');
  assert.equal(scoped.tasks[0].completedAt, undefined);
  assert.equal(scoped.tasks[0].error, undefined);
});

test('improvement consensus stops only when all brainstorm agents agree no work remains', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const stopConsensus = [
    { agentRole: 'brainstorm', readyToStop: true, confidence: 'high', remainingWork: [], nextSprintGoal: '', rationale: 'done' },
    { agentRole: 'critic', readyToStop: true, confidence: 'high', remainingWork: [], nextSprintGoal: '', rationale: 'done' },
    { agentRole: 'secondBrainstorm', readyToStop: true, confidence: 'high', remainingWork: [], nextSprintGoal: '', rationale: 'done' },
  ];
  const continueConsensus = [
    ...stopConsensus.slice(0, 2),
    { agentRole: 'secondBrainstorm', readyToStop: false, confidence: 'medium', remainingWork: ['Improve onboarding'], nextSprintGoal: 'Add onboarding polish', rationale: 'useful' },
  ];

  assert.equal(orchestrator._consensusReadyToStop(stopConsensus), true);
  assert.equal(orchestrator._consensusReadyToStop(continueConsensus), false);
});

// Reproduces a real run: three model-based retrospective agents (brainstorm,
// critic, secondBrainstorm) all unanimously claimed "all 20 levels work" for a
// game that actually shipped invalid JSON with a "// Add 19 more levels here"
// stub comment. A deterministic, model-independent scan now re-checks every
// changed file's current on-disk content and overrides a false STOP verdict.
test('a deterministic structural scan overrides a unanimous but wrong "ready to stop" verdict', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);

  fs.writeFileSync(
    path.join(root, 'levels.json'),
    '[\n  {"level": 1}\n  // Add 19 more levels here\n]\n'
  );
  orchestrator.workspace.writeFile(
    orchestrator.workspace.taskResultsPath,
    JSON.stringify({
      results: {
        'sprint-01-task-001': {
          taskId: 'sprint-01-task-001',
          status: 'completed',
          completedAt: new Date().toISOString(),
          files: [{ path: 'levels.json', action: 'create' }],
        },
      },
      updatedAt: new Date().toISOString(),
    })
  );

  // All three retrospective agents hallucinate a confident "done" verdict,
  // exactly as happened in the real run — they never saw the file content
  // before this fix, and even now a model could still get it wrong, so the
  // deterministic scan must not depend on them getting it right.
  orchestrator.ollama = {
    callWithFallbackJson: async () => ({
      readyToStop: true,
      confidence: 'high',
      remainingWork: [],
      nextSprintGoal: '',
      rationale: 'All 20 levels work correctly.',
    }),
  };

  const consensus = await orchestrator._phaseImprovementConsensus(makeState(), 1);

  assert.equal(orchestrator._consensusReadyToStop(consensus), false);
  assert.ok(consensus.every(item => item.readyToStop === false));
  assert.ok(consensus.every(item => item.remainingWork.some(w => w.includes('levels.json') && w.includes('not valid JSON'))));
});

test('debate scoring aggregates the panel and selects the highest-scored direction', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const panel = [
    { agentRole: 'brainstorm', scores: { feasibility: 8, completeness: 8, risk: 8, ux: 8, quality: 8 }, overall: 8, recommendation: 'Direction A', topRisk: 'r' },
    { agentRole: 'critic', scores: { feasibility: 9, completeness: 9, risk: 9, ux: 9, quality: 9 }, overall: 9, recommendation: 'Direction B (best)', topRisk: 'r' },
    { agentRole: 'secondBrainstorm', scores: { feasibility: 7, completeness: 7, risk: 7, ux: 7, quality: 7 }, overall: 7, recommendation: 'Direction C', topRisk: 'r' },
    { agentRole: 'architect', scores: { feasibility: 8, completeness: 8, risk: 8, ux: 8, quality: 8 }, overall: 8, recommendation: 'Direction D', topRisk: 'r' },
    { agentRole: 'reviewer', scores: { feasibility: 8, completeness: 8, risk: 8, ux: 8, quality: 8 }, overall: 8, recommendation: 'Direction E', topRisk: 'r' },
  ];

  const decision = orchestrator._aggregateDebateScores(panel);

  assert.equal(decision.judgeCount, 5);
  assert.equal(decision.winningDirection, 'Direction B (best)');
  assert.equal(decision.weightedScore, 8); // mean of 8,9,7,8,8
  assert.equal(decision.agreement, 'high'); // tight spread
  assert.equal(decision.rankedRecommendations[0].agentRole, 'critic');
});

test('debate scoring reports low agreement when the panel disagrees and handles an empty panel', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const split = [
    { agentRole: 'brainstorm', scores: { feasibility: 1, completeness: 1, risk: 1, ux: 1, quality: 1 }, overall: 1, recommendation: 'Low' },
    { agentRole: 'critic', scores: { feasibility: 10, completeness: 10, risk: 10, ux: 10, quality: 10 }, overall: 10, recommendation: 'High (winner)' },
  ];
  const decision = orchestrator._aggregateDebateScores(split);
  assert.equal(decision.agreement, 'low');
  assert.equal(decision.winningDirection, 'High (winner)');

  const empty = orchestrator._aggregateDebateScores([]);
  assert.equal(empty.judgeCount, 0);
  assert.equal(empty.weightedScore, 0);
});

test('debate score normalization clamps out-of-range values and derives a missing overall', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const normalized = orchestrator._normalizeDebateScore('architect', {
    scores: { feasibility: 99, completeness: -4, risk: 'bad', ux: 6, quality: 6 },
  });
  assert.equal(normalized.scores.feasibility, 10);
  assert.equal(normalized.scores.completeness, 0);
  assert.equal(normalized.scores.risk, 5); // non-numeric falls back to 5
  // overall derived from mean of (10,0,5,6,6) = 5.4
  assert.equal(normalized.overall, 5.4);
  assert.equal(normalized.agentRole, 'architect');
});

test('debate panel guard guarantees five distinct judge models even when roles share one', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  // Force a collision: critic and reviewer share the same primary model.
  orchestrator.modelConfig.agents.reviewer.model = 'critic';
  orchestrator.modelConfig.agents.reviewer.fallbackModel = 'critic';

  const panelRoles = ['brainstorm', 'critic', 'secondBrainstorm', 'architect', 'reviewer'];
  const { assignments, distinctCount } = orchestrator._assignDiversePanelModels(panelRoles);

  const models = panelRoles.map(r => assignments.get(r).model);
  assert.equal(distinctCount, 5, `expected 5 distinct models, got ${models.join(', ')}`);
  assert.equal(new Set(models).size, 5);
  // The colliding reviewer judge borrowed a different, still-unused model.
  assert.notEqual(assignments.get('reviewer').model, assignments.get('critic').model);
});

test('issue signature normalizes numbers so recurring failures are detected as no-progress', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);

  const a = orchestrator._issueSignature({ issues: ['Failed at line 12'], securityConcerns: [] });
  const b = orchestrator._issueSignature({ issues: ['Failed at line 99'], securityConcerns: [] });
  const c = orchestrator._issueSignature({ issues: ['A totally different problem'], securityConcerns: [] });

  assert.equal(a, b, 'same issue with different line numbers must share a signature');
  assert.notEqual(a, c, 'different issues must have different signatures');
});

test('review normalization coerces non-string arrays so the fix loop never crashes on bad model output', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);

  // Reproduce the real black-box crash: a local model returned `uncertainties`
  // (and other fields) as arrays of OBJECTS, not strings. Before the fix this
  // killed the entire 65-minute run with "s.trim is not a function".
  const review = {
    issues: [{ detail: 'logic bug' }, 'a string issue'],
    securityConcerns: [{ kind: 'injection' }],
    suggestions: [{ note: 'rename x' }],
    fixSuggestions: [{ step: 'do y' }],
    uncertainties: [{ q: 'is the API stable?' }, 42],
    approved: false,
  };
  // Must not throw, and every array must become strings.
  orchestrator._normalizeReviewResult({ id: 'task-001' }, review);
  for (const field of ['issues', 'securityConcerns', 'suggestions', 'fixSuggestions', 'uncertainties']) {
    assert.ok(review[field].every(x => typeof x === 'string'), `${field} must be all strings`);
  }
  // _issueSignature and _mergeReviewWithAudit must survive raw, un-normalized objects too.
  assert.doesNotThrow(() =>
    orchestrator._issueSignature({ issues: [{ x: 1 }], securityConcerns: [{ y: 2 }] }));
  const merged = orchestrator._mergeReviewWithAudit(
    { id: 'task-001' },
    review,
    { issues: [{ bad: 1 }], suggestions: [{ bad: 2 }], securityConcerns: [{ bad: 3 }], fixSuggestions: [{ bad: 4 }], uncertainties: [{ bad: 5 }] }
  );
  assert.ok(merged.uncertainties.every(x => typeof x === 'string'));
  assert.ok(merged.issues.every(x => typeof x === 'string'));
});

test('a fragile diff edit does not discard the good new files in the same batch', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  // The real black-box batch: 5 substantive CREATE files + one MODIFY README
  // diff whose context no longer matches. The whole task previously failed and
  // git stayed clean. Now the CREATE files must land; the bad diff is skipped.
  fs.writeFileSync(path.join(root, 'README.md'), '# Existing readme\n\nNothing here matches.\n');
  const workerOutput = {
    files: [
      { path: 'main.py', action: 'create', content: 'print("hello")\n' },
      { path: 'requirements.txt', action: 'create', content: 'requests==2.31.0\n' },
      {
        path: 'README.md',
        action: 'modify',
        patch: '--- a/README.md\n+++ b/README.md\n@@ -10,1 +10,2 @@\n CONTEXT_THAT_DOES_NOT_EXIST\n+new line',
      },
    ],
    reasoning: 'scaffold',
  };

  // The worker read README before editing it (real runs always do), so attach
  // a baseline; otherwise the "modified a file it never read" guard fires first.
  orchestrator._attachChangeBaseline(
    workerOutput,
    orchestrator._captureFileBaselines(['README.md'], 'task-001-test', 'codeWorker')
  );

  const state = orchestrator.workspace.readProjectState();
  const applied = await orchestrator._applyCodeChanges('task-001-test', workerOutput, state);

  assert.equal(applied, true, 'batch must succeed because the substantive files landed');
  assert.equal(fs.readFileSync(path.join(root, 'main.py'), 'utf8'), 'print("hello")\n');
  assert.equal(fs.readFileSync(path.join(root, 'requirements.txt'), 'utf8'), 'requests==2.31.0\n');
  // The unmatchable README diff was skipped, leaving the file untouched.
  assert.match(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), /Nothing here matches/);
});

test('a filesystem hiccup while persisting a failed state does not crash the error handler', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);

  // Reproduces a real failure from a live run: the workspace directory
  // (on a cloud-synced volume) briefly disappeared exactly while the
  // orchestrator tried to record that the run had failed, turning an honest
  // failure into an uncaught crash that left project_state.json stuck
  // showing "running" forever.
  fs.rmSync(path.join(root, '.agent-workspace'), { recursive: true, force: true });

  assert.doesNotThrow(() => orchestrator._handleTopLevelError(new Error('Ollama crashed mid-debate')));
});

test('InsufficientResourcesError is an honest stop that surfaces the full resource advisory', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const { InsufficientResourcesError } = require('../out/utils/errors');
  let emitted = '';
  orchestrator.setCallbacks({ onError: msg => { emitted = msg; } });

  orchestrator._handleTopLevelError(new InsufficientResourcesError(
    'Not enough free memory headroom to safely start a five-model run.',
    'Biggest RAM users right now:\n  - Microsoft Edge: ~2000 MB'
  ));

  assert.match(emitted, /Not enough free memory headroom/);
  assert.match(emitted, /Biggest RAM users/);
  const state = orchestrator.workspace.readProjectState();
  assert.equal(state.status, 'failed');
});

// A pre-flight gate (resource check, model readiness, missing capability) can
// fire BEFORE _runWorkflow — and therefore before its own try/catch — ever
// starts. That failure used to reach the boss only via the transient onError
// callback and never appear in AGENT_JOURNAL.md, leaving no durable record of
// why a run never got past its pre-flight checks. _handleTopLevelError must
// now always leave a journal entry, regardless of which gate stopped the run
// or whether the journal file existed yet.
test('a pre-flight gate failure is always recorded in AGENT_JOURNAL.md, even if the journal never existed yet', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const { InsufficientResourcesError, MissingCapabilityError } = require('../out/utils/errors');

  // Simulate a run that failed before initializeJournal() was ever reached.
  fs.rmSync(orchestrator.workspace.journalPath, { force: true });
  assert.equal(fs.existsSync(orchestrator.workspace.journalPath), false);

  orchestrator._handleTopLevelError(new InsufficientResourcesError(
    'Not enough free memory headroom to safely start a five-model run.',
    'Biggest RAM users right now:\n  - Microsoft Edge: ~2000 MB'
  ));

  let journal = fs.readFileSync(orchestrator.workspace.journalPath, 'utf8');
  assert.match(journal, /insufficient resources/i);
  assert.match(journal, /Not enough free memory headroom/);

  orchestrator._handleTopLevelError(new MissingCapabilityError('Missing YouTube API credentials.', []));
  journal = fs.readFileSync(orchestrator.workspace.journalPath, 'utf8');
  assert.match(journal, /missing capability/i);
  assert.match(journal, /Missing YouTube API credentials/);

  orchestrator._handleTopLevelError(new Error('Ollama crashed mid-debate'));
  journal = fs.readFileSync(orchestrator.workspace.journalPath, 'utf8');
  assert.match(journal, /Workflow stopped with an error/);
  assert.match(journal, /Ollama crashed mid-debate/);
});

test('RAM optimization is never applied without an explicit boss approval', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const proposal = {
    id: 'ram-1',
    currentFreeMb: 5000,
    targetFreeMb: 20 * 1024,
    apps: [{ name: 'Microsoft Edge', residentMb: 3000 }],
  };
  let notified = null;
  orchestrator.setCallbacks({ onRamOptimizationNeeded: p => { notified = p; } });

  const pending = orchestrator._requestRamOptimization(proposal);
  assert.deepEqual(notified, proposal);
  orchestrator.resolveRamOptimization('ram-1', true);

  assert.equal(await pending, true);
});

test('RAM optimization defaults to declined if the boss never answers (timeout)', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  orchestrator._ramOptimizationTimeoutMs = 1;

  const approved = await orchestrator._requestRamOptimization({
    id: 'ram-2', currentFreeMb: 1000, targetFreeMb: 20 * 1024, apps: [{ name: 'Calendar', residentMb: 500 }],
  });
  assert.equal(approved, false);
});

test('aborting a run declines any still-pending RAM optimization request instead of closing apps', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const pending = orchestrator._requestRamOptimization({
    id: 'ram-3', currentFreeMb: 1000, targetFreeMb: 20 * 1024, apps: [{ name: 'Calendar', residentMb: 500 }],
  });
  orchestrator._clearPendingApprovals(true); // an abort resolves patch/command approvals as `approved`...
  // ...but RAM optimization must still come back false regardless, since closing
  // apps is never a side effect of aborting.
  assert.equal(await pending, false);
});

test('fallback project structure trusts the brief\'s own deliveryArtifacts over an appType guess', async () => {
  // Reproduces a real failure: the real brief model correctly classified a
  // browser game's deliveryArtifacts as HTML5/Phaser.js files but labeled
  // appType "web" (not "game"). A later sprint's task-planning self-heal
  // ignored deliveryArtifacts and used an appType-only heuristic that does
  // not recognize "web" as a game, falling through to an unrelated
  // React+Vite+TypeScript scaffold and corrupting the project with two
  // incompatible tech stacks.
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const brief = {
    projectName: 'brick-breaker-game',
    goal: 'Build a brick breaker (Arkanoid-style) browser game with 30 different levels.',
    appType: 'web',
    targetPlatforms: ['all modern web browsers'],
    chosenStack: ['HTML5', 'CSS3', 'JavaScript', 'Phaser.js'],
    coreFeatures: ['30 levels of increasing difficulty'],
    assumptions: [],
    nonGoals: [],
    acceptanceCriteria: [],
    deliveryArtifacts: ['package.json', 'index.html', 'styles.css', 'src/logic.js', 'src/render.js', 'src/app.js', 'test/logic.test.js', 'README.md'],
    buildAndRunCommands: ['npm install'],
    verificationCommands: ['npm test'],
  };

  const structure = orchestrator._fallbackProjectStructure(brief);
  assert.deepEqual(structure, brief.deliveryArtifacts);
  assert.ok(!structure.includes('vite.config.ts'), 'must not fall through to the unrelated React+Vite scaffold');
  assert.ok(!structure.some(f => f.endsWith('.tsx')), 'must not introduce React/TypeScript files for an HTML5/JS brief');
});

test('fallback project structure still uses the appType heuristic when the brief has no deliveryArtifacts', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const brief = {
    projectName: 'demo', goal: 'Build a brick breaker browser game with canvas and index.html.',
    appType: 'game', targetPlatforms: [], chosenStack: [], coreFeatures: [], assumptions: [], nonGoals: [],
    acceptanceCriteria: [], deliveryArtifacts: [], buildAndRunCommands: [], verificationCommands: [],
  };
  const structure = orchestrator._fallbackProjectStructure(brief);
  assert.ok(structure.includes('index.html'));
  assert.ok(structure.includes('src/logic.js'));
});

test('capability assessment detects web, file, and credential needs (EN + VI)', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);

  // The exact failing prompt from the black-box run.
  const job = orchestrator._assessGoalCapabilities(
    'tạo 1 agent xin việc. đọc cv người dùng và quét toàn bộ các trang web để chọn các công việc phù hợp với cv nhất và đường link để apply'
  );
  assert.equal(job.needsWeb, true, 'should detect web scanning need');
  assert.ok(job.needsUserFiles.length > 0, 'should detect the CV file need');

  const creds = orchestrator._assessGoalCapabilities('upload videos using the YouTube API key');
  assert.ok(creds.needsCredentials.length > 0);

  const plain = orchestrator._assessGoalCapabilities('build a calculator that adds two numbers');
  assert.equal(plain.needsWeb, false);
  assert.equal(plain.needsUserFiles.length, 0);
  assert.equal(plain.needsCredentials.length, 0);
});

test('build-intent goals defer runtime inputs (build the tool) instead of blocking', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const jobPrompt = 'tạo 1 agent xin việc. đọc cv người dùng và quét toàn bộ các trang web để chọn công việc phù hợp và đường link apply';
  orchestrator.workspace.writeUserPrompt(jobPrompt);

  // Must NOT throw — the CV is a runtime input, not a build-time blocker.
  await orchestrator._preflightCapabilities(jobPrompt);

  assert.equal(orchestrator._goalHasBuildIntent(jobPrompt), true);
  // Web research was auto-enabled for the run.
  assert.equal(orchestrator.modelConfig.webSearch.enabled, true);
  // A sample CV fixture was created so the tool can be developed/tested.
  assert.ok(orchestrator.fileManager.fileExists('examples/sample_resume.txt'));
  // The build directive was injected into the prompt for the brief/architect.
  assert.match(orchestrator.workspace.readUserPrompt(), /BUILD DIRECTIVE/);
});

test('one-shot goals on missing personal data still stop honestly', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  const oneShot = 'summarize the cv document and tell me the candidate strengths';
  orchestrator.workspace.writeUserPrompt(oneShot);

  assert.equal(orchestrator._goalHasBuildIntent(oneShot), false);
  await assert.rejects(
    () => orchestrator._preflightCapabilities(oneShot),
    /needs input only you can provide/
  );
});

test('refuses to build into this extension\'s own source tree unless explicitly allowed', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  // Reproduce the workspace shape from the real incident: the extension's own
  // package.json plus its orchestrator source file present at the workspace root.
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'local-multi-agent-coder' }));
  fs.mkdirSync(path.join(root, 'src', 'orchestrator'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'orchestrator', 'AgentOrchestrator.ts'), '// marker\n');

  const goal = 'build a calculator that adds two numbers';
  await assert.rejects(
    () => orchestrator._preflightCapabilities(goal),
    /own source tree/
  );

  // The escape hatch works for intentional self-modification.
  orchestrator.modelConfig.allowSelfWorkspace = true;
  await orchestrator._preflightCapabilities(goal);
});

test('does not guard a normal project workspace that merely has a package.json', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'some-users-app' }));

  await orchestrator._preflightCapabilities('build a calculator that adds two numbers');
});

test('dependency install runs pip3 install for a Python artifact when pip3 is available', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  fs.writeFileSync(path.join(root, 'requirements.txt'), 'requests>=2,<3\n');
  fs.writeFileSync(orchestrator.workspace.toolchainReportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    packageManager: 'npm',
    checks: [{ name: 'pip3', command: 'pip3 --version', available: true, version: 'pip 24.0' }],
    missing: [],
    notes: [],
  }));

  await orchestrator._phaseDependencyInstall(makeState());

  assert.ok(orchestrator.terminal.commands.includes('pip3 install -r requirements.txt'),
    'expected pip3 install to run for a declared requirements.txt');
});

test('dependency install skips Python deps gracefully when pip3 is unavailable (no throw)', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  fs.writeFileSync(path.join(root, 'requirements.txt'), 'requests>=2,<3\n');
  fs.writeFileSync(orchestrator.workspace.toolchainReportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    packageManager: 'npm',
    checks: [{ name: 'pip3', command: 'pip3 --version', available: false, error: 'not found' }],
    missing: ['pip3'],
    notes: [],
  }));

  await orchestrator._phaseDependencyInstall(makeState());

  assert.ok(!orchestrator.terminal.commands.includes('pip3 install -r requirements.txt'));
  assert.match(
    fs.readFileSync(orchestrator.workspace.dependencyInstallLogPath, 'utf8'),
    /pip3 is not available/
  );
});

test('artifact verification flags missing deliverables and phantom README references', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);

  const existing = ['src/index.js', 'package.json', 'README.md'];
  const readme = 'Run `npm install`. See `src/index.js` and the `tests/` folder and `app/server.py`.';
  const result = orchestrator._verifyArtifactsAgainstClaims(readme, ['src/index.js', 'dist/bundle.js'], existing);

  // dist/bundle.js was promised but not built.
  assert.ok(result.missingDeliverables.includes('dist/bundle.js'));
  assert.ok(!result.missingDeliverables.includes('src/index.js'));
  // README mentions tests/ and app/server.py which do not exist; `npm install` is not a path.
  assert.ok(result.phantomReferences.includes('tests'));
  assert.ok(result.phantomReferences.includes('app/server.py'));
  assert.ok(!result.phantomReferences.some(r => r.includes('npm')));
});

test('completion artifact gate requires a valid manifest whose files still exist', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  fs.writeFileSync(path.join(root, 'README.md'), '# Product\n');
  fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = 1;\n');
  orchestrator.workspace.writeFile(orchestrator.workspace.testResultLogPath, 'tests passed\n');
  const brief = JSON.stringify({ deliveryArtifacts: ['source project', 'README instructions', 'verification log'] });

  const missingManifest = orchestrator._runArtifactVerification(brief);
  assert.equal(missingManifest.ok, false);
  assert.match(missingManifest.summary, /manifest is missing/i);

  orchestrator.workspace.writeFile(orchestrator.workspace.deliveryManifestPath, JSON.stringify({
    filesIncluded: ['README.md', 'index.js'], archiveCreated: false,
  }));
  assert.equal(orchestrator._runArtifactVerification(brief).ok, true);

  orchestrator.workspace.writeFile(orchestrator.workspace.deliveryManifestPath, JSON.stringify({
    filesIncluded: ['README.md', 'missing.js'], archiveCreated: false,
  }));
  const stale = orchestrator._runArtifactVerification(brief);
  assert.equal(stale.ok, false);
  assert.match(stale.summary, /missing\.js/);
});

test('autonomous goal seeds the build pipeline with the dynamic team verdict and skips the fixed debate', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);

  const plan = {
    goal: 'Build a thing',
    rationale: 'team rationale',
    agents: [
      { id: 'builder', name: 'Builder', specialty: 'build', mission: 'm', systemPrompt: 'p', model: 'm1', fallbackModel: 'm2', tools: [], temperature: 0.4 },
    ],
    generatedAt: new Date().toISOString(),
  };
  const decision = {
    goal: 'Build a thing',
    winningAgentId: 'builder',
    winningProposal: 'Implement the thing with approach X.',
    weightedScore: 8.5,
    agreement: 'high',
    ranked: [{ agentId: 'builder', proposal: 'Implement the thing with approach X.', score: 8.5 }],
    rationale: 'highest mean score',
    generatedAt: new Date().toISOString(),
  };

  orchestrator._seedBuildFromTeam(plan, decision, '# Debate transcript\n...');

  // The winning direction is written where the briefing phase reads it as authoritative.
  const decisionDoc = orchestrator.workspace.readFile(orchestrator._debateDecisionPath);
  assert.match(decisionDoc, /Implement the thing with approach X\./);
  assert.match(decisionDoc, /autonomous agent team/i);
  // The transcript becomes brainstorm context for the brief builder.
  assert.match(orchestrator.workspace.readFile(orchestrator.workspace.brainstormPath), /Debate transcript/);

  // With the dynamic team having debated, the fixed 4-round debate is skipped.
  orchestrator._skipFixedDebate = true;
  const route = orchestrator._selectWorkflowRoute(makeState());
  assert.equal(route.skipDebate, true);
  assert.equal(route.kind, 'full_project');
});

test('fallback improvement consensus requires more than one clean sprint before stopping', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  orchestrator.workspace.writeFile(
    orchestrator.workspace.testerPath,
    '# Test Results\n\n{"passed":true,"testsRun":8,"errors":[],"warnings":[],"needsFix":false}'
  );
  orchestrator.workspace.writeProjectState(makeState({ failedTasks: [] }));

  const first = orchestrator._fallbackImprovementConsensus('brainstorm', 1, new Error('model offline'));
  const second = orchestrator._fallbackImprovementConsensus('brainstorm', 2, new Error('model offline'));

  assert.equal(first.readyToStop, false);
  assert.deepEqual(first.remainingWork, ['Stabilize remaining verification or completeness gaps found during the previous sprint.']);
  assert.equal(second.readyToStop, true);
  assert.deepEqual(second.remainingWork, []);
});

test('deterministic browser game recovery creates a verifiable playable scaffold', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  orchestrator.workspace.writeUserPrompt(
    'Build a complete mini browser game called Meteor Dodge using canvas, pure HTML CSS JavaScript, and node:test tests.'
  );
  const now = new Date().toISOString();
  const task = {
    id: 'task-game-recovery',
    title: 'Implement game logic',
    description: 'Implement canvas game logic and rendering.',
    assignedAgent: 'codeWorker',
    dependsOn: [],
    allowedFiles: ['src/logic.js'],
    forbiddenActions: [],
    acceptanceCriteria: ['Playable by opening index.html', 'npm test passes'],
    status: 'in_progress',
    createdAt: now,
  };
  const taskPlan = {
    tasks: [task],
    totalTasks: 1,
    estimatedComplexity: 'low',
    createdAt: now,
  };

  const recovery = await orchestrator._tryDeterministicTaskRecovery(task, makeState(), taskPlan, {
    taskId: task.id,
    approved: false,
    issues: ['logic is incomplete'],
    suggestions: [],
    securityConcerns: [],
    needsFix: true,
    fixSuggestions: ['Create a full browser game scaffold'],
    reviewedAt: now,
  });

  assert.ok(recovery);
  assert.ok(fs.existsSync(path.join(root, 'index.html')));
  assert.ok(fs.existsSync(path.join(root, 'src/logic.js')));
  assert.ok(fs.existsSync(path.join(root, 'test/logic.test.js')));

  const result = cp.spawnSync('npm', ['test'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('deterministic Arkanoid recovery creates a verifiable 10-level game', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  orchestrator.workspace.writeUserPrompt(
    'Build a complete Arkanoid style browser game called Neon Brick Breaker with canvas, 10 levels, keyboard controls, and node:test coverage.'
  );
  const now = new Date().toISOString();
  const task = {
    id: 'task-arkanoid-recovery',
    title: 'Implement Arkanoid game',
    description: 'Implement paddle, ball, bricks, ten levels, rendering, and tests.',
    assignedAgent: 'codeWorker',
    dependsOn: [],
    allowedFiles: ['src/logic.js'],
    forbiddenActions: [],
    acceptanceCriteria: ['Playable by opening index.html', '10 levels exist', 'npm test passes'],
    status: 'in_progress',
    createdAt: now,
  };
  const taskPlan = {
    tasks: [task],
    totalTasks: 1,
    estimatedComplexity: 'low',
    createdAt: now,
  };

  const recovery = await orchestrator._tryDeterministicTaskRecovery(task, makeState(), taskPlan);

  assert.ok(recovery);
  assert.ok(fs.existsSync(path.join(root, 'index.html')));
  assert.ok(fs.existsSync(path.join(root, 'src/logic.js')));
  assert.ok(fs.existsSync(path.join(root, 'test/logic.test.js')));
  assert.match(fs.readFileSync(path.join(root, 'src/logic.js'), 'utf8'), /MAX_LEVEL = 10/);

  const result = cp.spawnSync('npm', ['test'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('agent infers misspelled short Vietnamese Arkanoid prompt as a 10-level browser game', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  orchestrator.workspace.writeUserPrompt('tạo game akanoid 10 level');
  const now = new Date().toISOString();
  const task = {
    id: 'task-akanoid-prompt',
    title: 'Implement game',
    description: 'Create the runnable game product from the user prompt.',
    assignedAgent: 'codeWorker',
    dependsOn: [],
    allowedFiles: ['src/logic.js'],
    forbiddenActions: [],
    acceptanceCriteria: ['10 levels exist', 'npm test passes'],
    status: 'in_progress',
    createdAt: now,
  };
  const taskPlan = {
    tasks: [task],
    totalTasks: 1,
    estimatedComplexity: 'low',
    createdAt: now,
  };

  const brief = orchestrator._fallbackProjectBrief('tạo game akanoid 10 level');
  assert.equal(brief.appType, 'game');
  assert.deepEqual(brief.chosenStack, ['HTML Canvas', 'CSS', 'JavaScript', 'node:test']);
  assert.ok(brief.coreFeatures.some(feature => /10 playable levels/.test(feature)));

  const recovery = await orchestrator._tryDeterministicTaskRecovery(task, makeState(), taskPlan);

  assert.ok(recovery);
  assert.match(fs.readFileSync(path.join(root, 'src/logic.js'), 'utf8'), /MAX_LEVEL = 10/);
  const result = cp.spawnSync('npm', ['test'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('deterministic Arkanoid recovery honors an explicit non-default level count', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  orchestrator.workspace.writeUserPrompt(
    'Build a complete Arkanoid style brick breaker browser game called Mega Breaker with canvas, 30 levels, and node:test coverage.'
  );
  const now = new Date().toISOString();
  const task = {
    id: 'task-arkanoid-30-levels',
    title: 'Implement Arkanoid game',
    description: 'Implement paddle, ball, bricks, thirty levels, rendering, and tests.',
    assignedAgent: 'codeWorker',
    dependsOn: [],
    allowedFiles: ['src/logic.js'],
    forbiddenActions: [],
    acceptanceCriteria: ['Playable by opening index.html', '30 levels exist', 'npm test passes'],
    status: 'in_progress',
    createdAt: now,
  };
  const taskPlan = { tasks: [task], totalTasks: 1, estimatedComplexity: 'low', createdAt: now };

  const brief = orchestrator._fallbackProjectBrief(orchestrator.workspace.readUserPrompt());
  assert.ok(brief.coreFeatures.some(feature => /30 playable levels/.test(feature)));

  const recovery = await orchestrator._tryDeterministicTaskRecovery(task, makeState(), taskPlan);
  assert.ok(recovery);
  const logic = fs.readFileSync(path.join(root, 'src/logic.js'), 'utf8');
  assert.match(logic, /MAX_LEVEL = 30/);
  assert.match(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), /30 handcrafted difficulty levels/);

  const result = cp.spawnSync('npm', ['test'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('deterministic Arkanoid recovery honors a level count with an adjective in between ("30 different levels")', async () => {
  // Reproduces a real failure: a real 5-model run's actual prompt phrasing —
  // "30 different levels" — silently missed the number-then-keyword-only
  // extraction regex (which required the count to be immediately followed by
  // "level(s)") and fell back to the default of 10, shipping a 10-level game
  // for a goal that explicitly asked for 30.
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  orchestrator.workspace.writeUserPrompt(
    'Build a brick breaker (Arkanoid-style) browser game with 30 different levels of increasing difficulty, playable directly in a web browser.'
  );
  assert.equal(orchestrator._extractRequestedLevelCount(orchestrator.workspace.readUserPrompt()), 30);

  const now = new Date().toISOString();
  const task = {
    id: 'task-arkanoid-30-different-levels',
    title: 'Implement Arkanoid game',
    description: 'Implement paddle, ball, bricks, levels, rendering, and tests.',
    assignedAgent: 'codeWorker',
    dependsOn: [],
    allowedFiles: ['src/logic.js'],
    forbiddenActions: [],
    acceptanceCriteria: ['Playable by opening index.html', '30 levels exist', 'npm test passes'],
    status: 'in_progress',
    createdAt: now,
  };
  const taskPlan = { tasks: [task], totalTasks: 1, estimatedComplexity: 'low', createdAt: now };
  const recovery = await orchestrator._tryDeterministicTaskRecovery(task, makeState(), taskPlan);
  assert.ok(recovery);
  assert.match(fs.readFileSync(path.join(root, 'src/logic.js'), 'utf8'), /MAX_LEVEL = 30/);
});

test('deterministic CLI recovery creates a verifiable local tool', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  orchestrator.workspace.writeUserPrompt('Build a complete CLI called Focus Tool with add list done stats commands and node:test coverage.');
  const now = new Date().toISOString();
  const task = {
    id: 'task-cli-recovery',
    title: 'Implement CLI product',
    description: 'Create a runnable command line tool.',
    assignedAgent: 'codeWorker',
    dependsOn: [],
    allowedFiles: ['src/cli.js'],
    forbiddenActions: [],
    acceptanceCriteria: ['npm test passes'],
    status: 'in_progress',
    createdAt: now,
  };
  const taskPlan = {
    tasks: [task],
    totalTasks: 1,
    estimatedComplexity: 'low',
    createdAt: now,
  };

  const recovery = await orchestrator._tryDeterministicTaskRecovery(task, makeState(), taskPlan);

  assert.ok(recovery);
  assert.ok(fs.existsSync(path.join(root, 'src/cli.js')));
  assert.ok(fs.existsSync(path.join(root, 'test/cli.test.js')));

  const result = cp.spawnSync('npm', ['test'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('deterministic CLI recovery honors an explicit greeting flag contract', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  orchestrator.workspace.writeUserPrompt('Create a dependency-free Node.js CLI tool called "greet" that accepts a --name flag and prints "Hello, <name>!" to stdout.');
  orchestrator.workspace.writeFile(orchestrator.workspace.projectBriefPath, JSON.stringify({
    projectName: 'greet',
    deliveryArtifacts: ['greet.js', 'package.json', 'test.js'],
  }));
  const now = new Date().toISOString();
  const task = {
    id: 'task-greet-recovery',
    title: 'Create project scaffold and scripts',
    description: 'Implement the greet CLI contract.',
    assignedAgent: 'codeWorker',
    dependsOn: [],
    allowedFiles: ['package.json', 'src/cli.js', 'test/cli.test.js', 'README.md'],
    forbiddenActions: [],
    acceptanceCriteria: ['--name Ada prints Hello, Ada!', 'npm test passes'],
    status: 'in_progress',
    createdAt: now,
  };
  const taskPlan = { tasks: [task], totalTasks: 1, estimatedComplexity: 'low', createdAt: now };

  const recovery = await orchestrator._tryDeterministicTaskRecovery(task, makeState(), taskPlan);

  assert.ok(recovery);
  const reconciledBrief = JSON.parse(orchestrator.workspace.readFile(orchestrator.workspace.projectBriefPath));
  assert.deepEqual(reconciledBrief.deliveryArtifacts, ['package.json', 'src/cli.js', 'test/cli.test.js', 'README.md']);
  const cli = cp.spawnSync(process.execPath, ['src/cli.js', '--name', 'Ada'], { cwd: root, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.trim(), 'Hello, Ada!');
  const tests = cp.spawnSync('npm', ['test'], { cwd: root, encoding: 'utf8' });
  assert.equal(tests.status, 0, `${tests.stdout}\n${tests.stderr}`);
});

test('deterministic REST API recovery creates a verifiable API', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  orchestrator.workspace.writeUserPrompt('Build a complete REST API called Pantry API with health, items, JSON routes, and node:test coverage.');
  const now = new Date().toISOString();
  const task = {
    id: 'task-api-recovery',
    title: 'Implement API product',
    description: 'Create a runnable Node REST API server.',
    assignedAgent: 'codeWorker',
    dependsOn: [],
    allowedFiles: ['src/server.js'],
    forbiddenActions: [],
    acceptanceCriteria: ['npm test passes'],
    status: 'in_progress',
    createdAt: now,
  };
  const taskPlan = {
    tasks: [task],
    totalTasks: 1,
    estimatedComplexity: 'low',
    createdAt: now,
  };

  const recovery = await orchestrator._tryDeterministicTaskRecovery(task, makeState(), taskPlan);

  assert.ok(recovery);
  assert.ok(fs.existsSync(path.join(root, 'src/server.js')));
  assert.ok(fs.existsSync(path.join(root, 'test/server.test.js')));

  const result = cp.spawnSync('npm', ['test'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('deterministic React recovery creates a verifiable React scaffold', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  orchestrator.workspace.writeUserPrompt('Build a complete React app called Insight Board with Vite, dashboard UI, and smoke tests.');
  const now = new Date().toISOString();
  const task = {
    id: 'task-react-recovery',
    title: 'Implement React product',
    description: 'Create a runnable frontend product scaffold.',
    assignedAgent: 'codeWorker',
    dependsOn: [],
    allowedFiles: ['src/App.jsx'],
    forbiddenActions: [],
    acceptanceCriteria: ['npm test passes'],
    status: 'in_progress',
    createdAt: now,
  };
  const taskPlan = {
    tasks: [task],
    totalTasks: 1,
    estimatedComplexity: 'low',
    createdAt: now,
  };

  const recovery = await orchestrator._tryDeterministicTaskRecovery(task, makeState(), taskPlan);

  assert.ok(recovery);
  assert.ok(fs.existsSync(path.join(root, 'src/App.jsx')));
  assert.ok(fs.existsSync(path.join(root, 'src/main.jsx')));
  assert.ok(fs.existsSync(path.join(root, 'test/app.test.js')));

  const result = cp.spawnSync('npm', ['test'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('deterministic Node library recovery creates a verifiable package', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  orchestrator.workspace.writeUserPrompt('Build a complete Node library package called Tiny Utils with reusable helpers and node:test coverage.');
  const now = new Date().toISOString();
  const task = {
    id: 'task-library-recovery',
    title: 'Implement library package',
    description: 'Create a reusable npm package with tests.',
    assignedAgent: 'codeWorker',
    dependsOn: [],
    allowedFiles: ['src/index.js'],
    forbiddenActions: [],
    acceptanceCriteria: ['npm test passes'],
    status: 'in_progress',
    createdAt: now,
  };
  const taskPlan = {
    tasks: [task],
    totalTasks: 1,
    estimatedComplexity: 'low',
    createdAt: now,
  };

  const recovery = await orchestrator._tryDeterministicTaskRecovery(task, makeState(), taskPlan);

  assert.ok(recovery);
  assert.ok(fs.existsSync(path.join(root, 'src/index.js')));
  assert.ok(fs.existsSync(path.join(root, 'test/index.test.js')));

  const result = cp.spawnSync('npm', ['test'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('deterministic static web recovery creates a verifiable web product', async () => {
  const root = makeTempWorkspace();
  const orchestrator = await makeOrchestrator(root);
  orchestrator.workspace.writeUserPrompt('Build a complete static website called Signal Desk with HTML CSS JavaScript and smoke tests.');
  const now = new Date().toISOString();
  const task = {
    id: 'task-web-recovery',
    title: 'Implement static web product',
    description: 'Create a runnable static browser app.',
    assignedAgent: 'codeWorker',
    dependsOn: [],
    allowedFiles: ['index.html'],
    forbiddenActions: [],
    acceptanceCriteria: ['npm test passes'],
    status: 'in_progress',
    createdAt: now,
  };
  const taskPlan = {
    tasks: [task],
    totalTasks: 1,
    estimatedComplexity: 'low',
    createdAt: now,
  };

  const recovery = await orchestrator._tryDeterministicTaskRecovery(task, makeState(), taskPlan);

  assert.ok(recovery);
  assert.ok(fs.existsSync(path.join(root, 'index.html')));
  assert.ok(fs.existsSync(path.join(root, 'src/app.js')));
  assert.ok(fs.existsSync(path.join(root, 'test/smoke.test.js')));

  const result = cp.spawnSync('npm', ['test'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
