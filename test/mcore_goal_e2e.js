/**
 * Real-model runner for the locked S4 goals. Does not run independent acceptance.
 * node test/mcore_goal_e2e.js --goal-id local-notes --workspace /absolute/fresh-dir --budget-minutes 120
 * Add --resume explicitly to continue that same bound workspace; failures are retained.
 * Exit 0 means pipeline completion ONLY. Product acceptance remains unverified.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const repository = path.resolve(__dirname, '..');
const GOALS = new Set(['local-notes', 'tasks-cli']);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const readText = file => { try { return fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return null; throw err; } };
const readJson = file => { const text = readText(file); return text === null ? null : JSON.parse(text); };
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
};

function parseArgs(argv) {
  const args = { resume: false };
  const flags = { '--goal-id': 'goalId', '--workspace': 'workspace', '--budget-minutes': 'budgetMinutes', '--report-dir': 'reportDir' };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    seen.add(flag);
    if (flag === '--resume') { args.resume = true; continue; }
    if (!flags[flag]) throw new Error(`Unknown argument: ${flag}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    args[flags[flag]] = value;
  }
  if (!GOALS.has(args.goalId)) throw new Error('--goal-id must be local-notes or tasks-cli');
  if (!args.workspace) throw new Error('--workspace is required; no implicit reuse or generated location');
  const minutes = Number(args.budgetMinutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error('--budget-minutes must be an integer from 1 to 1440, declared before the run');
  return { ...args, budgetMinutes: minutes, workspace: path.resolve(args.workspace),
    reportDir: path.resolve(args.reportDir || path.join(repository, 'dist', 'benchmarks', 'mcore')) };
}

function loadBrief(goalId, repo = repository) {
  if (!GOALS.has(goalId)) throw new Error(`Unsupported locked goal: ${goalId}`);
  const file = path.join(repo, 'benchmarks', 'goals', `${goalId}.v1.json`);
  const raw = fs.readFileSync(file);
  const brief = JSON.parse(raw.toString('utf8'));
  if (brief.id !== goalId || brief.version !== 1 || typeof brief.goal !== 'string' || !brief.goal.trim() || !brief.requirements?.length) {
    throw new Error(`Invalid locked brief: ${file}`);
  }
  return { ...brief, source: file, sha256: sha256(raw) };
}

function bindWorkspace(args, brief) {
  const bindingPath = path.join(args.workspace, '.agent-workspace', 'benchmark_brief.json');
  const statePath = path.join(args.workspace, '.agent-workspace', 'project_state.json');
  if (args.resume) {
    const binding = readJson(bindingPath);
    if (!binding || binding.id !== brief.id || binding.sha256 !== brief.sha256 || binding.version !== brief.version) {
      throw new Error('Resume rejected: workspace binding does not match the locked brief');
    }
    if (!readJson(statePath)) throw new Error('Resume rejected: project_state.json is missing');
  } else {
    if (fs.existsSync(args.workspace) && fs.readdirSync(args.workspace).length) {
      throw new Error('Fresh runs require an empty workspace; use --resume explicitly for an existing run');
    }
    writeJson(bindingPath, { id: brief.id, version: brief.version, sha256: brief.sha256, goal: brief.goal });
  }
}

function captureImplementation(repo = repository) {
  const git = args => execFileSync('git', args, { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
  const revision = git(['rev-parse', 'HEAD']).toString().trim();
  const status = git(['status', '--porcelain=v1', '-z']).toString();
  const trackedDiff = git(['diff', '--binary', 'HEAD']);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean).sort();
  const untrackedHashes = {};
  for (const file of untracked) {
    const full = path.join(repo, file);
    const stat = fs.lstatSync(full);
    untrackedHashes[file] = stat.isSymbolicLink() ? sha256(fs.readlinkSync(full)) : sha256(fs.readFileSync(full));
  }
  const compiled = {};
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) compiled[path.relative(repo, full).replace(/\\/g, '/')] = sha256(fs.readFileSync(full));
    }
  }
  walk(path.join(repo, 'out'));
  return { revision, dirty: Boolean(status), dirtyHash: sha256(Buffer.concat([Buffer.from(status), trackedDiff, Buffer.from(JSON.stringify(untrackedHashes))])),
    trackedDiffHash: sha256(trackedDiff), untrackedHashes, compiled,
    compiledHash: sha256(JSON.stringify(Object.entries(compiled).sort(([a], [b]) => a.localeCompare(b)))) };
}

function readCalls(root) {
  const text = readText(path.join(root, '.agent-workspace/logs/ollama_calls.jsonl')) || '';
  const calls = []; let malformedLines = 0;
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    try { calls.push(JSON.parse(line)); } catch { malformedLines++; }
  }
  return { calls, malformedLines, sha256: sha256(text) };
}

function checkpoint(root) {
  const dir = path.join(root, '.agent-workspace');
  return { state: readJson(path.join(dir, 'project_state.json')),
    dynamicTeam: readJson(path.join(dir, 'agents/dynamic_team_checkpoint.json')),
    config: readJson(path.join(dir, 'model_config.json')) };
}

function buildReport(context, status, error = null) {
  const { args, brief, startedAt, invocationId, invocationDir, initial, initialCallCount, phases, turns, checkpointHistory } = context;
  const root = args.workspace;
  const dir = path.join(root, '.agent-workspace');
  const current = checkpoint(root);
  const plan = readJson(path.join(dir, 'agents/dynamic_team_plan.json'));
  const transcript = readText(path.join(dir, 'agents/dynamic_team_debate.md')) || '';
  const calls = readCalls(root);
  const summarizeCalls = entries => ({ total: entries.length, failed: entries.filter(call => call.success === false).length,
    byModel: Object.fromEntries([...new Set(entries.map(call => call.model).filter(Boolean))].sort().map(model => [model, entries.filter(call => call.model === model).length])) });
  const agents = plan?.agents || [];
  const plannedModels = [...new Set(agents.map(agent => String(agent.model).toLowerCase().replace(/:latest$/, '')))];
  const actualModels = [...new Set(calls.calls.filter(call => call.success && /^dynamic:/.test(call.agentRole || '')).map(call => String(call.model).toLowerCase().replace(/:latest$/, '')))];
  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(), status,
    invocation: { id: invocationId, mode: args.resume ? 'resume' : 'new', workspace: root, reportPath: path.join(invocationDir, 'report.json'),
      previousInvocation: context.previousInvocation, startedAt, elapsedMs: Date.now() - Date.parse(startedAt), budgetMinutes: args.budgetMinutes },
    brief, implementation: context.implementation, initialCheckpoint: initial, finalCheckpoint: current, checkpointHistory,
    config: { initial: context.effectiveConfig ?? initial.config, initialHash: sha256(JSON.stringify(context.effectiveConfig ?? initial.config)), currentHash: sha256(JSON.stringify(current.config)), current: current.config },
    host: { platform: process.platform, architecture: process.arch, node: process.version, totalMemoryBytes: os.totalmem() },
    pipeline: { completed: status === 'pipeline-completed', finalState: current.state, error, phases,
      phaseDurations: phases.map((phase, index) => ({ phase: phase.phase,
        durationMs: (phases[index + 1]?.elapsedMs ?? Date.now() - Date.parse(startedAt)) - phase.elapsedMs })),
      fixRetryCount: current.state?.fixRetryCount ?? null, sprint: current.state?.developmentSprint ?? null },
    acceptance: { status: 'unverified', reason: 'Pipeline completion is not acceptance. Independent requirement, clean-copy and interaction harness evidence is still required.',
      requirementIds: brief.requirements.map(requirement => requirement.id) },
    debate: { plannedAgents: agents, plannedDistinctModels: plannedModels, observedSuccessfulDynamicModels: actualModels,
      atLeastFivePlannedModels: plannedModels.length >= 5, atLeastFiveObservedModels: actualModels.length >= 5,
      transcriptRounds: [...transcript.matchAll(/^## Round ([1-4])\b/gm)].map(match => Number(match[1])),
      invocationTurns: turns, decision: readJson(path.join(dir, 'agents/dynamic_team_decision.json')),
      evidenceStatus: 'unverified', note: 'Headings and model counts are observations, not proof of complete per-agent participation or independent review.' },
    calls: { cumulative: summarizeCalls(calls.calls), invocation: summarizeCalls(calls.calls.slice(initialCallCount)),
      initialCount: initialCallCount, malformedLines: calls.malformedLines, logHash: calls.sha256 },
    runtime: { callbackErrors: context.callbackErrors || [], readiness: readJson(path.join(dir, 'logs/model_readiness.json')), appVerification: readJson(path.join(dir, 'agents/08_app_verification.json')) },
    artifacts: { stdout: path.join(invocationDir, 'stdout.log'), diagnostics: path.join(invocationDir, 'diagnostics.log'),
      callLog: path.join(dir, 'logs/ollama_calls.jsonl'), terminalLog: path.join(dir, 'logs/terminal.log'),
      testLog: path.join(dir, 'logs/test_result.log'), debateTranscript: path.join(dir, 'agents/dynamic_team_debate.md') },
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const brief = loadBrief(args.goalId);
  // Fingerprint before creating reports/workspace files; generated artifacts must not influence this invocation's revision evidence.
  const implementation = captureImplementation();
  bindWorkspace(args, brief);
  const invocationId = `${brief.id}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const invocationDir = path.join(args.reportDir, invocationId);
  fs.mkdirSync(args.reportDir, { recursive: true });
  fs.mkdirSync(invocationDir, { recursive: false });
  const indexPath = path.join(args.workspace, '.agent-workspace', 'benchmark_invocations.jsonl');
  const prior = (readText(indexPath) || '').trim().split('\n').filter(Boolean);
  const context = { args, brief, implementation, invocationId, invocationDir, startedAt: new Date().toISOString(),
    previousInvocation: prior.length ? JSON.parse(prior.at(-1)) : null,
    initial: checkpoint(args.workspace), initialCallCount: readCalls(args.workspace).calls.length, phases: [], turns: [], checkpointHistory: [], callbackErrors: [] };
  writeJson(path.join(invocationDir, 'start.json'), context);
  fs.appendFileSync(indexPath, JSON.stringify({ id: invocationId, reportPath: path.join(invocationDir, 'report.json') }) + '\n');
  let agent; let error = null; let heartbeat; let deadline; let lastCheckpointHash = '';
  const originals = [process.stdout.write, process.stderr.write];
  [process.stdout, process.stderr].forEach((stream, i) => {
    stream.write = function (chunk, ...rest) {
      try { fs.appendFileSync(path.join(invocationDir, 'stdout.log'), chunk); } catch { /* report writer retains failures */ }
      return originals[i].call(this, chunk, ...rest);
    };
  });
  const saveReport = status => {
    try {
      const saved = checkpoint(args.workspace);
      const hash = sha256(JSON.stringify(saved));
      if (hash !== lastCheckpointHash) {
        const file = path.join(invocationDir, `checkpoint-${context.checkpointHistory.length}.json`);
        writeJson(file, saved);
        context.checkpointHistory.push({ file, sha256: hash, capturedAt: new Date().toISOString() });
        lastCheckpointHash = hash;
      }
      const data = buildReport(context, status, error);
      writeJson(path.join(invocationDir, 'report.json'), data);
      return data;
    } catch (err) { console.error(`[REPORT ERROR] ${err.stack || err}`); return null; }
  };
  const stop = signal => { error ||= `Stopped by ${signal}`; agent?.stop(); saveReport('stopping'); };
  const onInt = () => stop('SIGINT'); const onTerm = () => stop('SIGTERM');
  try {
    // Lazy imports keep argument/brief/report regression tests completely model-free.
    const { AgentOrchestrator } = require('../out/orchestrator/AgentOrchestrator');
    const { initLogger } = require('../out/utils/logging');
    initLogger({ appendLine: line => console.log(line) }, path.join(invocationDir, 'diagnostics.log'));
    agent = new AgentOrchestrator(args.workspace);
    agent.setCallbacks({
      onLog: (message, level) => {
        console.log(`${new Date().toISOString()} [${level}] ${message}`);
        const turn = /\[R([1-4])\]\s+([^:]+):/.exec(message);
        if (turn) { context.turns.push({ round: Number(turn[1]), agentId: turn[2], at: new Date().toISOString() }); queueMicrotask(() => saveReport('running')); }
      },
      onPhaseChange: (phase, message) => {
        context.phases.push({ phase, message, at: new Date().toISOString(), elapsedMs: Date.now() - Date.parse(context.startedAt) });
        console.log(`[PHASE] ${phase}: ${message}`); saveReport('running');
      },
      onError: message => { context.callbackErrors.push({ message, at: new Date().toISOString() }); console.error(`[ERROR] ${message}`); },
    });
    process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
    await agent.workspace.initialize();
    context.effectiveConfig = checkpoint(args.workspace).config;
    writeJson(path.join(invocationDir, 'initialized.json'), { at: new Date().toISOString(), effectiveConfig: context.effectiveConfig });
    if (!saveReport('running')) throw new Error('Cannot persist initial benchmark report');
    heartbeat = setInterval(() => saveReport('running'), 60_000);
    deadline = setTimeout(() => stop('declared budget expiry'), args.budgetMinutes * 60_000);
    console.log(`[BENCHMARK] ${invocationId}; brief=${brief.sha256}; workspace=${args.workspace}; budget=${args.budgetMinutes}m`);
    if (args.resume) await agent.resume(); else await agent.runAutonomousGoal(brief.goal);
    const state = agent.getState();
    const completed = !error && state.status === 'completed' && !state.activeTasks.length && !state.failedTasks.length;
    if (!completed) throw new Error(error || `Pipeline ended ${state.status}/${state.currentPhase}`);
    if (!saveReport('pipeline-completed')) throw new Error('Cannot persist final benchmark report');
    console.log(`[BENCHMARK] Pipeline completed; acceptance UNVERIFIED. Report: ${path.join(invocationDir, 'report.json')}`);
    return 0;
  } catch (err) {
    error = err.stack || String(err); saveReport('failed'); console.error(error); return 1;
  } finally {
    clearInterval(heartbeat); clearTimeout(deadline);
    process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm);
    agent?.terminalSessions?.stopAll();
    process.stdout.write = originals[0]; process.stderr.write = originals[1];
  }
}

module.exports = { parseArgs, loadBrief, bindWorkspace, captureImplementation, buildReport, main };
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.stack || error); process.exitCode = 2; });
