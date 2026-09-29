/** Real-model product benchmark. No mocked models, pipeline bypass, or injected game code. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { AgentOrchestrator } = require('../out/orchestrator/AgentOrchestrator');
const { loadEnvFile } = require('../out/utils/loadEnvFile');
const { initLogger } = require('../out/utils/logging');

// So a repo-root .env (e.g. TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID) works for a
// plain `npm run test:e2e:brick-breaker` without exporting vars by hand.
loadEnvFile(path.join(__dirname, '..', '.env'));
// F9: the pipeline's own final checks run the gameplay walk-through, so a
// game that cannot be started fails verification and gets repaired, instead
// of being caught only after delivery (run 11). The oracle lives outside the
// product workspace, where no task can edit it.
process.env.DEBATE_ACCEPTANCE_SCRIPT ??= path.join(__dirname, 'acceptance', 'brickBreakerAcceptance.js');

const prompt = require('../benchmarks/goals/brick-breaker.v1.json').goal;
const repository = path.resolve(__dirname, '..');
const implementation = Object.fromEntries([
  'orchestrator/AgentOrchestrator.js', 'ollama/OllamaClient.js', 'dynamic/DynamicTeam.js',
  'services/appVerificationService.js', 'services/collectionAcceptanceService.js',
].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(repository, 'out', file))).digest('hex')]));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = process.env.BRICK_E2E_WORKSPACE
  ? path.resolve(process.env.BRICK_E2E_WORKSPACE)
  : path.join(repository, 'demo', `brick-breaker-20-${stamp}`);
const reportPath = path.join(repository, 'dist', 'benchmarks', 'brick-breaker-20-latest.json');
const invocationReportPath = path.join(repository, 'dist', 'benchmarks', `brick-breaker-20-${stamp}.json`);
const resume = process.argv.includes('--resume');
const started = Date.now();
const phases = [];
let error = null;
let agent;
let lastPhase = '';
let resumedFromReport = null;
const readJson = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

function report(status) {
  const workspace = path.join(root, '.agent-workspace');
  const state = readJson(path.join(workspace, 'project_state.json')) || agent?.getState();
  let assumptions = '';
  try { assumptions = fs.readFileSync(path.join(workspace, 'memory', 'assumptions.md'), 'utf8'); } catch { /* no calls yet */ }
  let calls = [];
  try {
    calls = fs.readFileSync(path.join(workspace, 'logs', 'ollama_calls.jsonl'), 'utf8')
      .split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  } catch { /* no calls yet */ }
  const data = {
    schemaVersion: 2, generatedAt: new Date().toISOString(), status, prompt, workspace: root,
    invocation: { mode: resume ? 'resume' : 'new', reportPath: invocationReportPath, resumedFromReport },
    implementation,
    diagnosticsLog: path.join(root, '.agent-workspace', 'logs', `benchmark-${stamp}.log`),
    elapsedMs: Date.now() - started, error,
    host: { platform: process.platform, architecture: process.arch, totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem() },
    finalState: state, phases,
    readiness: readJson(path.join(workspace, 'logs', 'model_readiness.json')),
    decision: readJson(path.join(workspace, 'agents', 'dynamic_team_decision.json')),
    appVerification: readJson(path.join(workspace, 'agents', '08_app_verification.json')),
    collectionAcceptance: readJson(path.join(workspace, 'logs', 'collection_acceptance.json')),
    usedDeterministicRecovery: /deterministic (product )?recovery/i.test(assumptions),
    calls: { total: calls.length, failed: calls.filter(call => !call.success).length, byModel: Object.fromEntries([...new Set(calls.map(call => call.model))].map(model => [model, calls.filter(call => call.model === model).length])) },
    gameplayAcceptance: readJson(path.join(workspace, 'logs', 'gameplay_acceptance.json')),
  };
  // A transient write failure (e.g. a sync client briefly locking the folder)
  // must never kill a multi-hour run from inside the heartbeat timer.
  try {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(data, null, 2)}\n`);
    fs.writeFileSync(invocationReportPath, `${JSON.stringify(data, null, 2)}\n`);
  } catch (err) {
    console.warn(`${new Date().toISOString()} [warn] Benchmark report not written (${status}): ${err.message}`);
  }
}

async function main() {
  if (fs.existsSync(root) && fs.readdirSync(root).length && !resume) {
    throw new Error(`Workspace is not empty: ${root}. Use a fresh folder or --resume.`);
  }
  fs.mkdirSync(root, { recursive: true });
  // Internal warnings do not use orchestrator callbacks. Keep them in the run
  // output AND an invocation-specific artifact, including scorecard rejection
  // reasons that occur after a successful Ollama JSON response.
  initLogger({ appendLine: line => console.log(line) },
    path.join(root, '.agent-workspace', 'logs', `benchmark-${stamp}.log`));
  if (resume) {
    const previous = readJson(reportPath);
    if (previous?.workspace === root) {
      resumedFromReport = path.join(repository, 'dist', 'benchmarks', `brick-breaker-20-before-resume-${stamp}.json`);
      fs.writeFileSync(resumedFromReport, `${JSON.stringify(previous, null, 2)}\n`);
    }
  }
  agent = new AgentOrchestrator(root);
  agent.setCallbacks({
    onLog: (message, level) => console.log(`${new Date().toISOString()} [${level}] ${message}`),
    onPhaseChange: (phase, message) => {
      phases.push({ phase, message, elapsedMs: Date.now() - started });
      console.log(`[PHASE] ${phase}: ${message}`);
    },
    onStateUpdate: state => {
      if (state.currentPhase === lastPhase) return;
      lastPhase = state.currentPhase;
      console.log(`[STATE] ${state.status}/${state.currentPhase}`);
    },
    onError: message => { error = message; console.error(`[ERROR] ${message}`); },
  });
  await agent.workspace.initialize();
  console.log(`[BENCHMARK] Workspace: ${root}\n[BENCHMARK] Prompt: ${prompt}`);
  console.log(resume
    ? '[BENCHMARK] Resuming the saved autonomous pipeline; prior evidence and implementation hashes are preserved separately.'
    : '[BENCHMARK] Using shipped default configuration and the full autonomous entry point.');
  const heartbeat = setInterval(() => {
    report('running');
    console.log(`[HEARTBEAT] ${Math.round((Date.now() - started) / 1000)}s; phase=${agent.getState().currentPhase}`);
  }, 60_000);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => agent.stop());
  try {
    if (resume) await agent.resume();
    else await agent.runAutonomousGoal(prompt);
    const state = agent.getState();
    if (state.status !== 'completed' || state.activeTasks.length || state.failedTasks.length) {
      throw new Error(error || `Product pipeline ended ${state.status}/${state.currentPhase}.`);
    }
    for (const name of ['dynamic_team_plan.json', 'dynamic_team_debate.md', 'dynamic_team_decision.json']) {
      if (!fs.existsSync(path.join(root, '.agent-workspace', 'agents', name))) throw new Error(`Missing debate evidence: ${name}`);
    }
    report('pipeline-completed');
    // S3: independent gameplay acceptance on the delivered product (real browser, 17 checks).
    const acceptance = require('node:child_process').spawnSync(process.execPath,
      [path.join(__dirname, 'acceptance', 'brickBreakerAcceptance.js'), root], { encoding: 'utf8', timeout: 300_000 });
    console.log(`[BENCHMARK] Gameplay acceptance:\n${acceptance.stdout}${acceptance.stderr}`);
    report(acceptance.status === 0 ? 'accepted' : 'pipeline-completed-not-accepted');
    console.log(`[BENCHMARK] Pipeline completed; gameplay ${acceptance.status === 0 ? 'ACCEPTED' : 'NOT accepted'}. Report: ${reportPath}`);
  } finally {
    clearInterval(heartbeat);
    agent.terminalSessions?.stopAll();
  }
}

main().catch(err => {
  error = err.stack || err.message;
  report('failed');
  console.error(error);
  process.exitCode = 1;
});
