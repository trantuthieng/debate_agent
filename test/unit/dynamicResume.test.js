const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DynamicTeam } = require('../../out/dynamic/DynamicTeam');
const { UserAbortError } = require('../../out/utils/errors');
const { initLogger } = require('../../out/utils/logging');

// Same shape as the failed live run: six roles, five distinct models, the
// second judge has no valid card but all later judges are already finished.
function fixture() {
  const agents = [1, 2, 3, 4, 5, 3].map((model, i) => ({
    id: `agent-${i}`, name: `Agent ${i}`, specialty: 'verification', mission: 'verify',
    systemPrompt: 'Verify', model: `m${model}`, fallbackModel: 'm1', tools: [], temperature: 0.1,
  }));
  const plan = { goal: 'Verify a browser game', rationale: '', agents, generatedAt: '' };
  const proposals = agents.map(a => ({ agentId: a.id, agentName: a.name, proposal: 'Saved proposal' }));
  const card = { scores: agents.map((a, i) => ({ proposalId: a.id, reason: 'Saved evidence', criteria: {
    feasibility: i === 0 ? 9 : 7, completeness: 8, safety: 8, resourceCost: 8, testability: 8,
  } })) };
  const validator = new DynamicTeam({});
  const checkpoint = {
    goal: plan.goal, round: 4, proposals, originals: proposals,
    critiques: agents.map(a => ({ agentId: a.id, agentName: a.name, critique: 'Saved critique' })),
    completedAgentIds: agents.map(a => a.id),
    scores: agents.flatMap(a => validator._validateScorecard(structuredClone(card), proposals, a.id)),
    transcript: '# Saved rounds 1–3', updatedAt: '',
  };
  return { plan, checkpoint, card, missing: agents[1] };
}

for (const corruption of ['missing', 'partial', 'duplicate', 'invalid criterion']) {
  test(`R4 Resume repairs a middle judge with ${corruption} scores despite legacy completed flags`, async () => {
    const { plan, checkpoint, card, missing } = fixture();
    const saved = checkpoint.scores.filter(s => s.judgeId !== missing.id);
    if (corruption === 'missing') checkpoint.scores = saved;
    if (corruption === 'partial') checkpoint.scores.splice(6, 1);
    if (corruption === 'duplicate') checkpoint.scores.push(checkpoint.scores[6]);
    if (corruption === 'invalid criterion') checkpoint.scores[6].criteria.safety = '8';
    const before = JSON.stringify(checkpoint);
    const calls = [];
    const snapshots = [];
    const client = {
      callWithFallback: async () => assert.fail('R1–R3 must not run again'),
      callWithFallbackJson: async () => assert.fail('No model substitution'),
      chatJson: async (model, _messages, role) => { calls.push({ model, role }); return card; },
    };
    const { decision } = await new DynamicTeam(client).run(plan, {
      onCheckpoint: c => snapshots.push(c),
    }, checkpoint);
    assert.deepEqual(calls, [{ model: missing.model, role: `dynamic-judge:${missing.id}` }]);
    assert.equal(decision.ranked.length, 6);
    assert.equal(snapshots[0].completedAgentIds.includes(missing.id), false);
    const last = snapshots.at(-1);
    assert.equal(last.scores.length, 36);
    assert.deepEqual(last.scores.filter(s => s.judgeId !== missing.id), saved);
    assert.equal(new Set(last.scores.map(s => `${s.judgeId}/${s.proposalId}`)).size, 36);
    assert.equal(JSON.stringify(checkpoint), before, 'Do not mutate the supplied checkpoint');
  });
}

test('valid scorecards are reused even with absent completion flags; duplicate model cannot satisfy gate', async () => {
  const { plan, checkpoint, card, missing } = fixture();
  checkpoint.completedAgentIds = [];
  checkpoint.scores = checkpoint.scores.filter(s => s.judgeId !== missing.id);
  const calls = [];
  let persisted;
  const team = new DynamicTeam({
    chatJson: async model => { calls.push(model); return { scores: card.scores.slice(0, 1) }; },
  }, undefined, 3, [], {}, { retries: 1, delayMs: 0 });
  await assert.rejects(team.run(plan, { onCheckpoint: c => { persisted = c; } }, checkpoint),
    /only 4 distinct models returned valid scorecards/);
  assert.deepEqual(calls, [missing.model, missing.model]);
  assert.equal(persisted.completedAgentIds.includes(missing.id), false);
  assert.equal(persisted.scores.length, 30);
  // The next invocation gets another bounded opportunity, not an instant failure.
  team.client.chatJson = async model => { calls.push(model); return card; };
  await team.run(plan, {}, persisted);
  assert.deepEqual(calls, [missing.model, missing.model, missing.model]);
});

test('R4 cancellation preserves valid judges and leaves missing judge resumable', async () => {
  const { plan, checkpoint, missing } = fixture();
  checkpoint.scores = checkpoint.scores.filter(s => s.judgeId !== missing.id);
  let persisted;
  let calls = 0;
  await assert.rejects(new DynamicTeam({ chatJson: async () => {
    calls++; throw new UserAbortError();
  } }, undefined, 3, [], {}, { retries: 2, delayMs: 0 }).run(plan, {
    onCheckpoint: c => { persisted = c; },
  }, checkpoint), UserAbortError);
  assert.equal(calls, 1);
  assert.equal(persisted.scores.length, 30);
  assert.equal(persisted.completedAgentIds.includes(missing.id), false);
});

test('judge prompt enumerates all six rows and an unfilled template cannot become votes', async () => {
  const { plan, checkpoint, missing, card } = fixture();
  checkpoint.scores = checkpoint.scores.filter(s => s.judgeId !== missing.id);
  let calls = 0;
  const team = new DynamicTeam({ chatJson: async (_model, messages) => {
    const template = JSON.parse(messages[1].content.split('do not omit rows:\n')[1]);
    assert.deepEqual(template.scores.map(s => s.proposalId), plan.agents.map(a => a.id));
    assert(template.scores.every(s => Object.values(s.criteria).every(value => value === null)));
    if (++calls === 1) return template;
    assert.match(messages.at(-1).content, /must be an explicit finite JSON number/);
    return card;
  } }, undefined, 3, [], {}, { retries: 1, delayMs: 0 });
  await team.run(plan, {}, checkpoint);
  assert.equal(calls, 2);
});

test('scorecard diagnostics persist every attempt including final schema rejection', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-score-log-'));
  const file = path.join(dir, 'diagnostics.log');
  const lines = [];
  initLogger({ appendLine: line => lines.push(line) }, file);
  t.after(() => { initLogger({ appendLine() {} }, ''); fs.rmSync(dir, { recursive: true, force: true }); });
  const { plan, checkpoint, missing } = fixture();
  checkpoint.scores = checkpoint.scores.filter(s => s.judgeId !== missing.id);
  let calls = 0;
  const team = new DynamicTeam({ chatJson: async () => {
    if (++calls === 1) throw new Error('Invalid JSON response');
    return { scores: [] };
  } }, undefined, 3, [], {}, { retries: 1, delayMs: 0 });
  await assert.rejects(team.run(plan, {}, checkpoint), /only 4 distinct models/);
  const log = fs.readFileSync(file, 'utf8');
  assert.match(log, /agent-1.*m2.*model\/JSON.*attempt 1\/2.*Invalid JSON response/);
  assert.match(log, /agent-1.*m2.*schema validation.*attempt 2\/2.*Missing scores for proposals/);
  assert.match(log, /Retry budget exhausted; judge remains incomplete/);
  assert.equal(log, lines.join('\n') + '\n');
});
