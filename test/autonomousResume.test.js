const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AgentOrchestrator } = require('../out/orchestrator/AgentOrchestrator');
const { UserAbortError, WorkflowError } = require('../out/utils/errors');

const goal = 'Build a complete browser game with real tests.';
const createdAt = '2026-09-11T06:00:00.000Z';

function checkpoint(overrides = {}) {
  return { projectGoal: goal, status: 'stopped', currentPhase: 'critique', confirmedByUser: false,
    createdAt, updatedAt: createdAt, openQuestions: [], decisions: [], activeTasks: [],
    completedTasks: [], failedTasks: [], currentTaskId: null, fixRetryCount: 0, ...overrides };
}

function debatePayload(forGoal = goal, plannedAt = '2026-09-11T06:01:00.000Z') {
  const plan = { goal: forGoal, rationale: 'Five independent participants', generatedAt: plannedAt,
    agents: Array.from({ length: 5 }, (_, index) => ({ id: `a${index}`, name: `Agent ${index}`,
      specialty: 'Engineering', model: `model-${index}`, fallbackModel: `model-${index}`, tools: [] })) };
  const decision = { goal: forGoal, winningAgentId: 'a0', winningProposal: 'Build and verify the requested game.',
    weightedScore: 8, agreement: 'high', ranked: [{ agentId: 'a0', proposal: 'Build and verify the requested game.', score: 8 }],
    rationale: 'Complete and verifiable', generatedAt: new Date(Date.parse(plannedAt) + 1000).toISOString() };
  const transcript = '# Dynamic Team Debate\n' + [1, 2, 3, 4].map(round => `## Round ${round} — Evidence\nAll participants contributed.`).join('\n');
  return { plan, decision, transcript };
}

function persistDebate(orchestrator, payload, { completed = true } = {}) {
  orchestrator.workspace.writeFile(orchestrator.workspace.agentNotePath('dynamic_team_plan.json'), JSON.stringify(payload.plan));
  if (completed) {
    orchestrator.workspace.writeFile(orchestrator.workspace.agentNotePath('dynamic_team_decision.json'), JSON.stringify(payload.decision));
    orchestrator.workspace.writeFile(orchestrator.workspace.agentNotePath('dynamic_team_debate.md'), payload.transcript);
  }
}

async function harness(t, { root, state = checkpoint(), realWorkflow = false } = {}) {
  if (!root) {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-resume-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  }
  const orchestrator = new AgentOrchestrator(root);
  await orchestrator.workspace.initialize();
  orchestrator.workspace.writeProjectState(state);
  orchestrator.workspace.writeUserPrompt(state.projectGoal);
  const calls = [];
  const errors = [];
  orchestrator._loadConfig = () => { orchestrator.modelConfig = orchestrator.workspace.readModelConfig(); };
  orchestrator._preflightSystemResources = () => { calls.push('resources'); };
  orchestrator._offerRamOptimizationIfNeeded = async () => {};
  orchestrator._requireReadyDebateModels = async () => { calls.push('ready-models'); };
  orchestrator._preflightCapabilities = async () => { calls.push('capabilities'); };
  orchestrator._designAndRunTeamInternal = async () => { throw new Error('Unexpected dynamic model call in test'); };
  if (!realWorkflow) {
    orchestrator._runWorkflow = async current => {
      calls.push({ kind: 'workflow', skipFixedDebate: orchestrator._skipFixedDebate, state: JSON.parse(JSON.stringify(current)) });
    };
  }
  orchestrator.setCallbacks({ onError: error => errors.push(error) });
  return { orchestrator, root, calls, errors };
}

function fakeDynamicDebate(orchestrator, calls) {
  orchestrator._designAndRunTeamInternal = async (requestedGoal, state) => {
    assert.equal(state.autonomousStage, 'debate');
    calls.push('dynamic-debate');
    const payload = debatePayload(requestedGoal, new Date(Date.now() + 1).toISOString());
    persistDebate(orchestrator, payload);
    return payload;
  };
}

test('a new fixed workflow persists its mode and clears an old in-memory dynamic route', async t => {
  const { orchestrator, calls, errors } = await harness(t);
  orchestrator._skipFixedDebate = true;

  await orchestrator.start(goal);

  assert.deepEqual(errors, []);
  const run = calls.find(call => call.kind === 'workflow');
  assert.equal(run.skipFixedDebate, false);
  assert.equal(run.state.workflowMode, 'fixed');
  assert.equal(orchestrator.workspace.readProjectState().workflowMode, 'fixed');
});

