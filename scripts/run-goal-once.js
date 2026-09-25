/**
 * Single-shot autonomous run: starts a fresh goal, or resumes an existing one
 * if the target workspace already has a project_state.json — used directly,
 * or as the child process spawned repeatedly by run-with-auto-resume.js.
 *
 * Usage:
 *   node scripts/run-goal-once.js --workspace <dir> --goal "<goal text>"
 *   node scripts/run-goal-once.js --workspace <dir>   (resumes; requires an existing run there)
 *
 * Exit code 0 only when the project reaches status "completed". Any other
 * outcome (failed, stopped, still running when this process is killed,
 * waiting_for_user) exits non-zero so a wrapping supervisor knows to retry.
 */
const fs = require('node:fs');
const path = require('node:path');
const { AgentOrchestrator } = require('../out/orchestrator/AgentOrchestrator');

function parseArgs(argv) {
  const args = { workspace: null, goal: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace') { args.workspace = argv[++i]; }
    else if (argv[i] === '--goal') { args.goal = argv[++i]; }
  }
  return args;
}

async function main() {
  const { workspace, goal } = parseArgs(process.argv.slice(2));
  if (!workspace) {
    console.error('Usage: node scripts/run-goal-once.js --workspace <dir> [--goal "<goal text>"]');
    process.exitCode = 2;
    return;
  }
  const root = path.resolve(workspace);
  const projectStatePath = path.join(root, '.agent-workspace', 'project_state.json');
  const isResume = fs.existsSync(projectStatePath);
  if (!isResume && !goal) {
    console.error(`No existing run at ${root} and no --goal given — nothing to start.`);
    process.exitCode = 2;
    return;
  }

  const agent = new AgentOrchestrator(root);
  let lastPhase = '';
  agent.setCallbacks({
    onLog: (message, level) => console.log(`${new Date().toISOString()} [${level}] ${message}`),
    onPhaseChange: (phase, message) => console.log(`[PHASE] ${phase}: ${message}`),
    onStateUpdate: state => {
      if (state.currentPhase === lastPhase) { return; }
      lastPhase = state.currentPhase;
      console.log(`[STATE] ${state.status}/${state.currentPhase}`);
    },
    onError: message => console.error(`[ERROR] ${message}`),
  });
  for (const signal of ['SIGINT', 'SIGTERM']) { process.once(signal, () => agent.stop()); }

  console.log(`[RUN] Workspace: ${root}`);
  console.log(isResume ? '[RUN] Resuming an existing run...' : `[RUN] Starting a new run: ${goal}`);
  try {
    if (isResume) { await agent.resume(); } else { await agent.runAutonomousGoal(goal); }
  } finally {
    agent.terminalSessions?.stopAll();
  }

  const state = agent.getState();
  console.log(`[RUN] Ended with status "${state.status}" at phase "${state.currentPhase}".`);
  process.exitCode = state.status === 'completed' ? 0 : 1;
}

main().catch(err => {
  console.error(err.stack || String(err));
  process.exitCode = 1;
});
