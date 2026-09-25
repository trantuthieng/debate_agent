const assert = require('node:assert/strict');
const test = require('node:test');

const { QaDebate } = require('../../out/dynamic/QaDebate');
const { buildQaAgentSpecs, MIN_QA_AGENTS, MAX_QA_AGENTS } = require('../../out/prompts/qaPersonas');
const { UserAbortError } = require('../../out/utils/errors');

function makeSpecs(count = 3) {
  return buildQaAgentSpecs(count, Array.from({ length: count }, (_, i) => `model-${i}`));
}

function makeClient({ onCall } = {}) {
  const calls = [];
  return {
    calls,
    callWithFallback: async (primaryModel, fallbackModel, messages, agentRole) => {
      const entry = { model: primaryModel, agentRole, prompt: messages.at(-1).content };
      calls.push(entry);
      if (onCall) { const out = onCall(entry); if (out !== undefined) { return out; } }
      if (agentRole === 'qa-synthesizer') { return 'FINAL ANSWER: buy it.'; }
      if (/Đọc các quan điểm/.test(entry.prompt)) { return `REVISED stance from ${agentRole}`; }
      return `INITIAL position from ${agentRole}`;
    },
  };
}

test('buildQaAgentSpecs clamps agent count to [MIN_QA_AGENTS, MAX_QA_AGENTS] and assigns distinct models', () => {
  const specs = buildQaAgentSpecs(3, ['m1', 'm2', 'm3']);
  assert.equal(specs.length, 3);
  assert.deepEqual(new Set(specs.map(s => s.model)).size, 3);

  const tooFew = buildQaAgentSpecs(1, ['m1', 'm2', 'm3']);
  assert.equal(tooFew.length, MIN_QA_AGENTS);

  const tooMany = buildQaAgentSpecs(99, ['m1', 'm2', 'm3']);
  assert.equal(tooMany.length, MAX_QA_AGENTS);
});

test('QaDebate.run() with rounds:1 is a quick mode — no revision round, just propose + synthesize', async () => {
  const client = makeClient();
  const specs = makeSpecs(3);
  const debate = new QaDebate(client);
  const rounds = [];
  const { answer, transcript } = await debate.run('Should I buy iPhone 18?', specs, 1, '', {
    onRound: (round, label) => rounds.push({ round, label }),
  });

  assert.equal(client.calls.filter(c => /Đọc các quan điểm/.test(c.prompt)).length, 0, 'quick mode must skip the revision round entirely');
  assert.equal(client.calls.filter(c => c.agentRole === 'qa-synthesizer').length, 1);
  assert.equal(answer, 'FINAL ANSWER: buy it.');
  assert.match(transcript, /Round 1 — Initial positions/);
  assert.match(transcript, /## Synthesis/);
  assert.deepEqual(rounds.map(r => r.round), [1, 2]); // round 1 (propose) + round 2 as "synthesis" marker
});

test('QaDebate.run() with rounds:3 runs exactly 2 revision rounds reading peers\' latest positions', async () => {
  const client = makeClient();
  const specs = makeSpecs(4);
  const debate = new QaDebate(client);
  const { transcript } = await debate.run('Should I buy iPhone 18?', specs, 3, '', {});

  const revisionCalls = client.calls.filter(c => /Đọc các quan điểm/.test(c.prompt));
  assert.equal(revisionCalls.length, 8, '4 agents x 2 revision rounds (rounds 2 and 3)');
  assert.match(transcript, /Round 2 — Debate/);
  assert.match(transcript, /Round 3 — Debate/);
});

test('each revision round sees the PREVIOUS round\'s positions, not stale round-1 text, once revised', async () => {
  let round2Seen = null;
  const client = makeClient({
    onCall: entry => {
      if (entry.agentRole === 'dynamic:objective-analyst' && /Đọc các quan điểm/.test(entry.prompt)) {
        round2Seen = entry.prompt;
      }
      return undefined;
    },
  });
  const specs = makeSpecs(3);
  const debate = new QaDebate(client);
  await debate.run('Q?', specs, 2, '', {});
  assert.ok(round2Seen, 'objective-analyst should have been asked to revise in round 2');
  assert.match(round2Seen, /INITIAL position from/, 'round 2 must see round-1 initial positions from peers');
});

test('agent progress events include the full agent answer instead of a clipped preview', async () => {
  const longAnswer = `${'đầy đủ '.repeat(40)}kết thúc`;
  const client = makeClient({ onCall: entry => entry.agentRole === 'qa-synthesizer' ? 'FINAL' : longAnswer });
  const specs = makeSpecs(3);
  const debate = new QaDebate(client);
  const events = [];
  await debate.run('Q?', specs, 1, '', {
    onAgent: (_round, _id, summary) => events.push(summary),
  });
  assert.ok(events.length > 0);
  assert.equal(events[0], longAnswer);
  assert.doesNotMatch(events[0], /…$/);
});

test('shared research context is passed to round 1 and to synthesis, not silently dropped', async () => {
  const seenPrompts = [];
  const client = makeClient({
    onCall: entry => { seenPrompts.push(entry); return undefined; },
  });
  const specs = makeSpecs(3);
  const debate = new QaDebate(client);
  await debate.run('Q?', specs, 1, 'iPhone 18 rumored to launch at $999 per TechSite.', {});

  assert.ok(seenPrompts.some(c => c.agentRole !== 'qa-synthesizer' && /iPhone 18 rumored/.test(c.prompt)), 'round 1 agents must see the research context');
  assert.ok(seenPrompts.some(c => c.agentRole === 'qa-synthesizer' && /iPhone 18 rumored/.test(c.prompt)), 'synthesis must see the research context');
});

test('a failed agent call in any round blocks the whole debate with a descriptive error', async () => {
  const client = {
    callWithFallback: async (_p, _f, _messages, agentRole) => {
      if (agentRole === 'dynamic:skeptical-advisor') { throw new Error('model crashed'); }
      return 'ok';
    },
  };
  const specs = makeSpecs(3);
  const debate = new QaDebate(client);
  await assert.rejects(debate.run('Q?', specs, 1, '', {}), /skeptical-advisor.*round 1/s);
});

test('UserAbortError propagates without being wrapped into a generic error', async () => {
  const client = {
    callWithFallback: async () => { throw new UserAbortError(); },
  };
  const specs = makeSpecs(3);
  const debate = new QaDebate(client);
  await assert.rejects(debate.run('Q?', specs, 1, '', {}), UserAbortError);
});

test('run() rejects fewer than 2 agents', async () => {
  const client = makeClient();
  const debate = new QaDebate(client);
  await assert.rejects(debate.run('Q?', makeSpecs(3).slice(0, 1), 1, '', {}), /at least 2 agents/);
});

test('an empty synthesis answer is treated as a failure, not silently returned', async () => {
  const client = {
    callWithFallback: async (_p, _f, _messages, agentRole) => (agentRole === 'qa-synthesizer' ? '   ' : 'position'),
  };
  const specs = makeSpecs(3);
  const debate = new QaDebate(client);
  await assert.rejects(debate.run('Q?', specs, 1, '', {}), /empty answer/);
});
