#!/usr/bin/env node
/**
 * Re-run a recorded benchmark without Ollama, against the current build.
 *
 *   node scripts/replay-run.js <recorded-workspace> [--out <new-workspace>]
 *
 * The recorded workspace must contain .agent-workspace/logs/model_exchanges.jsonl
 * (written by every run since model-exchange recording was added). The models
 * answer exactly as they did; only our gates and orchestration differ. The run
 * stops when it asks for a model response the recording does not contain,
 * i.e. where the live run stopped or where changed code first diverges.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);
const source = args.find(arg => !arg.startsWith('--'));
const outIndex = args.indexOf('--out');
if (!source) {
  console.error('Usage: node scripts/replay-run.js <recorded-workspace> [--out <new-workspace>]');
  process.exit(2);
}
const agentDir = path.join(path.resolve(source), '.agent-workspace');
const recording = path.join(agentDir, 'logs', 'model_exchanges.jsonl');
if (!fs.existsSync(recording)) {
  console.error(`No recording at ${recording}. Only runs made after model-exchange recording was added can be replayed.`);
  process.exit(2);
}
const root = outIndex >= 0 ? path.resolve(args[outIndex + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'debate-replay-'));
process.env.DEBATE_MODEL_REPLAY = recording;

const { AgentOrchestrator } = require('../out/orchestrator/AgentOrchestrator');

(async () => {
  const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const recordedState = readJson(path.join(agentDir, 'project_state.json')) ?? {};
  const prompt = fs.readFileSync(path.join(agentDir, 'user_prompt.md'), 'utf8').trim();
  const agent = new AgentOrchestrator(root);
  await agent.workspace.initialize();
  // Same models and settings as the recorded run, or the replay cannot line up.
  fs.copyFileSync(path.join(agentDir, 'model_config.json'), path.join(root, '.agent-workspace', 'model_config.json'));
  let error = null;
  agent.setCallbacks({
    onLog: (message, level) => { if (level !== 'info') console.log(`[${level}] ${message}`); },
    onPhaseChange: (phase, message) => console.log(`[PHASE] ${phase}: ${message}`),
    onError: message => { error = message; },
  });
  const started = Date.now();
  console.log(`[REPLAY] ${recording}\n[REPLAY] Workspace: ${root}`);
  try {
    if (recordedState.workflowMode === 'autonomous') { await agent.runAutonomousGoal(prompt); } else { await agent.start(prompt); }
  } catch (err) {
    error = error ?? (err instanceof Error ? err.message : String(err));
  }
  const state = agent.getState();
  const stats = agent.ollama.replayStats;
  console.log(`[REPLAY] Finished in ${Math.round((Date.now() - started) / 1000)}s: ${state.status}/${state.currentPhase}`);
  console.log(`[REPLAY] Recorded run ended: ${recordedState.status ?? '?'}/${recordedState.currentPhase ?? '?'}`);
  console.log(`[REPLAY] Exchanges served ${stats.served} (identical request ${stats.exactMatches}, diverged chats ${stats.diverged}, exhausted ${stats.exhausted})`);
  if (error) { console.log(`[REPLAY] Error: ${error}`); }
  if (stats.exhausted > 0) {
    console.log('[REPLAY] The run asked for model answers the recording does not hold: it stopped where the live run stopped, or where the current code first needs a different call.');
  }
  process.exit(state.status === 'completed' ? 0 : 1);
})();
