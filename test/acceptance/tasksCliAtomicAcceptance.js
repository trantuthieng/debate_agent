'use strict';
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Supplement to T06. This proves one real Node rename failure path only;
// other storage primitives require their own fault evidence, never a guessed pass.
function runTasksCliAtomicAcceptance({ workspaceRoot, commandArgv }) {
  assert.ok(Array.isArray(commandArgv) && commandArgv.length > 0);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-cli-atomic-'));
  const data = path.join(scratch, 'tasks.json');
  const trace = path.join(scratch, 'fault.jsonl');
  const evidence = [];
  const invoke = (args, env = {}) => {
    const result = cp.spawnSync(commandArgv[0], [...commandArgv.slice(1), '--data', data, ...args, '--json'], {
      cwd: workspaceRoot, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
      env: { ...process.env, ...env }, shell: false,
    });
    evidence.push({ args, status: result.status, signal: result.signal, error: result.error?.message,
      stdout: result.stdout, stderr: result.stderr });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  };
  try {
    const seeded = invoke(['add', 'Preserve original task']);
    assert.equal(seeded.status, 0, seeded.stderr);
    const before = fs.readFileSync(data);
    JSON.parse(before.toString());
    const failed = invoke(['add', 'Must not survive failed replacement'], {
      NODE_OPTIONS: `--require ${JSON.stringify(path.join(__dirname, 'atomicWriteProbe.cjs'))}`,
      MCORE_ATOMIC_TARGET: data, MCORE_ATOMIC_TRACE: trace,
    });
    const operations = fs.existsSync(trace)
      ? fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    const common = { requirement: 'T06', evidence, operations, scope: 'Node filesystem rename pre-replacement failure' };
    if (operations.some(item => item.operation.startsWith('direct-'))) {
      return { ...common, status: 'failed', reason: 'The update writes/removes the original data directly instead of atomically replacing it.' };
    }
    if (!operations.some(item => item.operation === 'rename-fault')) {
      return { ...common, status: 'unverified', reason: 'No supported replacement operation was intercepted; inspect storage implementation and supply matching fault evidence.' };
    }
    assert.notEqual(failed.status, 0, 'Injected storage failure must not be reported as success');
    assert.ok(failed.stderr.trim(), 'Storage failure must have an error message');
    assert.deepEqual(fs.readFileSync(data), before, 'Original bytes changed after failed replacement');
    const reopened = invoke(['list']);
    assert.equal(reopened.status, 0, reopened.stderr);
    JSON.parse(reopened.stdout);
    return { ...common, status: 'passed', reason: 'Injected rename failure preserved original bytes and the store reopens in a fresh process.' };
  } catch (error) {
    return { requirement: 'T06', status: 'failed', reason: error.message, evidence };
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
module.exports = { runTasksCliAtomicAcceptance };

if (require.main === module) {
  const [workspaceRoot, report, separator, ...commandArgv] = process.argv.slice(2);
  if (!workspaceRoot || !report || separator !== '--') {
    console.error('Usage: node tasksCliAtomicAcceptance.js WORKSPACE REPORT.json -- EXECUTABLE ARG...');
    process.exitCode = 1;
  } else {
    const result = runTasksCliAtomicAcceptance({ workspaceRoot, commandArgv });
    fs.writeFileSync(report, JSON.stringify(result, null, 2) + '\n');
    process.exitCode = result.status === 'passed' ? 0 : result.status === 'failed' ? 1 : 2;
  }
}
