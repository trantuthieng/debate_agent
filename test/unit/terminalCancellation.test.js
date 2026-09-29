const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { TerminalRunner } = require('../../out/terminal/TerminalRunner');
const { UserAbortError } = require('../../out/utils/errors');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const nodeCommand = file => `"${process.execPath}" ${file}`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-cancellation-'));
  const runner = new TerminalRunner(root, path.join(root, 'terminal.log'));
  t.after(() => {
    runner.cancelActiveCommands();
    // Last-resort fixture cleanup also runs when an assertion fails.
    for (const name of ['parent.json', 'server.json']) {
      try {
        const { pid } = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
        process.kill(pid, 'SIGKILL');
      } catch { /* fixture already exited */ }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, runner };
}

async function waitForFile(root, name) {
  for (let i = 0; i < 150; i++) {
    try { return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')); } catch { /* still starting */ }
    await pause(20);
  }
  throw new Error(`Fixture did not start: ${name}`);
}

function writeServerTree(root) {
  fs.writeFileSync(path.join(root, 'parent.js'), `
    const fs = require('node:fs');
    require('node:child_process').spawn(process.execPath, ['server.js'], { stdio: 'ignore' });
    fs.writeFileSync('parent.json', JSON.stringify({ pid: process.pid }));
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
  `);
  fs.writeFileSync(path.join(root, 'server.js'), `
    const fs = require('node:fs');
    // Ignore TERM and close the inherited pipes: shell 'close' alone must not
    // let the runner settle while this child still owns its listening socket.
    process.on('SIGTERM', () => {});
    const server = require('node:net').createServer();
    server.listen(0, '127.0.0.1', () => {
      fs.writeFileSync('server.json', JSON.stringify({ pid: process.pid, port: server.address().port }));
    });
  `);
}

async function assertPortReleased(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise(resolve => server.close(resolve));
}

test('Stop kills the owned server grandchild even after its parent exits successfully', async t => {
  const { root, runner } = fixture(t);
  writeServerTree(root);
  const outcome = runner.runApprovedCommand(nodeCommand('parent.js'), 15000)
    .then(result => ({ result }), error => ({ error }));
  const server = await waitForFile(root, 'server.json');
  runner.cancelActiveCommands();
  const stopped = await outcome;
  assert.ok(stopped.error instanceof UserAbortError, JSON.stringify(stopped));
  await assertPortReleased(server.port);
  assert.equal(runner.activeProcesses.size, 0);

  // Cancellation is scoped to the stopped command, not retained for a new run.
  fs.writeFileSync(path.join(root, 'next.js'), 'console.log("fresh run");');
  const next = await runner.runApprovedCommand(nodeCommand('next.js'));
  assert.equal(next.success, true);
  assert.match(next.stdout, /fresh run/);
});

test('timeout produces exit 124 and kills a TERM-ignoring server grandchild', async t => {
  const { root, runner } = fixture(t);
  writeServerTree(root);
  const outcome = runner.runApprovedCommand(nodeCommand('parent.js'), 1500);
  const server = await waitForFile(root, 'server.json');
  const result = await outcome;
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 124);
  assert.equal(result.error, 'Command timed out after 1500ms.');
  assert.ok(result.durationMs < 7000, `Unexpected timeout duration: ${result.durationMs}`);
  await assertPortReleased(server.port);
  assert.equal(runner.activeProcesses.size, 0);
});

test('Stop cancels every active command without contaminating a concurrent new command', async t => {
  const { root, runner } = fixture(t);
  fs.writeFileSync(path.join(root, 'wait.js'), 'setInterval(() => {}, 1000);');
  fs.writeFileSync(path.join(root, 'quick.js'), 'console.log("ok");');
  const first = runner.runApprovedCommand(nodeCommand('wait.js')).catch(error => error);
  const second = runner.runApprovedCommand(nodeCommand('wait.js')).catch(error => error);
  runner.cancelActiveCommands();
  const fresh = runner.runApprovedCommand(nodeCommand('quick.js'));
  const results = await Promise.all([first, second, fresh]);
  assert.ok(results[0] instanceof UserAbortError);
  assert.ok(results[1] instanceof UserAbortError);
  assert.equal(results[2].success, true);
  assert.equal(runner.activeProcesses.size, 0);
});

test('large output and accumulated logs remain bounded while preserving output tails', async t => {
  const { root, runner } = fixture(t);
  fs.writeFileSync(path.join(root, 'output.js'), `
    process.stdout.write('x'.repeat(1200000) + 'STDOUT-END');
    process.stderr.write('y'.repeat(1200000) + 'STDERR-END');
  `);
  fs.writeFileSync(path.join(root, 'terminal.log'), Buffer.alloc(5 * 1024 * 1024, 'z'));
  const result = await runner.runApprovedCommand(nodeCommand('output.js'));
  assert.equal(result.success, true);
  assert.ok(result.stdout.length <= 1000100);
  assert.ok(result.stderr.length <= 1000100);
  assert.match(result.stdout, /^\[Output truncated/);
  assert.match(result.stdout, /STDOUT-END$/);
  assert.match(result.stderr, /STDERR-END$/);
  assert.ok(fs.statSync(path.join(root, 'terminal.log')).size <= 5 * 1024 * 1024);
  assert.match(fs.readFileSync(path.join(root, 'terminal.log'), 'utf8'), /^\[Earlier terminal log output truncated/);
});

test('spawn failures settle without leaving an active command', async t => {
  const { root } = fixture(t);
  const runner = new TerminalRunner(path.join(root, 'missing'), path.join(root, 'error.log'));
  const result = await runner.runApprovedCommand(nodeCommand('missing.js'), 1000);
  assert.equal(result.success, false);
  assert.equal(result.exitCode, -1);
  assert.match(result.error, /ENOENT/);
  assert.equal(runner.activeProcesses.size, 0);
});
