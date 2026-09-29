/**
 * Supervises a long autonomous run and auto-resumes it after a crash — the
 * one thing nothing INSIDE a killed process can do for itself (an OOM-kill,
 * SIGBUS, or any hard process kill leaves nothing behind to resurrect it).
 * This is the external watchdog: it spawns the actual run as a child
 * process, and on any non-"completed" exit, respawns pointed at the same
 * workspace — which now resumes from the last saved checkpoint (per-turn
 * debate progress, or the sprint/task checkpoint) instead of starting over —
 * up to a bounded number of attempts.
 *
 * Usage:
 *   node scripts/run-with-auto-resume.js --workspace <dir> --goal "<goal text>" [--max-attempts 8] [--backoff-ms 5000]
 *
 * A manual Ctrl+C (SIGINT) reaches this process and its child together (same
 * terminal process group) and is NOT treated as a crash to recover from —
 * this process exits immediately without respawning.
 */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

function parseArgs(argv) {
  const args = { workspace: null, goal: null, maxAttempts: 8, backoffMs: 5_000 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace') { args.workspace = argv[++i]; }
    else if (argv[i] === '--goal') { args.goal = argv[++i]; }
    else if (argv[i] === '--max-attempts') { args.maxAttempts = Math.max(1, Number(argv[++i]) || 8); }
    else if (argv[i] === '--backoff-ms') { args.backoffMs = Math.max(0, Number(argv[++i]) || 5_000); }
  }
  return args;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function readState(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, '.agent-workspace', 'project_state.json'), 'utf8')); }
  catch { return null; }
}

function logLine(root, line) {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(`[SUPERVISOR] ${line}`);
  try {
    const logDir = path.join(root, '.agent-workspace', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'supervisor.log'), `${stamped}\n`);
  } catch { /* logging must never block a retry */ }
}

function runOnce(root, goal) {
  return new Promise(resolve => {
    const child = cp.spawn(
      process.execPath,
      [path.join(__dirname, 'run-goal-once.js'), '--workspace', root, ...(goal ? ['--goal', goal] : [])],
      { stdio: 'inherit' }
    );
    child.on('exit', (code, signal) => resolve({ code, signal }));
    child.on('error', err => resolve({ code: 1, signal: null, spawnError: err }));
  });
}

async function main() {
  const { workspace, goal, maxAttempts, backoffMs } = parseArgs(process.argv.slice(2));
  if (!workspace) {
    console.error('Usage: node scripts/run-with-auto-resume.js --workspace <dir> --goal "<goal text>" [--max-attempts 8] [--backoff-ms 5000]');
    process.exitCode = 2;
    return;
  }
  const root = path.resolve(workspace);
  fs.mkdirSync(root, { recursive: true });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    logLine(root, `Attempt ${attempt}/${maxAttempts}: launching run-goal-once.js...`);
    const { code, signal, spawnError } = await runOnce(root, goal);
    if (spawnError) {
      logLine(root, `Attempt ${attempt}/${maxAttempts} could not even start: ${spawnError.message}`);
    } else {
      logLine(root, `Attempt ${attempt}/${maxAttempts} exited (code=${code}, signal=${signal ?? 'none'}).`);
    }

    const state = readState(root);
    if (state?.status === 'completed') {
      logLine(root, 'Project completed. Nothing more to do.');
      process.exitCode = 0;
      return;
    }
    if (attempt === maxAttempts) {
      logLine(root, `Giving up after ${maxAttempts} attempts. Last status: "${state?.status ?? 'unknown'}" at phase "${state?.currentPhase ?? 'unknown'}".`);
      process.exitCode = 1;
      return;
    }

    const delay = Math.min(backoffMs * attempt, 60_000);
    logLine(root, `Not complete yet (status "${state?.status ?? 'unknown'}"). Waiting ${delay}ms before resuming...`);
    await sleep(delay);
  }
}

main().catch(err => {
  console.error(err.stack || String(err));
  process.exitCode = 1;
});
