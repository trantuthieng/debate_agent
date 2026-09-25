/**
 * End-to-end integration test for AgentOrchestrator.
 * Runs the complete autonomous workflow against real local Ollama models and
 * writes a machine-readable time/resource benchmark under dist/benchmarks/.
 *
 * Usage:  node test/e2e_run.js
 */

const fs = require('node:fs');
const cp = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { AgentOrchestrator } = require('../out/orchestrator/AgentOrchestrator');
const { OllamaClient } = require('../out/ollama/OllamaClient');
const { loadEnvFile } = require('../out/utils/loadEnvFile');

// So a repo-root .env (e.g. TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID) works for a
// plain `npm run test:e2e:ollama` without exporting vars by hand.
loadEnvFile(path.join(__dirname, '..', '.env'));

const BUILD_ONLY = process.argv.includes('--build-only');

const PROMPT = [
  'Create a dependency-free Node.js CLI tool called "greet" that accepts a --name flag',
  'and prints "Hello, <name>!" to stdout. Use only built-in Node.js APIs, include a',
  'package.json test script, and add real tests using node:test. Do not use third-party packages.',
].join(' ');
const RESOURCE_AWARE_MODEL_ORDER = [
  'qwen2.5-coder:7b-instruct',
  'llama3.1:8b',
  'gemma3:12b',
  'qwen2.5-coder:14b-instruct',
  'deepseek-coder-v2:16b',
  'qwen3:8b',
];

function normalizeModel(model) {
  return String(model).trim().toLowerCase().replace(/:latest$/, '');
}

function selectRoster(installedModels) {
  const requested = process.env.E2E_MODELS
    ? process.env.E2E_MODELS.split(',').map(model => model.trim()).filter(Boolean)
    : RESOURCE_AWARE_MODEL_ORDER;
  const installedByName = new Map(installedModels.map(model => [normalizeModel(model), model]));
  const preferred = requested
    .map(model => installedByName.get(normalizeModel(model)))
    .filter(Boolean);
  const used = new Set(preferred.map(normalizeModel));
  return [...preferred, ...installedModels.filter(model => !used.has(normalizeModel(model)))].slice(0, 5);
}

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function summarizeOllamaCalls(filePath) {
  if (!fs.existsSync(filePath)) {
    return { total: 0, successful: 0, failed: 0, fallbackCalls: 0, durationMs: 0, byModel: {} };
  }
  const calls = fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap(line => {
      try { return [JSON.parse(line)]; }
      catch { return []; }
    });
  const byModel = {};
  for (const call of calls) {
    const model = String(call.model || 'unknown');
    const current = byModel[model] || { calls: 0, successful: 0, durationMs: 0 };
    current.calls += 1;
    current.successful += call.success ? 1 : 0;
    current.durationMs += Number(call.durationMs) || 0;
    byModel[model] = current;
  }
  return {
    total: calls.length,
    successful: calls.filter(call => call.success).length,
    failed: calls.filter(call => !call.success).length,
    fallbackCalls: calls.filter(call => call.usedFallback).length,
    durationMs: calls.reduce((sum, call) => sum + (Number(call.durationMs) || 0), 0),
    byModel,
  };
}

