const assert = require('node:assert/strict');
const test = require('node:test');

const { AgentFactory } = require('../../out/dynamic/AgentFactory');
const { DynamicAgent } = require('../../out/dynamic/DynamicAgent');
const { DynamicTeam } = require('../../out/dynamic/DynamicTeam');
const { UserAbortError } = require('../../out/utils/errors');
const { retryWithBackoff } = require('../../out/utils/retry');

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
  assert.deepEqual(new Set(plan.agents.map(a => a.teamRole)), new Set(['researcher', 'strategist', 'architect', 'builder', 'critic', 'verifier']));
});

test('agent factory designTeam uses the model output when valid', async () => {
  const designed = {
    rationale: 'bespoke',
    agents: ROSTER.map((m, i) => ({ name: `Agent${i}`, specialty: `spec${i}`, model: m, tools: ['search'] })),
  };
  const factory = makeFactory({ callWithFallbackJson: async () => designed });
  const plan = await factory.designTeam('build something');
  assert.ok(plan.agents.length >= 6);
  assert.equal(plan.rationale, 'bespoke');
});

test('agent factory designTeam falls back to a generic team when the designer fails', async () => {
  const factory = makeFactory({ callWithFallbackJson: async () => { throw new Error('model down'); } });
  const plan = await factory.designTeam('build something');
  assert.ok(plan.agents.length >= 5);
  assert.match(plan.rationale, /generic team/i);
});

test('agent factory honors Stop instead of synthesizing a fallback team', async () => {
  const factory = makeFactory({ callWithFallbackJson: async () => { throw new UserAbortError(); } });
  await assert.rejects(factory.designTeam('build something'), UserAbortError);
});

test('dynamic retry never retries user cancellation', async () => {
  let calls = 0;
  await assert.rejects(retryWithBackoff(async () => { calls += 1; throw new UserAbortError(); }, { retries: 3, delayMs: 0 }), UserAbortError);
  assert.equal(calls, 1);
});

test('Stop during retry backoff prevents any further attempt', async () => {
  let calls = 0;
  let stopped = false;
  await assert.rejects(retryWithBackoff(async () => { calls += 1; throw new Error('transient'); }, {
    retries: 3, delayMs: 1000, shouldAbort: () => stopped,
  }, () => { stopped = true; }), UserAbortError);
  assert.equal(calls, 1);
});

test('dynamic debate propagates Stop in proposals and scorecards', async () => {
  const plan = { goal: 'goal', rationale: 'coverage', agents: makeSixRoleAgents(), generatedAt: new Date().toISOString() };
  let textCalls = 0;
  let scoreCalls = 0;
  const client = {
    callWithFallback: async () => { textCalls += 1; throw new UserAbortError(); },
    callWithFallbackJson: async () => { scoreCalls += 1; throw new UserAbortError(); },
  };
  const team = new DynamicTeam(client, undefined, 3, [], {}, { retries: 2, delayMs: 0 });
  await assert.rejects(team.run(plan), UserAbortError);
  assert.equal(textCalls, 1);
  client.callWithFallback = async () => 'A concrete proposal or response';
  await assert.rejects(team.run(plan), UserAbortError);
  assert.equal(scoreCalls, 1);
});

