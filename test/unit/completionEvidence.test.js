const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AgentOrchestrator } = require('../../out/orchestrator/AgentOrchestrator');

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'completion-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agent = new AgentOrchestrator(root);
  await agent.workspace.initialize();
  agent.modelConfig = agent.workspace.readModelConfig();
  agent.modelConfig.maxDevelopmentSprints = 1;
  const state = agent._newState('Build a complete application.');
  agent.workspace.writeProjectState(state);
  agent._selectWorkflowRoute = () => ({ kind: 'full_project', skipDebate: true, reason: 'Already debated' });
  agent._phaseAlreadyDone = () => true;
  const calls = [];
  for (const phase of ['Architecture', 'TaskPlanning', 'Coding', 'DependencyInstall', 'Testing', 'ArtifactDelivery', 'FinalIntegration']) {
    agent[`_phase${phase}`] = async () => calls.push(phase);
  }
  agent._phaseImprovementConsensus = async () => [
    { agentRole: 'brainstorm', readyToStop: true, remainingWork: [] },
    { agentRole: 'critic', readyToStop: true, remainingWork: [] },
    { agentRole: 'secondBrainstorm', readyToStop: true, remainingWork: [] },
  ];
  return { agent, state, calls };
}

test('exhausting sprints with remaining work never emits completed', async t => {
  const { agent, state } = await setup(t);
  agent._phaseImprovementConsensus = async () => [{ readyToStop: false, remainingWork: ['19 levels missing'] }];
  await assert.rejects(agent._runWorkflow(state), /incomplete after 1.*19 levels missing/);
  assert.notEqual(state.status, 'completed');
  assert.equal(agent.workspace.readProjectState().sprintStage, 'retrospective');
});

test('failed tasks block completion even after a unanimous model vote', async t => {
  const { agent, state } = await setup(t);
  state.failedTasks = ['task-entry'];
  await assert.rejects(agent._runWorkflow(state), /unfinished tasks: task-entry/);
  assert.notEqual(state.status, 'completed');
});

test('resume after dependency failure preserves code and restarts at the failed phase', async t => {
  const { agent, state, calls } = await setup(t);
  let installs = 0;
  agent._phaseDependencyInstall = async () => {
    calls.push('DependencyInstall');
    if (++installs === 1) throw new Error('temporary install failure');
  };
  await assert.rejects(agent._runWorkflow(state), /temporary install failure/);
  assert.equal(agent.workspace.readProjectState().sprintStage, 'dependency_install');
  calls.length = 0;
  await agent._runWorkflow(agent.workspace.readProjectState());
  assert.deepEqual(calls, ['DependencyInstall', 'Testing']);
  assert.equal(agent.workspace.readProjectState().status, 'completed');
});

test('string false is not a completion vote and absent tests are not positive evidence', async t => {
  const { agent } = await setup(t);
  assert.equal(agent._normalizeImprovementConsensus('critic', { readyToStop: 'false' }).readyToStop, false);
  assert.equal(agent._fallbackImprovementConsensus('critic', 2, new Error('offline')).readyToStop, false);
});

test('implementation sprint budget is independent of the number of debate rounds', async t => {
  const { agent } = await setup(t);
  agent.modelConfig.maxDevelopmentSprints = 7;
  agent.modelConfig.debateRounds = 3;
  assert.equal(agent._maxDevelopmentSprints(), 7);
});

test('public Resume accepts persisted failures and preserves the failed phase', async t => {
  const { agent, state } = await setup(t);
  state.currentPhase = 'dependency_install';
  state.sprintStage = 'dependency_install';
  agent.workspace.writeProjectState(state);
  agent._persistFailedState();
  assert.equal(agent.getState().currentPhase, 'dependency_install');
  let resumed;
  agent._loadConfig = () => {};
  agent._runWorkflow = async saved => { resumed = saved; };
  await agent.resume();
  assert.equal(resumed.sprintStage, 'dependency_install');
  assert.equal(resumed.status, 'running');
});

test('a retrospective checkpoint resumes after debate instead of repeating it', async t => {
  const { agent, state } = await setup(t);
  state.currentPhase = 'brainstorm';
  state.sprintStage = 'retrospective';
  assert.equal(agent._resumePhase(state), 'testing');
});

test('reducing the sprint budget cannot turn an unreviewed checkpoint into completed', async t => {
  const { agent, state } = await setup(t);
  state.developmentSprint = 2;
  state.sprintStage = 'architecture';
  await assert.rejects(agent._runWorkflow(state), /exceeds the configured development budget/);
  assert.notEqual(state.status, 'completed');
});