test('Stop during dynamic critique resumes the dynamic protocol after a fresh orchestrator restart', async t => {
  const initial = await harness(t);
  initial.orchestrator._designAndRunTeamInternal = async (requestedGoal, state) => {
    persistDebate(initial.orchestrator, debatePayload(requestedGoal, new Date(Date.now() + 1).toISOString()), { completed: false });
    initial.orchestrator._setPhase(state, 'critique', 'Dynamic debate round 2/4');
    initial.orchestrator.stop();
    throw new UserAbortError();
  };

  await initial.orchestrator.runAutonomousGoal(goal);
  const saved = initial.orchestrator.workspace.readProjectState();
  assert.equal(saved.status, 'stopped');
  assert.equal(saved.workflowMode, 'autonomous');
  assert.equal(saved.autonomousStage, 'debate');
  assert.equal(saved.currentPhase, 'critique');
  assert.equal(initial.calls.some(call => call.kind === 'workflow'), false);

  const resumed = await harness(t, { root: initial.root, state: saved });
  fakeDynamicDebate(resumed.orchestrator, resumed.calls);
  await resumed.orchestrator.resume();

  assert.deepEqual(resumed.errors, []);
  assert.equal(resumed.calls.filter(call => call === 'dynamic-debate').length, 1);
  assert.equal(resumed.calls.filter(call => call === 'ready-models').length, 1);
  const run = resumed.calls.find(call => call.kind === 'workflow');
  assert.equal(run.skipFixedDebate, true);
  assert.equal(run.state.autonomousStage, 'build');
  assert.equal(run.state.currentPhase, 'briefing');
  assert.equal(resumed.orchestrator._skipFixedDebate, false, 'Per-run routing is cleared after returning');
});

test('Stop at the debate-to-build boundary preserves the completed decision and avoids another debate', async t => {
  const initial = await harness(t);
  fakeDynamicDebate(initial.orchestrator, initial.calls);
  initial.orchestrator.setCallbacks({ onPhaseChange: phase => { if (phase === 'briefing') { initial.orchestrator.stop(); } } });

  await initial.orchestrator.runAutonomousGoal(goal);
  const saved = initial.orchestrator.workspace.readProjectState();
  assert.equal(saved.status, 'stopped');
  assert.equal(saved.autonomousStage, 'build');
  assert.equal(initial.calls.some(call => call.kind === 'workflow'), false);

  const resumed = await harness(t, { root: initial.root, state: saved });
  await resumed.orchestrator.resume();

  assert.deepEqual(resumed.errors, []);
  assert.equal(resumed.calls.includes('ready-models'), false);
  assert.equal(resumed.calls.find(call => call.kind === 'workflow').skipFixedDebate, true);
});

test('saved complete artifacts are reused when Stop happened before the build-stage checkpoint', async t => {
  const { orchestrator, calls, errors } = await harness(t, {
    state: checkpoint({ workflowMode: 'autonomous', autonomousStage: 'debate' }),
  });
  persistDebate(orchestrator, debatePayload());

  await orchestrator.resume();

  assert.deepEqual(errors, []);
  assert.equal(calls.includes('ready-models'), false);
  const run = calls.find(call => call.kind === 'workflow');
  assert.equal(run.state.autonomousStage, 'build');
  assert.equal(run.state.currentPhase, 'briefing');
  assert.equal(run.skipFixedDebate, true);
  assert.ok(orchestrator.workspace.fileExists(orchestrator._debateDecisionPath));
});

test('legacy autonomous build is inferred only from this run’s completed matching debate artifacts', async t => {
  const { orchestrator, calls, errors } = await harness(t, {
    state: checkpoint({ status: 'failed', currentPhase: 'fixing', sprintStage: 'coding', developmentSprint: 1 }),
  });
  persistDebate(orchestrator, debatePayload());

  await orchestrator.resume();

  assert.deepEqual(errors, []);
  assert.equal(calls.includes('ready-models'), false);
  const run = calls.find(call => call.kind === 'workflow');
  assert.equal(run.state.workflowMode, 'autonomous');
  assert.equal(run.state.autonomousStage, 'build');
  assert.equal(run.state.sprintStage, 'coding');
  assert.equal(run.skipFixedDebate, true);
});

test('legacy partial dynamic debate reruns all dynamic rounds instead of entering fixed debate', async t => {
  const { orchestrator, calls, errors } = await harness(t);
  persistDebate(orchestrator, debatePayload(), { completed: false });
  fakeDynamicDebate(orchestrator, calls);

  await orchestrator.resume();

  assert.deepEqual(errors, []);
  assert.ok(calls.includes('dynamic-debate'));
  assert.equal(calls.find(call => call.kind === 'workflow').skipFixedDebate, true);
});

