/**
 * Replay ONLY Round 4 against genuine saved R1/R2/R3 text.
 * Usage: node test/replay_debate_scoring.js <workspace> [--run] [--output <new-dir>]
 * Without --run this validates saved inputs and writes provenance; no HTTP/LLM calls.
 * This is a pipeline replay, not a fresh end-to-end run. It never updates the
 * original decision, project files, or the direction chosen for the existing build.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { OllamaClient } = require('../out/ollama/OllamaClient');
const { DynamicTeam } = require('../out/dynamic/DynamicTeam');
const { UserAbortError } = require('../out/utils/errors');

const repository = path.resolve(__dirname, '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const normalizeModel = name => name.trim().toLowerCase().replace(/:latest$/, '');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

function parseDebateTranscript(plan, transcript, decision) {
  if (!Array.isArray(plan.agents) || plan.agents.length < 5) throw new Error('Saved plan must contain at least five agents.');
  if (new Set(plan.agents.map(agent => agent.id)).size !== plan.agents.length) throw new Error('Saved plan has duplicate agent IDs.');
  if (new Set(plan.agents.map(agent => agent.name)).size !== plan.agents.length) throw new Error('Saved plan has ambiguous duplicate agent names.');
  if (new Set(plan.agents.map(agent => normalizeModel(agent.model))).size < 5) throw new Error('Saved plan has fewer than five distinct model names.');
  if (!transcript.includes(`**Goal:** ${plan.goal}\n`)) throw new Error('Saved transcript goal does not match the plan.');
  if (decision.goal !== plan.goal) throw new Error('Saved decision goal does not match the plan.');
  const lines = transcript.replace(/\r\n/g, '\n').split('\n');
  const outsideFence = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (!fence) outsideFence.push(i);
  }
  if (fence) throw new Error('Saved transcript contains an unclosed code fence; section boundaries are ambiguous.');
  const roundTitles = ['## Round 1 — Proposals', '## Round 2 — Cross-critique', '## Round 3 — Refined proposals', '## Round 4 — Scores'];
  const starts = roundTitles.map(title => {
    const matches = outsideFence.filter(index => lines[index] === title);
    if (matches.length !== 1) throw new Error(`Expected exactly one ${title}; found ${matches.length}.`);
    return matches[0];
  });
  if (starts.some((start, index) => index > 0 && start <= starts[index - 1])) throw new Error('Saved rounds are not in chronological order.');
  const sections = [];
  for (let round = 0; round < 3; round++) {
    const roundStart = starts[round];
    const roundEnd = starts[round + 1];
    const headers = plan.agents.map(agent => `### ${agent.name}${round === 0 ? ` (${agent.id})` : ''}`);
    const positions = headers.map(header => {
      const matches = outsideFence.filter(index => index > roundStart && index < roundEnd && lines[index] === header);
      if (matches.length !== 1) throw new Error(`Round ${round + 1}: expected one exact participant header ${header}; found ${matches.length}.`);
      return matches[0];
    });
    if (positions.some((start, index) => index > 0 && start <= positions[index - 1])) throw new Error(`Round ${round + 1}: participant order differs from the saved plan.`);
    sections.push(plan.agents.map((agent, index) => {
      const start = positions[index] + 1;
      const end = positions[index + 1] ?? roundEnd;
      const text = lines.slice(start, end).join('\n').trim();
      if (!text) throw new Error(`Round ${round + 1}: empty saved response for ${agent.id}.`);
      return { agentId: agent.id, agentName: agent.name, text, startLine: start + 1, endLine: end, sha256: hash(text) };
    }));
  }
  if (!Array.isArray(decision.ranked) || decision.ranked.length !== plan.agents.length) throw new Error('Saved decision does not contain one refined proposal per agent.');
  for (const section of sections[2]) {
    const matches = decision.ranked.filter(item => item.agentId === section.agentId);
    if (matches.length !== 1 || matches[0].proposal.trim() !== section.text) throw new Error(`Saved R3 response for ${section.agentId} does not exactly match its recorded decision proposal.`);
  }
  return {
    history: {
      originals: sections[0].map(item => ({ agentId: item.agentId, agentName: item.agentName, proposal: item.text })),
      critiques: sections[1].map(item => ({ agentId: item.agentId, agentName: item.agentName, critique: item.text })),
    },
    proposals: sections[2].map(item => ({ agentId: item.agentId, agentName: item.agentName, proposal: item.text })),
    sections: sections.map((items, round) => ({ round: round + 1, participants: items.map(({ text, ...item }) => ({ ...item, characters: text.length })) })),
  };
}

function loadReplayInputs(workspace) {
  const agentDir = path.join(path.resolve(workspace), '.agent-workspace');
  const files = {
    plan: path.join(agentDir, 'agents', 'dynamic_team_plan.json'),
    transcript: path.join(agentDir, 'agents', 'dynamic_team_debate.md'),
    decision: path.join(agentDir, 'agents', 'dynamic_team_decision.json'),
    readiness: path.join(agentDir, 'logs', 'model_readiness.json'),
    config: path.join(agentDir, 'model_config.json'),
  };
  const contents = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, fs.readFileSync(file, 'utf8')]));
  const parsed = Object.fromEntries(['plan', 'decision', 'readiness', 'config'].map(name => [name, JSON.parse(contents[name])]));
  if (parsed.readiness.status === 'blocked') throw new Error('Original model readiness was blocked.');
  const allowed = new Set(parsed.readiness.selectedModels.map(normalizeModel));
  if (parsed.plan.agents.some(agent => !allowed.has(normalizeModel(agent.model)))) throw new Error('A saved participant is absent from the original preflight-selected roster.');
  return {
    workspace: path.resolve(workspace), files, contents, ...parsed,
    ...parseDebateTranscript(parsed.plan, contents.transcript, parsed.decision),
    inputHashes: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, { file, sha256: hash(contents[name]) }])),
  };
}

async function replayScoring(inputs, options = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = path.resolve(options.outputDir ?? path.join(repository, 'dist', 'benchmarks', `debate-score-replay-${stamp}`));
  const relative = path.relative(inputs.workspace, outputDir);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Replay evidence must be outside the original generated workspace.');
  if (fs.existsSync(outputDir)) throw new Error(`Replay output directory already exists: ${outputDir}`);
  fs.mkdirSync(outputDir, { recursive: true });
  const implementationFiles = ['src/dynamic/DynamicTeam.ts', 'out/dynamic/DynamicTeam.js', 'out/ollama/OllamaClient.js', 'out/utils/retry.js', 'out/services/systemResourceService.js', 'test/replay_debate_scoring.js'];
  const report = {
    schemaVersion: 1, mode: 'saved-transcript-round-4-replay', startedAt: new Date().toISOString(),
    scope: 'Only Round 4 is generated anew. R1/R2/R3 are exact saved model outputs; this is not a fresh end-to-end benchmark.',
    status: options.run ? 'running' : 'validated-no-model-calls', workspace: inputs.workspace,
    sourceHashes: inputs.inputHashes,
    implementation: Object.fromEntries(implementationFiles.map(file => [file, hash(fs.readFileSync(path.join(repository, file)))])),
    parsedSections: inputs.sections,
    savedRoster: inputs.plan.agents.map(({ id, name, model }) => ({ id, name, model })),
    originalDecision: { winningAgentId: inputs.decision.winningAgentId, weightedScore: inputs.decision.weightedScore, rationale: inputs.decision.rationale, generatedAt: inputs.decision.generatedAt },
    attempts: [], judgeResults: [], validatedScores: [], newDecision: null,
    buildDirectionChanged: false,
  };
  const reportPath = path.join(outputDir, 'report.json');
  const save = () => { report.updatedAt = new Date().toISOString(); writeJson(reportPath, report); };
  for (const [name, content] of Object.entries(inputs.contents)) fs.writeFileSync(path.join(outputDir, `source-${name}${name === 'transcript' ? '.md' : '.json'}`), content);
  save();
  if (!options.run) return { report, reportPath };

  const log = options.log ?? console.log;
  const ollama = options.client ?? new OllamaClient(inputs.config.ollamaBaseUrl, path.join(outputDir, 'ollama-calls.jsonl'), inputs.config.requestTimeoutMs ?? 600000);
  let stopped = false;
  const stop = () => { stopped = true; ollama.cancelActiveRequests?.(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const heartbeat = setInterval(() => { save(); log(`[REPLAY] ${report.judgeResults.length}/${inputs.plan.agents.length} participant scorecards processed; ${report.attempts.length} attempts recorded.`); }, 60000);
  const recordingClient = {
    callWithFallback: async () => { throw new Error('Replay must never generate new proposals or substitute a model.'); },
    callWithFallbackJson: async () => { throw new Error('Replay requires exact-model scoring.'); },
    chatJson: async (model, messages, role, modelOptions) => {
      if (stopped) throw new UserAbortError();
      const attempt = { number: report.attempts.length + 1, model, role, startedAt: new Date().toISOString(), messages: JSON.parse(JSON.stringify(messages)), options: modelOptions };
      report.attempts.push({ number: attempt.number, model, role, startedAt: attempt.startedAt, status: 'running' });
      const summary = report.attempts.at(-1);
      const attemptPath = path.join(outputDir, `attempt-${String(attempt.number).padStart(2, '0')}.json`);
      writeJson(attemptPath, attempt);
      save();
      log(`[REPLAY] ${role} / ${model}, attempt ${attempt.number}`);
      try {
        const raw = await ollama.chatJson(model, messages, role, modelOptions);
        attempt.rawScorecard = raw;
        summary.status = 'response-received';
        return raw;
      } catch (err) {
        attempt.error = err instanceof Error ? err.message : String(err);
        summary.status = 'error';
        summary.error = attempt.error;
        throw err;
      } finally {
        attempt.finishedAt = new Date().toISOString();
        summary.finishedAt = attempt.finishedAt;
        summary.evidenceFile = attemptPath;
        writeJson(attemptPath, attempt);
        save();
      }
    },
  };
  try {
    const inventory = await ollama.listModelInventory();
    report.currentInventory = inventory;
    const byName = new Map(inventory.map(item => [normalizeModel(item.name), item]));
    for (const agent of inputs.plan.agents) {
      if (!byName.has(normalizeModel(agent.model))) throw new Error(`Saved participant model is no longer installed: ${agent.model}.`);
    }
    const modelIdentities = new Set(inputs.plan.agents.map(agent => byName.get(normalizeModel(agent.model)).digest || normalizeModel(agent.model)));
    if (modelIdentities.size < 5) throw new Error('Current installed participant models resolve to fewer than five distinct digests/names.');
    const reserves = (inputs.readiness.reserveModels ?? []).filter(model => byName.has(normalizeModel(model)));
    const modelOptions = { num_ctx: Math.min(inputs.config.defaultOptions?.num_ctx ?? 16384, 16384), num_predict: Math.min(inputs.config.defaultOptions?.num_predict ?? 1536, 4096) };
    const team = new DynamicTeam(recordingClient, undefined, 3, reserves, modelOptions, {
      retries: inputs.config.selfHealing?.enabled === false ? 0 : inputs.config.selfHealing?.modelCallRetries ?? 2,
      delayMs: inputs.config.selfHealing?.retryDelayMs ?? 5000,
      shouldAbort: () => stopped,
    });
    for (const agent of inputs.plan.agents) {
      const card = await team._scoreWithModel(agent.model, inputs.proposals, inputs.plan.goal, agent.id, agent.name, agent.model, inputs.history);
      report.judgeResults.push({ judgeId: agent.id, model: agent.model, valid: card.length === inputs.proposals.length, votes: card.length });
      report.validatedScores.push(...card);
      save();
    }
    const validModels = new Set(report.judgeResults.filter(judge => judge.valid).map(judge => byName.get(normalizeModel(judge.model)).digest || normalizeModel(judge.model)));
    report.distinctValidModels = validModels.size;
    if (validModels.size < 5) throw new Error(`Strict replay scoring blocked: only ${validModels.size} distinct models supplied complete valid scorecards.`);
    let decision = team._aggregate(inputs.plan.goal, inputs.proposals, report.validatedScores);
    const margin = decision.ranked.length >= 2 ? decision.ranked[0].score - decision.ranked[1].score : Infinity;
    const used = new Set(inputs.plan.agents.map(agent => normalizeModel(agent.model)));
    const reserve = reserves.find(model => !used.has(normalizeModel(model)));
    report.tieBreak = { originalMargin: margin, needed: margin <= 0.25, attempted: false, resolved: false };
    if (margin <= 0.25 && reserve) {
      report.tieBreak = { ...report.tieBreak, attempted: true, model: reserve };
      const card = await team._scoreWithModel(reserve, inputs.proposals, inputs.plan.goal, 'tie-breaker', 'Independent tie-breaker', reserve, inputs.history);
      report.judgeResults.push({ judgeId: 'tie-breaker', model: reserve, valid: card.length === inputs.proposals.length, votes: card.length });
      if (card.length === inputs.proposals.length) {
        report.validatedScores.push(...card);
        decision = { ...team._aggregate(inputs.plan.goal, inputs.proposals, report.validatedScores), tieBreakerModel: reserve };
        const finalMargin = decision.ranked[0].score - decision.ranked[1].score;
        report.tieBreak.finalMargin = finalMargin;
        report.tieBreak.resolved = finalMargin > 0.25;
        if (!report.tieBreak.resolved) decision.rationale += ' Independent reserve scoring left a tie/near-tie; ranking remains provisional.';
      } else decision.rationale += ' Reserve returned no complete valid scorecard; tie remains unresolved.';
    } else if (margin <= 0.25) decision.rationale += ' No installed independent reserve was available; tie remains unresolved.';
    report.newDecision = decision;
    report.comparison = {
      originalWinner: inputs.decision.winningAgentId, replayWinner: decision.winningAgentId,
      winnerChanged: inputs.decision.winningAgentId !== decision.winningAgentId,
      originalScore: inputs.decision.weightedScore, replayScore: decision.weightedScore,
      note: 'A changed winner is review evidence only. The original build decision has not been overwritten.',
    };
    report.status = 'passed-strict-scorecard-replay';
  } catch (err) {
    report.status = err instanceof UserAbortError ? 'stopped' : 'failed';
    report.error = err instanceof Error ? err.message : String(err);
  } finally {
    clearInterval(heartbeat);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    report.finishedAt = new Date().toISOString();
    report.originalInputsUnchanged = Object.entries(inputs.inputHashes).every(([, item]) => hash(fs.readFileSync(item.file, 'utf8')) === item.sha256);
    if (!report.originalInputsUnchanged) { report.status = 'failed'; report.error = 'Original replay inputs changed while scoring was in progress.'; }
    save();
  }
  return { report, reportPath };
}

async function main() {
  const args = process.argv.slice(2);
  const workspace = args[0];
  if (!workspace || workspace.startsWith('--')) throw new Error('Usage: node test/replay_debate_scoring.js <workspace> [--run] [--output <new-dir>]');
  const outputIndex = args.indexOf('--output');
  if (outputIndex >= 0 && !args[outputIndex + 1]) throw new Error('--output requires a new evidence directory.');
  const result = await replayScoring(loadReplayInputs(workspace), { run: args.includes('--run'), outputDir: outputIndex >= 0 ? args[outputIndex + 1] : undefined });
  console.log(`[REPLAY] ${result.report.status}: ${result.reportPath}`);
  if (result.report.error) console.error(`[REPLAY] ${result.report.error}`);
  process.exitCode = ['failed', 'stopped'].includes(result.report.status) ? 1 : 0;
}

module.exports = { parseDebateTranscript, loadReplayInputs, replayScoring };
if (require.main === module) main().catch(err => { console.error(err.stack || String(err)); process.exitCode = 1; });
