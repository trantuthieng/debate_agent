const assert = require('node:assert/strict');
const test = require('node:test');

const { AgentFactory } = require('../../out/dynamic/AgentFactory');
const { DynamicAgent } = require('../../out/dynamic/DynamicAgent');
const { DynamicTeam } = require('../../out/dynamic/DynamicTeam');

const ROSTER = ['m1', 'm2', 'm3', 'm4', 'm5'];
const TOOLS = ['read_file', 'search', 'web_search'];

function makeFactory(client) {
  return new AgentFactory(client, {
    roster: ROSTER,
    toolNames: TOOLS,
    designerModel: 'm1',
    designerFallback: 'm2',
  });
}

test('agent factory normalizes a designed team: distinct models, filtered tools, unique ids', () => {
  const factory = makeFactory({ callWithFallbackJson: async () => ({}) });
  const plan = factory._normalizeTeam({
    rationale: 'cover the goal',
    agents: [
      { name: 'A', specialty: 'alpha', model: 'm1', tools: ['read_file', 'bogus-tool'] },
      { name: 'B', specialty: 'beta', model: 'm1', tools: ['search'] }, // collides on m1
      { id: 'a', name: 'C', specialty: 'gamma' },                       // id collides with A
    ],
  }, 'goal');

  assert.equal(plan.agents.length, 3);
  const models = plan.agents.map(a => a.model);
  assert.equal(new Set(models).size, 3, `expected distinct models, got ${models}`);
  // Unknown tools are filtered out.
  assert.deepEqual(plan.agents[0].tools, ['read_file']);
  // Ids are unique even when two agents request the same id.
  assert.equal(new Set(plan.agents.map(a => a.id)).size, 3);
  // Every agent gets a non-empty system prompt (default-filled when missing).
  assert.ok(plan.agents.every(a => a.systemPrompt.length > 0));
});

test('agent factory fallback team always has >=5 distinct-model agents', () => {
  const factory = makeFactory({ callWithFallbackJson: async () => ({}) });
  const plan = factory._fallbackTeam('any goal');
  assert.ok(plan.agents.length >= 5);
  assert.ok(new Set(plan.agents.map(a => a.model)).size >= 5);
  assert.ok(plan.agents.every(a => a.name && a.specialty && a.systemPrompt));
});

test('agent factory designTeam uses the model output when valid', async () => {
  const designed = {
    rationale: 'bespoke',
    agents: ROSTER.map((m, i) => ({ name: `Agent${i}`, specialty: `spec${i}`, model: m, tools: ['search'] })),
  };
  const factory = makeFactory({ callWithFallbackJson: async () => designed });
  const plan = await factory.designTeam('build something');
  assert.equal(plan.agents.length, 5);
  assert.equal(plan.rationale, 'bespoke');
});

test('agent factory designTeam falls back to a generic team when the designer fails', async () => {
  const factory = makeFactory({ callWithFallbackJson: async () => { throw new Error('model down'); } });
  const plan = await factory.designTeam('build something');
  assert.ok(plan.agents.length >= 5);
  assert.match(plan.rationale, /generic team/i);
});

test('agent factory tops up an under-staffed designed team to the minimum', async () => {
  const factory = makeFactory({
    callWithFallbackJson: async () => ({ rationale: 'thin', agents: [{ name: 'Solo', specialty: 'only one' }] }),
  });
  const plan = await factory.designTeam('goal');
  assert.ok(plan.agents.length >= 5, `expected top-up to >=5, got ${plan.agents.length}`);
});

test('dynamic team aggregation ranks proposals by mean score and reports agreement', () => {
  const team = new DynamicTeam({ callWithFallback: async () => '', callWithFallbackJson: async () => ({}) });
  const proposals = [
    { agentId: 'a', agentName: 'A', proposal: 'Plan A' },
    { agentId: 'b', agentName: 'B', proposal: 'Plan B' },
  ];
  const scores = [
    { judgeId: 'a', proposalId: 'a', score: 6, reason: '' },
    { judgeId: 'b', proposalId: 'a', score: 6, reason: '' },
    { judgeId: 'a', proposalId: 'b', score: 9, reason: '' },
    { judgeId: 'b', proposalId: 'b', score: 9, reason: '' },
  ];
  const decision = team._aggregate('goal', proposals, scores);
  assert.equal(decision.winningAgentId, 'b');
  assert.equal(decision.weightedScore, 9);
  assert.equal(decision.agreement, 'high'); // both judges gave 9 → tight spread
  assert.equal(decision.ranked[0].agentId, 'b');
});

test('dynamic team aggregation handles an empty proposal set', () => {
  const team = new DynamicTeam({ callWithFallback: async () => '', callWithFallbackJson: async () => ({}) });
  const decision = team._aggregate('goal', [], []);
  assert.equal(decision.winningAgentId, '');
  assert.equal(decision.weightedScore, 0);
});

test('dynamic agent returns plain text when it has no tools', async () => {
  const spec = { id: 'a', name: 'A', specialty: 's', mission: 'm', systemPrompt: 'You are A.', model: 'm1', fallbackModel: 'm2', tools: [], temperature: 0.4 };
  const agent = new DynamicAgent({ callWithFallback: async () => '  the answer  ' }, spec);
  const out = await agent.respond('do the thing');
  assert.equal(out, 'the answer');
});

test('dynamic agent runs a granted tool then produces a final answer', async () => {
  const spec = { id: 'a', name: 'A', specialty: 's', mission: 'm', systemPrompt: 'You are A.', model: 'm1', fallbackModel: 'm2', tools: ['search'], temperature: 0.4 };
  let call = 0;
  const client = {
    callWithFallback: async () => {
      call += 1;
      return call === 1 ? '{"tool":"search","args":{"query":"x"}}' : 'FINAL ANSWER';
    },
  };
  const toolCalls = [];
  const toolRunner = {
    execute: async req => { toolCalls.push(req); return { id: req.id, name: req.name, success: true, output: 'tool data' }; },
  };
  const agent = new DynamicAgent(client, spec, toolRunner);
  const out = await agent.respond('research x');
  assert.equal(out, 'FINAL ANSWER');
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, 'search');
});

test('dynamic agent ignores tool requests for tools it was not granted', async () => {
  const spec = { id: 'a', name: 'A', specialty: 's', mission: 'm', systemPrompt: 'You are A.', model: 'm1', fallbackModel: 'm2', tools: ['search'], temperature: 0.4 };
  const client = { callWithFallback: async () => '{"tool":"run_command","args":{"command":"rm -rf /"}}' };
  let toolUsed = false;
  const toolRunner = { execute: async () => { toolUsed = true; return { success: true, output: '' }; } };
  const agent = new DynamicAgent(client, spec, toolRunner);
  const out = await agent.respond('task');
  // Security property: a tool the agent was not granted is NEVER executed.
  assert.equal(toolUsed, false);
  assert.ok(typeof out === 'string' && out.length > 0);
});