test('resume() continues a mid-round dynamic debate from its per-turn checkpoint instead of restarting round 1', async t => {
  const { orchestrator, calls, errors } = await harness(t);
  const payload = debatePayload();
  persistDebate(orchestrator, payload, { completed: false });
  const partialCheckpoint = {
    goal, round: 2,
    originals: payload.plan.agents.map(a => ({ agentId: a.id, agentName: a.name, proposal: 'R1 proposal' })),
    proposals: payload.plan.agents.map(a => ({ agentId: a.id, agentName: a.name, proposal: 'R1 proposal' })),
    critiques: payload.plan.agents.slice(0, 3).map(a => ({ agentId: a.id, agentName: a.name, critique: 'critique text' })),
    scores: [], completedAgentIds: payload.plan.agents.slice(0, 3).map(a => a.id),
    transcript: payload.transcript, updatedAt: new Date(Date.parse(payload.plan.generatedAt) + 5000).toISOString(),
  };
  orchestrator.workspace.writeFile(orchestrator.workspace.agentNotePath('dynamic_team_checkpoint.json'), JSON.stringify(partialCheckpoint));

  let received;
  orchestrator._designAndRunTeamInternal = async (requestedGoal, state, resumeTeam) => {
    received = resumeTeam;
    calls.push('dynamic-debate');
    const fresh = debatePayload(requestedGoal, new Date(Date.now() + 1).toISOString());
    persistDebate(orchestrator, fresh);
    return fresh;
  };

  await orchestrator.resume();

  assert.deepEqual(errors, []);
  assert.ok(calls.includes('dynamic-debate'));
  assert.ok(received, 'a partial checkpoint must be handed back into _designAndRunTeamInternal');
  assert.equal(received.checkpoint.round, 2);
  assert.deepEqual(received.checkpoint.completedAgentIds, partialCheckpoint.completedAgentIds);
  assert.deepEqual(received.plan.agents.map(a => a.id), payload.plan.agents.map(a => a.id),
    'must reuse the SAME team the checkpoint was recorded against, not a freshly (re-)designed one');
});

test('resume() reclaims a "running" status once the run lock is stale (orphaned by a crash)', async t => {
  const { orchestrator, calls, errors } = await harness(t, { state: checkpoint({ status: 'running' }) });
  // No run.lock file at all — exactly what a hard process kill leaves behind.

  await orchestrator.resume();

  assert.deepEqual(errors, []);
  assert.ok(calls.some(call => call.kind === 'workflow'), 'an orphaned "running" status must still be resumable');
});

test('resume() refuses a "running" status while a live process still owns the run lock', async t => {
  const { orchestrator, calls } = await harness(t, { state: checkpoint({ status: 'running' }) });
  const { RunLock } = require('../out/workspace/RunLock');
  new RunLock(orchestrator.workspace.runLockPath).acquire(); // a fresh heartbeat under this (live) process's own pid

  await orchestrator.resume();

  assert.equal(calls.some(call => call.kind === 'workflow'), false, 'a live run lock must block resume');
});

test('stale or unrelated dynamic artifacts cannot convert a legacy fixed run into an autonomous run', async t => {
  for (const payload of [debatePayload(goal, '2026-09-10T06:01:00.000Z'), debatePayload('A different project')]) {
    const { orchestrator, calls, errors } = await harness(t);
    persistDebate(orchestrator, payload);
    await orchestrator.resume();
    assert.deepEqual(errors, []);
    const run = calls.find(call => call.kind === 'workflow');
    assert.equal(run.state.workflowMode, 'fixed');
    assert.equal(run.skipFixedDebate, false);
  }
});

test('an explicitly fixed run ignores even current matching dynamic artifacts', async t => {
  const { orchestrator, calls, errors } = await harness(t, { state: checkpoint({ workflowMode: 'fixed' }) });
  persistDebate(orchestrator, debatePayload());

  await orchestrator.resume();

  assert.deepEqual(errors, []);
  assert.equal(calls.find(call => call.kind === 'workflow').skipFixedDebate, false);
});