test('dynamic tool cancellation propagates without another model call', async () => {
  const spec = { id: 'a', name: 'A', specialty: 's', mission: 'm', systemPrompt: 'A', model: 'm1', fallbackModel: 'm2', tools: ['read_file'], temperature: 0.1 };
  let calls = 0;
  const agent = new DynamicAgent({ callWithFallback: async () => { calls += 1; return '{"tool":"read_file","args":{}}'; } }, spec, {
    execute: async () => { throw new UserAbortError(); },
  });
  await assert.rejects(agent.respond('read'), UserAbortError);
  assert.equal(calls, 1);
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

test('dynamic team compacts every participant into a bounded context window', () => {
  const team = new DynamicTeam(
    { callWithFallback: async () => '', callWithFallbackJson: async () => ({}) },
    undefined,
    3,
    [],
    { num_ctx: 4096, num_predict: 768 }
  );
  const blocks = Array.from({ length: 7 }, (_, index) => ({
    title: `agent-${index}`,
    content: `unique-${index} ${'detail '.repeat(2000)}`,
  }));
  const compacted = team._boundedBlocks(blocks, 0.6);
  assert.ok(compacted.length <= 6200, `expected bounded context, got ${compacted.length} chars`);
  for (let index = 0; index < blocks.length; index++) {
    assert.match(compacted, new RegExp(`unique-${index}`));
  }
});

test('fake Ollama integration runs five-model team through exactly four dependent debate rounds', async () => {
  const messagesSeen = [];
  const client = {
    callWithFallback: async (_model, _fallback, messages) => {
      const prompt = messages.at(-1).content;
      messagesSeen.push(prompt);
      if (/Critique the OTHER/.test(prompt)) return 'CRITIQUE: concrete risk and mitigation';
      if (/Refine YOUR/.test(prompt)) return 'REFINED: accepted the critique; assumptions, risks, tools, completion criteria, tests';
      return 'PROPOSAL: assumptions, approach, risks, tools, completion criteria, tests';
    },
    callWithFallbackJson: async (_model, _fallback, messages) => {
      const ids = [...messages.at(-1).content.matchAll(/### id: ([^\n]+)/g)].map(match => match[1]);
      return {
        scores: ids.map(proposalId => ({
          proposalId,
          criteria: { feasibility: 8, completeness: 8, safety: 8, resourceCost: 8, testability: 8 },
          reason: 'deterministic',
        })),
      };
    },
  };
  const roles = ['researcher', 'strategist', 'architect', 'builder', 'critic', 'verifier'];
  const plan = {
    goal: 'Build a verified tool', rationale: 'coverage', generatedAt: new Date().toISOString(),
    agents: roles.map((teamRole, index) => ({
      id: teamRole, name: teamRole, specialty: teamRole, mission: teamRole,
      systemPrompt: `You are ${teamRole}`, model: `m${(index % 5) + 1}`,
      fallbackModel: `m${((index + 1) % 5) + 1}`, tools: [], temperature: 0.1, teamRole,
    })),
  };
  const rounds = [];
  const { decision, transcript } = await new DynamicTeam(client, undefined, 3, ['m6']).run(plan, {
    onRound: round => rounds.push(round),
  });
  assert.deepEqual(rounds, [1, 2, 3, 4]);
  assert.match(transcript, /Round 1 — Proposals/);
  assert.match(transcript, /Round 2 — Cross-critique/);
  assert.match(transcript, /Round 3 — Refined proposals/);
  assert.match(transcript, /Round 4 — Scores/);
  assert.equal(decision.weightedScore, 8);
  assert.equal(decision.tieBreakerModel, 'm6');
  const refinementPrompts = messagesSeen.filter(prompt => /Refine YOUR/.test(prompt));
  assert.equal(refinementPrompts.length, 6);
  assert.ok(refinementPrompts.every(prompt => /CRITIQUE: concrete risk/.test(prompt)));
});

function makeDeterministicClient() {
  return {
    callWithFallback: async (_model, _fallback, messages) => {
      const prompt = messages.at(-1).content;
      if (/Critique the OTHER/.test(prompt)) return 'CRITIQUE: concrete risk and mitigation';
      if (/Refine YOUR/.test(prompt)) return 'REFINED: accepted the critique; assumptions, risks, tools, completion criteria, tests';
      return 'PROPOSAL: assumptions, approach, risks, tools, completion criteria, tests';
    },
    callWithFallbackJson: async (_model, _fallback, messages) => {
      const ids = [...messages.at(-1).content.matchAll(/### id: ([^\n]+)/g)].map(match => match[1]);
      return {
        scores: ids.map(proposalId => ({
          proposalId,
          criteria: { feasibility: 8, completeness: 8, safety: 8, resourceCost: 8, testability: 8 },
          reason: 'deterministic',
        })),
      };
    },
  };
}

function sixRolePlan() {
  return { goal: 'Build a verified tool', rationale: 'coverage', generatedAt: new Date().toISOString(), agents: makeSixRoleAgents() };
}

test('DynamicTeam.run() checkpoints every single agent/judge turn, not just once per round', async () => {
  const plan = sixRolePlan();
  const checkpoints = [];
  const { decision } = await new DynamicTeam(makeDeterministicClient(), undefined, 3, ['m6']).run(plan, {
    onCheckpoint: checkpoint => checkpoints.push(checkpoint),
  });

  // 6 agents: one checkpoint per agent turn plus one round-boundary checkpoint,
  // for each of the 4 rounds; round 4 also gets a tie-break checkpoint since
  // the deterministic fixture scores every proposal identically (a tie).
  assert.equal(checkpoints.length, 28, `expected 28 checkpoints (per-turn, not per-round), got ${checkpoints.length}`);
  const round1 = checkpoints.filter(c => c.round === 1);
  assert.equal(round1.length, 6, 'round 1 should checkpoint after each of the 6 agents individually');
  assert.deepEqual(round1.map(c => c.completedAgentIds.length), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(round1.map(c => c.proposals.length), [1, 2, 3, 4, 5, 6], 'proposals accumulate one at a time');

  const lastCheckpoint = checkpoints.at(-1);
  assert.equal(lastCheckpoint.round, 4);
  assert.ok(lastCheckpoint.completedAgentIds.includes('tie-breaker'));
  assert.equal(lastCheckpoint.scores.length, 42, '6 proposals scored by 6 main judges + 1 tie-breaker');
  assert.equal(decision.tieBreakerModel, 'm6');
});

test('DynamicTeam.run() resumes from a partial checkpoint, skipping every turn already completed', async () => {
  const plan = sixRolePlan();

  // Capture a real mid-round-3 checkpoint (3 of 6 agents refined) from an
  // uninstrumented run, simulating "the process crashed right here."
  const checkpoints = [];
  await new DynamicTeam(makeDeterministicClient(), undefined, 3, ['m6']).run(plan, {
    onCheckpoint: checkpoint => checkpoints.push(checkpoint),
  });
  const midRound3 = checkpoints.find(c => c.round === 3 && c.completedAgentIds.length === 3);
  assert.ok(midRound3, 'expected a mid-round-3 checkpoint with exactly 3 completed agents');

  const calls = { propose: 0, critique: 0, refine: 0 };
  const resumeClient = {
    callWithFallback: async (_model, _fallback, messages) => {
      const prompt = messages.at(-1).content;
      if (/Critique the OTHER/.test(prompt)) { calls.critique += 1; return 'CRITIQUE: concrete risk and mitigation'; }
      if (/Refine YOUR/.test(prompt)) { calls.refine += 1; return 'REFINED: accepted the critique; assumptions, risks, tools, completion criteria, tests'; }
      calls.propose += 1;
      return 'PROPOSAL: assumptions, approach, risks, tools, completion criteria, tests';
    },
    callWithFallbackJson: makeDeterministicClient().callWithFallbackJson,
  };

  const { decision } = await new DynamicTeam(resumeClient, undefined, 3, ['m6']).run(plan, {}, midRound3);
  assert.equal(calls.propose, 0, 'round 1 must not be re-run on resume');
  assert.equal(calls.critique, 0, 'round 2 must not be re-run on resume');
  assert.equal(calls.refine, 3, 'only the 3 not-yet-refined agents should be called on resume');
  assert.equal(decision.ranked.length, 6);
  assert.equal(decision.weightedScore, 8);
});

test('DynamicTeam.run() ignores a resume checkpoint for a different goal', async () => {
  const plan = sixRolePlan();
  const foreignCheckpoint = {
    goal: 'a completely different goal', round: 3,
    originals: [], proposals: [], critiques: [], scores: [], completedAgentIds: ['researcher', 'strategist', 'architect'],
    transcript: '# stale', updatedAt: new Date().toISOString(),
  };
  let proposeCalls = 0;
  const client = {
    callWithFallback: async (_model, _fallback, messages) => {
      const prompt = messages.at(-1).content;
      if (/Critique the OTHER/.test(prompt)) return 'CRITIQUE: concrete risk and mitigation';
      if (/Refine YOUR/.test(prompt)) return 'REFINED: accepted the critique; assumptions, risks, tools, completion criteria, tests';
      proposeCalls += 1;
      return 'PROPOSAL: assumptions, approach, risks, tools, completion criteria, tests';
    },
    callWithFallbackJson: makeDeterministicClient().callWithFallbackJson,
  };
  await new DynamicTeam(client, undefined, 3, ['m6']).run(plan, {}, foreignCheckpoint);
  assert.equal(proposeCalls, 6, 'a checkpoint for a different goal must be ignored, not misapplied');
});

test('dynamic agent retries a failed call against its own model, never the fallback', async () => {
  const spec = { id: 'a', name: 'A', specialty: 's', mission: 'm', systemPrompt: 'You are A.', model: 'm1', fallbackModel: 'm2', tools: [], temperature: 0.4 };
  const modelsCalled = [];
  let attempts = 0;
  const client = {
    callWithFallback: async model => {
      modelsCalled.push(model);
      attempts += 1;
      if (attempts < 2) { throw new Error('llama-server process has terminated: signal: bus error'); }
      return 'RECOVERED ANSWER';
    },
  };
  const agent = new DynamicAgent(client, spec, undefined, 3, {}, { retries: 2, delayMs: 0 });
  const out = await agent.respond('do the thing');
  assert.equal(out, 'RECOVERED ANSWER');
  assert.deepEqual(modelsCalled, ['m1', 'm1'], 'retry must target the exact same model, never the fallback');
});

test('dynamic agent gives up after exhausting retries and surfaces the last error', async () => {
  const spec = { id: 'a', name: 'A', specialty: 's', mission: 'm', systemPrompt: 'You are A.', model: 'm1', fallbackModel: 'm2', tools: [], temperature: 0.4 };
  let attempts = 0;
  const client = { callWithFallback: async () => { attempts += 1; throw new Error('permanent crash'); } };
  const agent = new DynamicAgent(client, spec, undefined, 3, {}, { retries: 2, delayMs: 0 });
  await assert.rejects(() => agent.respond('do the thing'), /permanent crash/);
  assert.equal(attempts, 3, 'one initial attempt plus two retries');
});

test('dynamic agent makes a single attempt when no retry policy is configured (default)', async () => {
  const spec = { id: 'a', name: 'A', specialty: 's', mission: 'm', systemPrompt: 'You are A.', model: 'm1', fallbackModel: 'm2', tools: [], temperature: 0.4 };
  let attempts = 0;
  const client = { callWithFallback: async () => { attempts += 1; throw new Error('boom'); } };
  const agent = new DynamicAgent(client, spec, undefined, 3, {});
  await assert.rejects(() => agent.respond('x'));
  assert.equal(attempts, 1);
});

function makeSixRoleAgents() {
  const roles = ['researcher', 'strategist', 'architect', 'builder', 'critic', 'verifier'];
  return roles.map((teamRole, index) => ({
    id: teamRole, name: teamRole, specialty: teamRole, mission: teamRole,
    systemPrompt: `You are ${teamRole}`, model: `m${(index % 5) + 1}`,
    fallbackModel: `m${((index + 1) % 5) + 1}`, tools: [], temperature: 0.1, teamRole,
  }));
}

function completeScorecard(agents, score = 8) {
  return { scores: agents.map(agent => ({ proposalId: agent.id, criteria: {
    feasibility: score, completeness: score, safety: score, resourceCost: score, testability: score,
  }, reason: 'Concrete test evidence' })) };
}

test('scorecards reject omissions, duplicates, missing criteria and non-numeric or out-of-range scores', () => {
  const team = new DynamicTeam({ callWithFallback: async () => '', callWithFallbackJson: async () => ({}) });
  const agents = makeSixRoleAgents();
  const proposals = agents.map(agent => ({ agentId: agent.id, agentName: agent.name, proposal: 'Plan' }));
  assert.equal(team._validateScorecard(completeScorecard(agents), proposals, 'judge').length, agents.length);
  const malformed = [
    { scores: completeScorecard(agents).scores.slice(0, 1) },
    { scores: [...completeScorecard(agents).scores, completeScorecard(agents).scores[0]] },
    { scores: agents.map(agent => ({ proposalId: agent.id, criteria: {} })) },
    { scores: agents.map(agent => ({ proposalId: agent.id, score: 8 })) },
  ];
  for (const value of [undefined, null, '8', true, NaN, Infinity, -1, 11]) {
    const card = completeScorecard(agents);
    card.scores[0].criteria.testability = value;
    malformed.push(card);
  }
  for (const card of malformed) {
    assert.throws(() => team._validateScorecard(card, proposals, 'judge'), /missing|duplicate|numeric|number/i);
  }
});

test('invalid scorecard retries the same exact model with an actionable correction', async () => {
  const agents = makeSixRoleAgents();
  const proposals = agents.map(agent => ({ agentId: agent.id, agentName: agent.name, proposal: 'Plan' }));
  const called = [];
  const feedback = [];
  const team = new DynamicTeam({
    callWithFallback: async () => '',
    callWithFallbackJson: async () => { throw new Error('A different model must not substitute for the judge'); },
    chatJson: async (model, messages) => {
      called.push(model);
      feedback.push(messages.at(-1).content);
      return called.length === 1 ? { scores: completeScorecard(agents).scores.slice(0, 1) } : completeScorecard(agents);
    },
  }, undefined, 3, [], {}, { retries: 1, delayMs: 0 });
  const scores = await team._scoreWithModel('exact-model', proposals, 'Goal', 'judge');
  assert.deepEqual(called, ['exact-model', 'exact-model']);
  assert.match(feedback[1], /Missing scores for proposals:/);
  assert.equal(scores.length, agents.length);
});

test('five-model scoring gate rejects a partial fifth judge instead of crediting invented scores', async () => {
  const agents = makeSixRoleAgents();
  const team = new DynamicTeam({
    callWithFallback: async () => 'A concrete independent proposal, critique or refinement.',
    callWithFallbackJson: async model => model === 'm5' ? { scores: completeScorecard(agents).scores.slice(0, 1) } : completeScorecard(agents),
  });
  await assert.rejects(team.run({ goal: 'Goal', rationale: '', agents, generatedAt: '' }), /only 4 distinct models returned valid scorecards/);
});

test('every judge sees bounded evidence from all participants in all three earlier rounds', async () => {
  const agents = makeSixRoleAgents();
  const prompts = [];
  const team = new DynamicTeam({
    callWithFallback: async (_model, _fallback, messages, role) => {
      const phase = /Refine YOUR/.test(messages.at(-1).content) ? 'R3' : /Critique the OTHER/.test(messages.at(-1).content) ? 'R2' : 'R1';
      return `${phase}-${role.replace('dynamic:', '')} ${'detailed evidence '.repeat(2000)}`;
    },
    callWithFallbackJson: async (_model, _fallback, messages) => {
      prompts.push(messages.map(message => message.content).join('\n'));
      return completeScorecard(agents);
    },
  }, undefined, 3, [], { num_ctx: 4096 });
  await team.run({ goal: 'Goal', rationale: '', agents, generatedAt: '' });
  assert.equal(prompts.length, agents.length);
  for (const prompt of prompts) {
    assert.ok(prompt.length < 11500, `judging prompt must stay bounded: ${prompt.length}`);
    for (const agent of agents) {
      for (const phase of ['R1', 'R2', 'R3']) { assert.ok(prompt.includes(`${phase}-${agent.id}`)); }
    }
  }
});

test('an empty reserve scorecard never claims a tie was resolved', async () => {
  const agents = makeSixRoleAgents();
  const events = [];
  const team = new DynamicTeam({
    callWithFallback: async () => 'Concrete proposal or response',
    callWithFallbackJson: async model => model === 'm6' ? { scores: [] } : completeScorecard(agents),
  }, undefined, 3, ['m6']);
  const { decision } = await team.run({ goal: 'Goal', rationale: '', agents, generatedAt: '' }, {
    onAgent: (_round, id, summary) => { if (id === 'tie-breaker') events.push(summary); },
  });
  assert.equal(decision.tieBreakerModel, undefined);
  assert.match(decision.rationale, /tie remains unresolved/);
  assert.ok(events.every(event => !/resolved a|widened/i.test(event)));
});

test('a valid reserve scorecard that leaves equal rankings reports the tie honestly', async () => {
  const agents = makeSixRoleAgents();
  const events = [];
  const team = new DynamicTeam({
    callWithFallback: async () => 'Concrete proposal or response',
    callWithFallbackJson: async () => completeScorecard(agents),
  }, undefined, 3, ['m6']);
  const { decision } = await team.run({ goal: 'Goal', rationale: '', agents, generatedAt: '' }, {
    onAgent: (_round, id, summary) => { if (id === 'tie-breaker') events.push(summary); },
  });
  assert.equal(decision.tieBreakerModel, 'm6');
  assert.match(decision.rationale, /ranking remains provisional/);
  assert.ok(events.every(event => !/resolved a|widened/i.test(event)));
});

test('a transient crash mid-debate is recovered via same-model retry instead of blocking the whole run', async () => {
  // Reproduces a real failure: round 3 crashed once for one agent (Ollama's
  // llama-server process died), which previously took down an otherwise
  // fully-succeeding two-round debate with zero retries.
  // Two agents share model "m1" (6 roles, 5 distinct models), so the crash is
  // keyed off the agent id (the 4th call arg), not the model name.
  let researcherRefineCalls = 0;
  const client = {
    callWithFallback: async (_model, _fallback, messages, agentRole) => {
      const prompt = messages.at(-1).content;
      if (agentRole === 'dynamic:researcher' && /Refine YOUR/.test(prompt)) {
        researcherRefineCalls += 1;
        if (researcherRefineCalls === 1) {
          throw new Error('Ollama API error 500: {"error":"llama-server process has terminated: signal: bus error"}');
        }
      }
      if (/Critique the OTHER/.test(prompt)) return 'CRITIQUE: concrete risk and mitigation';
      if (/Refine YOUR/.test(prompt)) return 'REFINED: accepted the critique; assumptions, risks, tools, completion criteria, tests';
      return 'PROPOSAL: assumptions, approach, risks, tools, completion criteria, tests';
    },
    callWithFallbackJson: async (_model, _fallback, messages) => {
      const ids = [...messages.at(-1).content.matchAll(/### id: ([^\n]+)/g)].map(match => match[1]);
      return {
        scores: ids.map(proposalId => ({
          proposalId, criteria: { feasibility: 8, completeness: 8, safety: 8, resourceCost: 8, testability: 8 }, reason: 'deterministic',
        })),
      };
    },
  };
  const plan = { goal: 'Build a verified tool', rationale: 'coverage', generatedAt: new Date().toISOString(), agents: makeSixRoleAgents() };
  const { decision } = await new DynamicTeam(client, undefined, 3, [], {}, { retries: 1, delayMs: 0 }).run(plan, {});
  assert.ok(decision.winningAgentId, 'the debate must still converge despite one transient crash');
  assert.equal(researcherRefineCalls, 2, 'the crashed call must be retried exactly once, against the same model');
});

test('without a retry policy, the same transient crash still blocks the whole debate (baseline)', async () => {
  const client = {
    callWithFallback: async model => {
      if (model === 'm1') { throw new Error('llama-server process has terminated: signal: bus error'); }
      return 'PROPOSAL: assumptions, approach, risks, tools, completion criteria, tests';
    },
    callWithFallbackJson: async () => ({ scores: [] }),
  };
  const plan = { goal: 'Build a verified tool', rationale: 'coverage', generatedAt: new Date().toISOString(), agents: makeSixRoleAgents() };
  await assert.rejects(() => new DynamicTeam(client, undefined, 3, []).run(plan, {}), /Dynamic debate blocked/);
});

test('dynamic agent returns plain text when it has no tools', async () => {
  const spec = { id: 'a', name: 'A', specialty: 's', mission: 'm', systemPrompt: 'You are A.', model: 'm1', fallbackModel: 'm2', tools: [], temperature: 0.4 };
  let options;
  const agent = new DynamicAgent({
    callWithFallback: async (_model, _fallback, _messages, _role, received) => {
      options = received;
      return '  the answer  ';
    },
  }, spec, undefined, 3, { num_ctx: 4096, num_predict: 768 });
  const out = await agent.respond('do the thing');
  assert.equal(out, 'the answer');
  assert.deepEqual(options, { num_ctx: 4096, num_predict: 768, temperature: 0.4 });
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
