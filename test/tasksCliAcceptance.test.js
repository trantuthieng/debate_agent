const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runTasksCliAcceptance } = require('./acceptance/tasksCliAcceptance');

const fixture = path.join(__dirname, 'fixtures', 'tasks-cli-contract');
const harness = path.join(__dirname, 'acceptance', 'tasksCliAcceptance.js');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-cli-harness-test-'));
  fs.cpSync(fixture, root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(t, mode = 'working') {
  const root = workspace(t);
  return runTasksCliAcceptance({
    workspaceRoot: root,
    commandArgv: [process.execPath, path.join(root, 'cli.js'), '--fixture-mode', mode],
  });
}

test('S4 tasks CLI: working subprocess fixture passes implemented requirements without claiming full acceptance', t => {
  const report = run(t);
  assert.deepEqual(report.checks.filter(item => item.status === 'failed'), []);
  assert.equal(report.subsetPassed, true);
  assert.equal(report.status, 'unverified');
  assert.equal(report.passed, false, 'Partial verification must not pass the whole goal');
  assert.deepEqual(report.unverifiedRequirements, ['T06', 'T08']);
  assert.deepEqual(report.requirements.filter(item => item.status === 'passed').map(item => item.id), ['T01', 'T02', 'T03', 'T04', 'T05', 'T07']);
  assert.ok(report.evidence.length >= 20, 'Commands must run in separate subprocesses');
  assert.ok(report.evidence.some(item => item.args.includes('Đọc sách 📚')));
});

for (const [mode, expected] of [
  ['persistence', 'T02'], ['error-code', 'T05'], ['isolation', 'T04'],
  ['done-all', 'T03'], ['remove-all', 'T04'], ['json-noise', 'T07'],
  ['corrupt-on-error', 'T05'], ['malformed-overwrite', 'T05'],
]) {
  test(`S4 tasks CLI mutation: ${mode} fails ${expected}`, t => {
    const report = run(t, mode);
    assert.equal(report.status, 'failed');
    assert.equal(report.subsetPassed, false);
    assert.equal(report.passed, false);
    assert.equal(report.requirements.find(item => item.id === expected)?.status, 'failed', JSON.stringify(report.checks));
  });
}

test('S4 tasks CLI: standalone report and exit status expose incomplete verification', t => {
  const root = workspace(t);
  const output = path.join(root, 'acceptance.json');
  const result = cp.spawnSync(process.execPath, [harness, root, output, '--', process.execPath, path.join(root, 'cli.js')], {
    encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(report.status, 'unverified');
  assert.equal(report.subsetPassed, true);
  assert.match(result.stdout, /unverified: T06, T08/);
});
