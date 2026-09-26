const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AppVerificationService } = require('../out/services/appVerificationService');
const { BrowserSmokeService } = require('../out/services/browserSmokeService');
const { VerificationPlanner } = require('../out/services/verificationPlanner');
const { TerminalSessionRunner } = require('../out/terminal/TerminalSessionRunner');

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-verification-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

test('app verification does not treat a CLI start script as an HTTP server', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-verification-cli-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    scripts: { start: 'node src/cli.js', test: 'node --test' },
  }));
  let sessionStarted = false;
  const service = new AppVerificationService(
    root,
    {},
    {
      start: () => { sessionStarted = true; throw new Error('CLI must not be started as a server'); },
      read: () => '',
      stop: () => {},
    }
  );

  const result = await service.verify();

  assert.equal(sessionStarted, false);
  assert.equal(result.failed, false);
  assert.deepEqual(result.checks, []);
  assert.match(result.summary, /No start\/dev\/preview script/);
});

test('app verification still recognizes a Node server start script', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-verification-server-'));
  const service = new AppVerificationService(root, {}, {});

  assert.equal(service._previewCommand({ start: 'node src/server.js' }), 'npm start');
  assert.equal(service._previewCommand({ start: 'node src/cli.js' }), null);
  assert.equal(service._previewCommand({ start: 'webpack serve --mode development' }), 'npm start');
});

test('startup exceptions fail verification instead of passing with zero evidence', async t => {
  const root = fixture(t, { 'package.json': { scripts: { start: 'node server.js' } } });
  const service = new AppVerificationService(root, {}, {
    start: () => { throw new Error('server refused to start'); }, stop: () => {},
  });
  service._availablePort = async () => 49123;
  const result = await service.verify();
  assert.equal(result.failed, true);
  assert.match(result.checks[0].stderr, /server refused to start/);
});

test('closed or broken build servers cannot pass against a stale HTTP server', async t => {
  const root = fixture(t, { 'package.json': { scripts: { start: 'webpack serve' } } });
  let stopped = false;
  let launched = '';
  const service = new AppVerificationService(root, {}, {
    start: command => { launched = command; return 'owned'; },
    read: () => 'http://localhost:8080\nERROR in ./src/index.ts: Module not found\n[session closed]',
    stop: id => { assert.equal(id, 'owned'); stopped = true; },
  });
  service._availablePort = async () => 49123;
  service._httpGet = () => { throw new Error('Must reject startup before probing stale server'); };
  const result = await service.verify();
  assert.equal(result.failed, true);
  assert.equal(stopped, true);
  assert.equal(launched, 'npm start -- --port 49123');
  assert.match(result.checks[0].stderr, /Module not found/);
});

test('static HTML needs no package.json and missing bundle URLs fail the HTTP check', async t => {
  const root = fixture(t, { 'index.html': '<!doctype html><body><canvas></canvas><script src="missing.js"></script></body>' });
  const result = await new AppVerificationService(root, {}, {}, { browserSmokeTest: false }).verify();
  assert.equal(result.failed, true);
  assert.equal(result.smokeUrls.length, 1);
  assert.ok(result.checks.some(check => /missing\.js/.test(check.command) && check.stderr === 'HTTP 404'));
  const plan = new VerificationPlanner(root).plan();
  assert.deepEqual(plan.stacks, ['web']);
  assert.deepEqual(plan.blockingIssues, []);
});

