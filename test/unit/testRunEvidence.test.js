const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { countExecutedTests, stripJsComments } = require('../../out/utils/testRunEvidence');
const { isPlaceholderScript } = require('../../out/utils/testTaskContracts');
const { VerificationPlanner } = require('../../out/services/verificationPlanner');

test('audit C04: executed test counts are read from each common runner summary', () => {
  assert.deepEqual(countExecutedTests('ℹ tests 5\nℹ suites 0\nℹ pass 4\nℹ fail 0\nℹ skipped 1\nℹ todo 0'), { executed: 4, skipped: 1, runner: 'node:test' });
  assert.equal(countExecutedTests('# tests 0\n# pass 0').executed, 0);
  assert.equal(countExecutedTests('Tests:       1 skipped, 2 passed, 3 total').executed, 2);
  assert.equal(countExecutedTests(' Test Files  1 passed (1)\n      Tests  2 passed | 1 skipped (3)').executed, 2);
  assert.equal(countExecutedTests('\u001b[32m      Tests  \u001b[1m4 passed\u001b[22m (4)\u001b[39m').executed, 4, 'ANSI colours are ignored');
  assert.equal(countExecutedTests('  3 passing (12ms)\n  1 failing').executed, 4);
  assert.equal(countExecutedTests('  0 passing (1ms)').executed, 0);
  assert.equal(countExecutedTests('======== 3 passed, 1 skipped in 0.12s ========').executed, 3);
  assert.equal(countExecutedTests('======== no tests ran in 0.01s ========').executed, 0);
  assert.equal(countExecutedTests('No tests found, exiting with code 0').executed, 0);
  assert.equal(countExecutedTests('all good').executed, null, 'an unknown runner is unknown, not zero');
});

test('audit C04: no-op eval scripts are placeholders, real runners are not', () => {
  assert.ok(isPlaceholderScript('node -e "process.exit(0)"'));
  assert.ok(isPlaceholderScript("node -e 'process.exit()'"));
  assert.ok(isPlaceholderScript('node --eval ""'));
  assert.ok(!isPlaceholderScript('node --test tests/'));
  assert.ok(!isPlaceholderScript('node -e "require(\'./tests/run\')"'));
  assert.ok(!isPlaceholderScript('vitest run'));
});

test('audit C04: comment-only and fully skipped tests are placeholders; tests using an assertion helper are not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c04-'));
  const planner = new VerificationPlanner(root);
  const placeholder = (content) => planner._looksLikePlaceholderTest('tests/game.test.js', content);
  assert.ok(placeholder("it('progress',()=>{ // Add assertions here\n});"));
  assert.ok(placeholder("test('a', async () => {\n  /* TODO */\n});"));
  assert.ok(placeholder("it.skip('a', () => { expect(1).toBe(1); });\ntest.todo('b');"));
  assert.ok(placeholder("xit('a', () => { expect(1).toBe(1); });"));
  assert.ok(!placeholder("it('uses a helper', () => { expectLevelLoads(3); });"));
  assert.ok(!placeholder("it.skip('later', () => {});\nit('now', () => { assert.equal(add(1, 2), 3); });"), 'one active test is enough');
  assert.ok(!placeholder("const url = 'http://x'; it('a', () => { assert.ok(url); });"), 'a URL in a string is not a comment');
  assert.equal(stripJsComments("a // b\n/* c */d"), 'a \nd');
});

test('audit C04: the planner blocks a no-op test script', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c04-plan-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  const plan = new VerificationPlanner(root).plan();
  assert.ok(plan.blockingIssues.length > 0, JSON.stringify(plan.blockingIssues));
});
