/** Real-model product benchmark. No mocked models, pipeline bypass, or injected code. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { AgentOrchestrator } = require('../out/orchestrator/AgentOrchestrator');
const { loadEnvFile } = require('../out/utils/loadEnvFile');

// So a repo-root .env (e.g. TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID) works for a
// plain `npm run test:e2e:word-addin` without exporting vars by hand.
loadEnvFile(path.join(__dirname, '..', '.env'));

const prompt = 'Build a Word add-in that runs on both Word for Mac and Word for Windows to manage a personal library of reference documents/citations and let the user insert them into the document automatically. Word only has one add-in technology that genuinely works identically on both Mac and Windows, so build it as a Microsoft Office Add-in (Office.js, task pane) rather than a Windows-only VBA/VSTO add-in. Users should be able to add and organize references (e.g. title, author, year, source), search their library, insert a formatted citation at the cursor with one click, and generate a bibliography/works-cited list from the citations actually used in the current document. Deliver a runnable, sideloadable project (manifest + task pane app) with README setup instructions for both Mac and Windows, and automated tests for the reference-management and citation-insertion logic.';
const repository = path.resolve(__dirname, '..');
const implementation = Object.fromEntries([
  'orchestrator/AgentOrchestrator.js', 'ollama/OllamaClient.js', 'dynamic/DynamicTeam.js',
  'services/appVerificationService.js', 'services/collectionAcceptanceService.js',
].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(repository, 'out', file))).digest('hex')]));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = process.env.WORD_ADDIN_E2E_WORKSPACE
  ? path.resolve(process.env.WORD_ADDIN_E2E_WORKSPACE)
  : path.join(repository, 'demo', `word-addin-refs-${stamp}`);
const reportPath = path.join(repository, 'dist', 'benchmarks', 'word-addin-refs-latest.json');
const invocationReportPath = path.join(repository, 'dist', 'benchmarks', `word-addin-refs-${stamp}.json`);
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
    elapsedMs: Date.now() - started, error,
    host: { platform: process.platform, architecture: process.arch, totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem() },
    finalState: state, phases,
    readiness: readJson(path.join(workspace, 'logs', 'model_readiness.json')),
    decision: readJson(path.join(workspace, 'agents', 'dynamic_team_decision.json')),
    appVerification: readJson(path.join(workspace, 'agents', '08_app_verification.json')),
    collectionAcceptance: readJson(path.join(workspace, 'logs', 'collection_acceptance.json')),
    usedDeterministicRecovery: /deterministic (product )?recovery/i.test(assumptions),
    calls: { total: calls.length, failed: calls.filter(call => !call.success).length, byModel: Object.fromEntries([...new Set(calls.map(call => call.model))].map(model => [model, calls.filter(call => call.model === model).length])) },
    independentReview: 'pending',
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(data, null, 2)}\n`);
  fs.writeFileSync(invocationReportPath, `${JSON.stringify(data, null, 2)}\n`);
}

async function main() {
  if (fs.existsSync(root) && fs.readdirSync(root).length && !resume) {
    throw new Error(`Workspace is not empty: ${root}. Use a fresh folder or --resume.`);
  }
  fs.mkdirSync(root, { recursive: true });
  if (resume) {
    const previous = readJson(reportPath);
    if (previous?.workspace === root) {
      resumedFromReport = path.join(repository, 'dist', 'benchmarks', `word-addin-refs-before-resume-${stamp}.json`);
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
    console.log(`[BENCHMARK] Pipeline completed. Independent review remains required. Report: ${reportPath}`);
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