function writeBenchmark({ root, startTime, startFreeMemory, roster, phaseEvents, status, state, error }) {
  const reportPath = process.env.E2E_REPORT_PATH
    ? path.resolve(process.env.E2E_REPORT_PATH)
    : path.join(
      process.cwd(),
      'dist',
      'benchmarks',
      BUILD_ONLY ? 'ollama-build-e2e-latest.json' : 'ollama-e2e-latest.json'
    );
  const agentDir = path.join(root, '.agent-workspace');
  // A generated deliverable can pass every downstream check while actually
  // having been produced by the deterministic template fallback rather than
  // the model pipeline (this happened for exactly this CLI prompt). Surface
  // that honestly in the evidence instead of letting a template pass as if
  // the models had authored it.
  const assumptionsPath = path.join(agentDir, 'memory', 'assumptions.md');
  const assumptionsText = fs.existsSync(assumptionsPath) ? fs.readFileSync(assumptionsPath, 'utf8') : '';
  const usedDeterministicRecovery = /deterministic (product )?recovery/i.test(assumptionsText);
  if (usedDeterministicRecovery) {
    console.warn(
      '[E2E] WARNING: the deliverable was (at least partly) produced by deterministic template ' +
      'recovery, not the model pipeline. See usedDeterministicRecovery in the benchmark report.'
    );
  }
  const artifactNames = [
    'dynamic_team_plan.json',
    'dynamic_team_debate.md',
    'dynamic_team_decision.json',
    '09_final_report.md',
  ];
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status,
    error: error || null,
    prompt: PROMPT,
    workspace: root,
    elapsedMs: Date.now() - startTime,
    host: {
      platform: process.platform,
      architecture: process.arch,
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      freeMemoryStartBytes: startFreeMemory,
      freeMemoryEndBytes: os.freemem(),
      nodeProcessPeakRssKb: process.resourceUsage().maxRSS,
    },
    modelRoster: roster,
    usedDeterministicRecovery,
    readiness: readJsonIfPresent(path.join(agentDir, 'logs', 'model_readiness.json')),
    ollamaCalls: summarizeOllamaCalls(path.join(agentDir, 'logs', 'ollama_calls.jsonl')),
    phases: phaseEvents,
    finalState: state ? {
      status: state.status,
      currentPhase: state.currentPhase,
      activeTasks: state.activeTasks.length,
      completedTasks: state.completedTasks.length,
      failedTasks: state.failedTasks.length,
    } : null,
    artifacts: Object.fromEntries(artifactNames.map(name => {
      const filePath = path.join(agentDir, 'agents', name);
      return [name, fs.existsSync(filePath) ? fs.statSync(filePath).size : null];
    })),
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`[E2E] Benchmark report: ${reportPath}`);
}

