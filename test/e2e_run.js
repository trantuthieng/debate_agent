/**
 * End-to-end integration test for AgentOrchestrator.
 * Runs a full brainstorm → critique → second-brainstorm → architect pipeline
 * using the real Ollama models (stops before coding to keep it fast).
 *
 * Usage:  node test/e2e_run.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentOrchestrator } = require('../out/orchestrator/AgentOrchestrator');

const PROMPT = 'Create a simple Node.js CLI tool called "greet" that accepts a --name flag and prints "Hello, <name>!" to stdout.';

async function main() {
  // Create a temp workspace
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-agent-'));
  console.log(`\n[E2E] Workspace: ${root}`);
  console.log(`[E2E] Prompt: ${PROMPT}\n`);

  const orchestrator = new AgentOrchestrator(root);

  orchestrator.setCallbacks({
    onLog: (msg, level) => {
      const tag = level === 'error' ? '❌' : level === 'warn' ? '⚠️ ' : '  ';
      console.log(`${tag} [${level.toUpperCase()}] ${msg}`);
    },
    onPhaseChange: (phase, msg) => {
      console.log(`\n🔷 PHASE → ${phase}: ${msg}`);
    },
    onStateUpdate: (state) => {
      console.log(`   state: ${state.status} / ${state.currentPhase}`);
    },
    onError: (msg) => {
      console.error(`💥 ERROR: ${msg}`);
    },
  });

  const startTime = Date.now();

  try {
    // Use a trimmed model config — only run through architecture, skip coding/testing
    await orchestrator.workspace.initialize();
    orchestrator.workspace.writeUserPrompt(PROMPT);

    // Override model config to use the fastest available models
    const modelConfig = {
      ollamaBaseUrl: 'http://localhost:11434',
      safeMode: false,
      maxFixRetries: 0,
      defaultOptions: { temperature: 0.1, num_ctx: 4096 },
      agents: {
        brainstorm:       { model: 'qwen2.5-coder:7b-instruct',  fallbackModel: 'qwen2.5-coder:7b-instruct' },
        critic:           { model: 'qwen2.5-coder:7b-instruct',  fallbackModel: 'qwen2.5-coder:7b-instruct' },
        secondBrainstorm: { model: 'qwen2.5-coder:7b-instruct',  fallbackModel: 'qwen2.5-coder:7b-instruct' },
        architect:        { model: 'qwen2.5-coder:7b-instruct',  fallbackModel: 'qwen2.5-coder:7b-instruct' },
        taskManager:      { model: 'qwen2.5-coder:7b-instruct',  fallbackModel: 'qwen2.5-coder:7b-instruct' },
        codeWorker:       { model: 'qwen2.5-coder:7b-instruct',  fallbackModel: 'qwen2.5-coder:7b-instruct' },
        reviewer:         { model: 'qwen2.5-coder:7b-instruct',  fallbackModel: 'qwen2.5-coder:7b-instruct' },
        tester:           { model: 'qwen2.5-coder:7b-instruct',  fallbackModel: 'qwen2.5-coder:7b-instruct' },
        fixer:            { model: 'qwen2.5-coder:7b-instruct',  fallbackModel: 'qwen2.5-coder:7b-instruct' },
        finalIntegrator:  { model: 'qwen2.5-coder:7b-instruct',  fallbackModel: 'qwen2.5-coder:7b-instruct' },
      },
    };
    // Write config using absolute path
    orchestrator.workspace.writeFile(
      orchestrator.workspace.modelConfigPath,
      JSON.stringify(modelConfig, null, 2)
    );

    await orchestrator.start(PROMPT);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const state = orchestrator.getState();
    console.log(`\n✅ Workflow finished in ${elapsed}s`);
    console.log(`   Final status: ${state.status} / ${state.currentPhase}`);
    console.log(`   Completed tasks: ${state.completedTasks.length}`);
    console.log(`   Failed tasks: ${state.failedTasks.length}`);

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
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`\n💥 Workflow failed after ${elapsed}s: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
}

main();