test('assigned preview port honors an IPv6 loopback host advertised by the owned server', async t => {
  const root = fixture(t, {});
  const server = http.createServer((req, res) => {
    // Vite's HTML fallback requires an Accept header even for the root URL.
    if (!req.headers.accept?.includes('*/*')) { res.statusCode = 404; }
    res.end('<html>ready</html>');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '::1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const service = new AppVerificationService(root, {}, { read: () => `Local: http://[::1]:${port}/` });
  const result = await service._waitForServer('owned', port);
  assert.equal(result.check.success, true);
  assert.equal(result.url, `http://[::1]:${port}/`);
});

test('a different advertised port cannot replace the port assigned to the owned server', async t => {
  const service = new AppVerificationService(fixture(t, {}), {}, { read: () => 'http://localhost:8080/' });
  service._httpGet = async url => {
    assert.equal(url, 'http://127.0.0.1:49123');
    return { success: true, exitCode: 0, stdout: '', stderr: '' };
  };
  assert.equal((await service._waitForServer('owned', 49123)).check.success, true);
});

test('HTML returned as a bundle by SPA fallback is a failing check even with HTTP 200', async t => {
  const root = fixture(t, {});
  const service = new AppVerificationService(root, {}, {});
  service._httpGet = async url => ({ command: `HTTP GET ${url}`, success: true, exitCode: 0,
    stdout: '<!doctype html><html>SPA fallback</html>', stderr: '', durationMs: 0, contentType: 'text/html' });
  const checks = await service._checkResources('http://127.0.0.1:51234/', '<script src="/wrong/bundle.js"></script>');
  assert.equal(checks.length, 1);
  assert.equal(checks[0].success, false);
  assert.match(checks[0].stderr, /Expected JavaScript but received HTML/);
});

test('HTTP smoke has a wall-clock deadline even when the server keeps streaming bytes', async t => {
  const root = fixture(t, {});
  let chunksSent = 0;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.write('<body>');
    const timer = setInterval(() => { chunksSent++; res.write(' '); }, 10);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const started = Date.now();
  const check = await new AppVerificationService(root, {}, {})._httpGet(url, 150);
  assert.equal(check.success, false);
  assert.match(check.stderr, /wall-clock deadline exceeded/);
  assert.ok(chunksSent > 2, 'Fixture must stream often enough to avoid socket inactivity timeout');
  assert.ok(Date.now() - started < 1_000, 'Continuous bytes must not extend the deadline');
});

test('webpack artifact without a build script plans a real local bundler command', t => {
  const root = fixture(t, {
    'package.json': { scripts: { start: 'webpack serve', test: 'node --test' }, devDependencies: { webpack: '^5.0.0' } },
    'webpack.config.js': "module.exports = {entry: './src/missing.ts'};",
  });
  const plan = new VerificationPlanner(root).plan();
  assert.ok(plan.commands.some(command => command.kind === 'build'
    && command.command === 'node node_modules/webpack/bin/webpack.js --mode production'));
});

test('a browser game without HTML or a server cannot silently skip runtime verification', async t => {
  const root = fixture(t, { 'package.json': { scripts: { test: 'node --test' }, dependencies: { phaser: '^3.0.0' } } });
  const result = await new AppVerificationService(root, {}, {}).verify();
  assert.equal(result.failed, true);
  assert.match(result.checks[0].stderr, /no runnable.*index\.html/);
});

const browserAvailable = Boolean(new BrowserSmokeService(os.tmpdir())._browserExecutable());
test('real headless browser catches a Phaser ReferenceError and captures a working canvas', { skip: !browserAvailable }, async t => {
  const root = fixture(t, {
    'index.html': '<!doctype html><title>Game fixture</title><body><canvas width="600" height="400"></canvas><script src="game.js"></script></body>',
    'game.js': 'new Phaser.Game({type: Phaser.AUTO});',
  });
  const failed = await new AppVerificationService(root, {}, {}).verify();
  assert.equal(failed.failed, true);
  const browserFailure = failed.checks.find(check => check.command.startsWith('Browser smoke'));
  assert.ok(browserFailure, JSON.stringify(failed));
  assert.match(browserFailure.stderr, /ReferenceError: Phaser is not defined/);
  fs.writeFileSync(path.join(root, 'game.js'), 'const ctx=document.querySelector("canvas").getContext("2d");ctx.fillStyle="#fa0";ctx.fillRect(10,10,100,60);');
  const passed = await new AppVerificationService(root, {}, {}).verify();
  assert.equal(passed.failed, false, JSON.stringify(passed));
  const browserSuccess = passed.checks.find(check => check.command.startsWith('Browser smoke'));
  assert.ok(browserSuccess?.success);
  const evidence = JSON.parse(browserSuccess.stdout);
  assert.deepEqual(evidence.page.canvases, [{ width: 600, height: 400 }]);
  assert.ok(fs.statSync(evidence.screenshotPath).size > 100);
});

test('terminal session stop terminates the server child as well as its shell', { skip: process.platform === 'win32' }, async t => {
  const root = fixture(t, { 'server.js': 'setInterval(()=>{},1000);console.log("PID="+process.pid);' });
  const sessions = new TerminalSessionRunner(root, path.join(root, 'logs'));
  t.after(() => sessions.stopAll());
  const id = sessions.start('node server.js');
  let pid;
  for (let i = 0; i < 50; i++) {
    pid = /PID=(\d+)/.exec(sessions.read(id))?.[1];
    if (pid) { break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(pid, sessions.read(id));
  sessions.stop(id);
  let alive = true;
  for (let i = 0; i < 60; i++) {
    try { process.kill(Number(pid), 0); } catch { alive = false; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(alive, false, 'Owned server child survived session.stop');
});

test('a placeholder npm test script is a blocking issue, a real one is not', t => {
  const pkg = test => JSON.stringify({ name: 'g', scripts: { test } });
  const placeholder = fixture(t, { 'package.json': pkg('echo "Tests will be implemented in a later step" && exit 0') });
  assert.ok(new VerificationPlanner(placeholder).plan().blockingIssues.some(issue => /test script is a placeholder/.test(issue)));
  const real = fixture(t, { 'package.json': pkg('echo "running" && jest') });
  assert.ok(!new VerificationPlanner(real).plan().blockingIssues.some(issue => /placeholder/.test(issue)));
});