async function main() {
  // Create a temp workspace
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-agent-'));
  console.log(`\n[E2E] Workspace: ${root}`);
  console.log(`[E2E] Prompt: ${PROMPT}\n`);

  const orchestrator = new AgentOrchestrator(root);
  const startTime = Date.now();
  const startFreeMemory = os.freemem();
  const phaseEvents = [];
  let roster = [];
  let finalState = null;
  let workflowError = '';
  let lastStatePhase = '';

  orchestrator.setCallbacks({
    onLog: (msg, level) => {
      const tag = level === 'error' ? '❌' : level === 'warn' ? '⚠️ ' : '  ';
      console.log(`${tag} [${level.toUpperCase()}] ${msg}`);
    },
    onPhaseChange: (phase, msg) => {
      phaseEvents.push({ phase, message: msg, elapsedMs: Date.now() - startTime });
      console.log(`\n🔷 PHASE → ${phase}: ${msg}`);
    },
    onStateUpdate: (state) => {
      if (state.currentPhase !== lastStatePhase) {
        lastStatePhase = state.currentPhase;
        phaseEvents.push({ phase: state.currentPhase, message: state.status, elapsedMs: Date.now() - startTime });
      }
      console.log(`   state: ${state.status} / ${state.currentPhase}`);
    },
    onError: (msg) => {
      workflowError = msg;
      console.error(`💥 ERROR: ${msg}`);
    },
  });

  try {
    // Use a resource-aware real-model config for both the full and build-only runs.
    await orchestrator.workspace.initialize();
    orchestrator.workspace.writeUserPrompt(PROMPT);

    const localModels = await new OllamaClient('http://localhost:11434').listModels();
    if (new Set(localModels.map(model => model.replace(/:latest$/, ''))).size < 5) {
      throw new Error(`Real autonomous E2E requires at least five installed local models; found ${localModels.length}.`);
    }
    roster = selectRoster(localModels);
    const pick = index => ({ model: roster[index % roster.length], fallbackModel: roster[(index + 1) % roster.length] });
    const [smallCoder, generalist, strategist, mediumCoder, deepCoder] = roster;

    // Use five real installed models; the runtime preflight probes each one.
    const modelConfig = {
      ollamaBaseUrl: 'http://localhost:11434',
      safeMode: false,
      maxFixRetries: 1,
      autoInstallDependencies: false,
      defaultOptions: { temperature: 0.1, num_ctx: 8192, num_predict: 768 },
      agents: {
        briefBuilder:     { model: smallCoder, fallbackModel: mediumCoder },
        brainstorm:       { model: generalist, fallbackModel: strategist },
        critic:           { model: strategist, fallbackModel: mediumCoder },
        secondBrainstorm: pick(2),
        architect:        { model: deepCoder, fallbackModel: mediumCoder },
        taskManager:      { model: mediumCoder, fallbackModel: smallCoder },
        codeWorker:       { model: mediumCoder, fallbackModel: deepCoder },
        reviewer:         { model: deepCoder, fallbackModel: mediumCoder },
        tester:           { model: smallCoder, fallbackModel: mediumCoder },
        fixer:            { model: mediumCoder, fallbackModel: deepCoder },
        finalIntegrator:  { model: smallCoder, fallbackModel: mediumCoder },
      },
    };
    // Write config using absolute path
    orchestrator.workspace.writeFile(
      orchestrator.workspace.modelConfigPath,
      JSON.stringify(modelConfig, null, 2)
    );

    if (BUILD_ONLY) {
      // The full test already validates team creation and all four debate rounds.
      // This mode isolates the downstream build/review/test/deliver pipeline so
      // recovery regressions can be rechecked without another long debate.
      orchestrator._skipFixedDebate = true;
      await orchestrator.start(PROMPT);
    } else {
      await orchestrator.runAutonomousGoal(PROMPT);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const state = orchestrator.getState();
    finalState = state;
    console.log(`\n✅ Workflow finished in ${elapsed}s`);
    console.log(`   Final status: ${state.status} / ${state.currentPhase}`);
    console.log(`   Completed tasks: ${state.completedTasks.length}`);
    console.log(`   Failed tasks: ${state.failedTasks.length}`);
    if (state.status !== 'completed') {
      throw new Error(workflowError || `Autonomous workflow ended with status ${state.status}.`);
    }
    if (!BUILD_ONLY) {
      for (const artifact of ['dynamic_team_plan.json', 'dynamic_team_debate.md', 'dynamic_team_decision.json']) {
        const artifactPath = path.join(root, '.agent-workspace', 'agents', artifact);
        if (!fs.existsSync(artifactPath)) { throw new Error(`Autonomous E2E did not create ${artifact}.`); }
      }
    }
    if (state.status === 'completed' && state.activeTasks.length !== 0) {
      throw new Error('Completed workflow retained active tasks.');
    }
    const cliResult = cp.spawnSync(process.execPath, ['src/cli.js', '--name', 'Ada'], {
      cwd: root,
      encoding: 'utf8',
    });
    if (cliResult.status !== 0 || cliResult.stdout.trim() !== 'Hello, Ada!') {
      throw new Error(
        `Generated CLI failed its semantic contract: expected "Hello, Ada!", got stdout=${JSON.stringify(cliResult.stdout.trim())}, stderr=${JSON.stringify(cliResult.stderr.trim())}.`
      );
    }
    const generatedPackage = readJsonIfPresent(path.join(root, 'package.json'));
    if (!generatedPackage?.scripts?.test || Object.keys(generatedPackage.dependencies ?? {}).length > 0) {
      throw new Error('Generated CLI must have a real test script and no runtime dependencies.');
    }

    // Print agent output files
    const agentsDir = path.join(root, '.agent-workspace', 'agents');
    if (fs.existsSync(agentsDir)) {
      const files = fs.readdirSync(agentsDir);
      console.log(`\n📁 Agent output files (${files.length}):`);
      for (const f of files.sort()) {
        const size = fs.statSync(path.join(agentsDir, f)).size;
        console.log(`   ${f}  (${size} bytes)`);
      }
    }

    // Print list of created project files
    const projectFiles = [];
    const scan = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(root, full);
        if (rel.startsWith('.agent-workspace')) continue;
        if (rel.startsWith('node_modules')) continue;
        if (entry.isDirectory()) { scan(full); }
        else { projectFiles.push(rel); }
      }
    };
    scan(root);

    if (projectFiles.length > 0) {
      console.log(`\n🗂  Generated project files (${projectFiles.length}):`);
      for (const f of projectFiles) console.log(`   ${f}`);
    } else {
      console.log('\n(No project source files generated outside .agent-workspace/)');
    }

    console.log(`\n[E2E] Workspace preserved at: ${root}`);
    writeBenchmark({
      root,
      startTime,
      startFreeMemory,
      roster,
      phaseEvents,
      status: 'passed',
      state: finalState,
    });
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`\n💥 Workflow failed after ${elapsed}s: ${err.message}`);
    if (err.stack) console.error(err.stack);
    finalState = orchestrator.getState();
    writeBenchmark({
      root,
      startTime,
      startFreeMemory,
      roster,
      phaseEvents,
      status: 'failed',
      state: finalState,
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  }
}

main();
