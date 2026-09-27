const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const fixture = path.join(__dirname, 'fixtures', 'brick-contract');
const cli = path.join(__dirname, 'acceptance', 'brickBreakerAcceptance.js');
const hasBrowser = [process.env.DEBATE_AGENT_BROWSER_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].some(p => p && fs.existsSync(p));

function run(t, broken) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gameplay-acceptance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(fixture, root, { recursive: true });
  if (broken) {
    const html = path.join(root, 'index.html');
    fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace('<script src="game.js">', `<script>window.BROKEN=${JSON.stringify(broken)}</script><script src="game.js">`));
  }
  const reportFile = path.join(root, 'report.json');
  cp.spawnSync(process.execPath, [cli, root, reportFile], { encoding: 'utf8', timeout: 120_000 });
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  return { report, failed: report.checks.filter(c => !c.passed).map(c => c.label) };
}

test('S3: the gameplay harness accepts a game that honours the contract', { skip: !hasBrowser && 'no Chrome/Edge/Chromium' }, t => {
  const { report, failed } = run(t, '');
  assert.deepEqual(failed, []);
  assert.equal(report.passed, true);
  assert.ok(report.checks.length >= 15);
});

test('S3: the gameplay harness catches a paddle that ignores the keyboard, a missing victory, and a restart that keeps the score', { skip: !hasBrowser && 'no Chrome/Edge/Chromium' }, t => {
  assert.ok(run(t, 'paddle').failed.includes('ArrowLeft moves the paddle left'));
  assert.ok(run(t, 'victory').failed.includes('clearing level 20 shows the victory state'));
  const restart = run(t, 'restart');
  assert.ok(restart.failed.includes('restart after victory resets level and score'), restart.failed.join('; '));
  assert.equal(restart.report.passed, false);
});

test('S3: a page without the state contract is not accepted', { skip: !hasBrowser && 'no Chrome/Edge/Chromium' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gameplay-acceptance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'index.html'), '<canvas></canvas><p>game</p>');
  const reportFile = path.join(root, 'report.json');
  const result = cp.spawnSync(process.execPath, [cli, root, reportFile], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 1);
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  assert.equal(report.passed, false);
  assert.deepEqual(report.checks.map(c => c.label), ['window.__gameState is exposed']);
});