test('retrospective resume reruns verification and cannot complete using evidence from before user edits', async t => {
  const { orchestrator, calls, errors } = await harness(t, { realWorkflow: true, state: checkpoint({
    workflowMode: 'fixed', currentPhase: 'briefing', sprintStage: 'retrospective', developmentSprint: 1,
  }) });
  orchestrator.workspace.writeFile(orchestrator.workspace.projectBriefPath, JSON.stringify({ goal }));
  orchestrator.workspace.writeFile(orchestrator.workspace.toolchainReportPath, JSON.stringify({ checks: [] }));
  for (const method of ['_phaseBrainstorm', '_phaseCritique', '_phaseSecondBrainstorm', '_phaseDebateResponse', '_phaseDebateScoring',
    '_phaseBriefing', '_phaseToolchainDiscovery', '_phaseArchitecture', '_phaseTaskPlanning', '_phaseCoding', '_phaseDependencyInstall']) {
    orchestrator[method] = async () => { throw new Error(`Unexpected phase: ${method}`); };
  }
  orchestrator._phaseTesting = async () => { calls.push('fresh-verification'); throw new WorkflowError('User-edited source now fails verification', 'testing'); };
  orchestrator._phaseImprovementConsensus = async () => { calls.push('stale-consensus'); return []; };

  await orchestrator.resume();

  assert.ok(calls.includes('fresh-verification'));
  assert.equal(calls.includes('stale-consensus'), false);
  assert.match(errors.join('\n'), /User-edited source now fails verification/);
  const saved = orchestrator.workspace.readProjectState();
  assert.equal(saved.status, 'failed');
  assert.equal(saved.sprintStage, 'testing');
});

test('coding resume resets failed/skipped work and canonical active IDs while preserving completed work and files', async t => {
  const { orchestrator, calls, errors, root } = await harness(t, { state: checkpoint({
    workflowMode: 'fixed', status: 'failed', currentPhase: 'fixing', sprintStage: 'coding', developmentSprint: 1,
    completedTasks: ['sprint-01-task-001'], failedTasks: ['sprint-01-task-002'],
    activeTasks: ['task-001', 'task-002', 'task-003', 'task-004'], currentTaskId: 'sprint-01-task-004', fixRetryCount: 8,
  }) });
  const statuses = ['completed', 'failed', 'skipped', 'in_progress'];
  const tasks = statuses.map((status, index) => ({ id: `sprint-01-task-00${index + 1}`, title: `Task ${index + 1}`, status,
    allowedFiles: [`src/${index}.js`], dependsOn: index ? [`sprint-01-task-00${index}`] : [],
    error: status === 'completed' ? undefined : 'previous attempt failed', retryCount: 8, completedAt: createdAt }));
  orchestrator.workspace.writeFile(orchestrator.workspace.taskPlanPath, JSON.stringify({ tasks, totalTasks: 4, estimatedComplexity: 'medium', createdAt }));
  fs.writeFileSync(path.join(root, 'user-source.js'), 'preserve this code');

  await orchestrator.resume();

  assert.deepEqual(errors, []);
  const run = calls.find(call => call.kind === 'workflow');
  const plan = JSON.parse(orchestrator.workspace.readFile(orchestrator.workspace.taskPlanPath));
  assert.deepEqual(plan.tasks.map(task => task.status), ['completed', 'pending', 'pending', 'pending']);
  assert.equal(plan.tasks[0].completedAt, createdAt);
  assert.equal(plan.tasks[1].error, undefined);
  assert.deepEqual(plan.tasks.map(task => task.dependsOn), tasks.map(task => task.dependsOn));
  assert.deepEqual(run.state.completedTasks, ['sprint-01-task-001']);
  assert.deepEqual(run.state.failedTasks, []);
  assert.deepEqual(run.state.activeTasks, ['sprint-01-task-002', 'sprint-01-task-003', 'sprint-01-task-004']);
  assert.equal(run.state.currentTaskId, null);
  assert.equal(run.state.fixRetryCount, 0);
  assert.equal(run.state.currentPhase, 'coding');
  assert.equal(fs.readFileSync(path.join(root, 'user-source.js'), 'utf8'), 'preserve this code');
});

test('a run lock heartbeat that cannot write (folder briefly gone) does not throw from the timer', () => {
  const { RunLock } = require('../out/workspace/RunLock');
  const missing = path.join(os.tmpdir(), `runlock-missing-${process.pid}-${Date.now()}`, 'nested', 'run.lock');
  fs.mkdirSync(path.dirname(path.dirname(missing)), { recursive: true });
  fs.writeFileSync(path.dirname(missing), 'a file, so mkdir of this path fails');

  assert.doesNotThrow(() => new RunLock(missing).heartbeat());
  fs.rmSync(path.dirname(path.dirname(missing)), { recursive: true, force: true });
});
