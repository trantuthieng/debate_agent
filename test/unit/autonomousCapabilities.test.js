const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { CommandPolicy } = require('../../out/terminal/CommandPolicy');
const { PatchService } = require('../../out/services/patchService');
const { SearchService } = require('../../out/services/searchService');
const { AgentWorkspace } = require('../../out/workspace/AgentWorkspace');
const { ResearchService } = require('../../out/services/researchService');
const { AutonomousToolRegistry } = require('../../out/tools/AutonomousToolRegistry');

function makeTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'local-agent-capabilities-test-'));
}

test('command policy classifies safe, network, and destructive commands', () => {
  const policy = new CommandPolicy({ requireApprovalForNetwork: true });

  assert.equal(policy.evaluate('npm test').risk, 'safe');
  assert.equal(policy.evaluate('curl https://example.com').risk, 'needs_approval');
  assert.equal(policy.evaluate('rm -rf dist').risk, 'needs_approval');
  assert.equal(policy.evaluate('npm test && curl https://example.com').risk, 'needs_approval');
  assert.notEqual(policy.evaluate('npm install-package').matchedRule, 'npm install');
});

test('command policy blocks stderr and combined redirections outside the workspace', () => {
  const policy = new CommandPolicy({ requireApprovalForExternalWrites: true });
  const root = makeTempWorkspace();

  assert.equal(policy.evaluate('node app.js 2>/etc/passwd', root).risk, 'needs_approval');
  assert.equal(policy.evaluate('node app.js &>/etc/hosts', root).risk, 'needs_approval');
  // Redirection that stays inside the workspace is fine.
  assert.equal(policy.evaluate('node app.js > out.log', root).risk, 'safe');
});

test('patch service applies multiple files transactionally (all-or-nothing)', () => {
  const root = makeTempWorkspace();
  const service = new PatchService(root);
  fs.writeFileSync(path.join(root, 'a.txt'), 'old-a\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'old-b\n');

  const goodA = '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-old-a\n+new-a';
  // A patch for b.txt whose context does not match the file -> must fail the batch.
  const badB = '--- a/b.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-DOES-NOT-MATCH\n+new-b';

  const result = service.applyFileChanges([
    { path: 'a.txt', patch: goodA },
    { path: 'b.txt', patch: badB },
  ]);

  assert.equal(result.applied, false);
  // Because b failed, a must NOT have been written either.
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'old-a\n');
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'old-b\n');
});

test('agent workspace journal writes a header and appends timestamped icon entries', () => {
  const root = makeTempWorkspace();
  const ws = new AgentWorkspace(root);

  ws.initializeJournal('Build a relaxing music YouTube channel');
  ws.appendJournal('💡', 'brainstorm', 'Initial idea', 'Use royalty-free loops.');
  ws.appendJournal('⚖️', 'debate-panel', 'Verdict 9/10');

  const contents = fs.readFileSync(ws.journalPath, 'utf8');
  assert.match(contents, /# 🤖 Agent Work Journal/);
  assert.match(contents, /Build a relaxing music YouTube channel/);
  assert.match(contents, /💡 Initial idea/);
  assert.match(contents, /\*\*brainstorm\*\*/);
  assert.match(contents, /Use royalty-free loops\./);
  assert.match(contents, /⚖️ Verdict 9\/10/);
  // Newest entry is at the bottom (append-only).
  assert.ok(contents.indexOf('Initial idea') < contents.indexOf('Verdict 9/10'));
});

test('research service is opt-in and emits cited, freshness-stamped findings', async () => {
  const off = new ResearchService({});
  assert.equal(off.webEnabled, false);
  assert.equal(off.repoReadsEnabled, false);

  const web = await off.webResearch('anything');
  assert.equal(web.findings.length, 0);
  assert.ok(web.warnings.length >= 1);

  const repo = await off.findCodeExamples('anything');
  assert.ok(repo.warnings.length >= 1);

  const file = await off.readRepoFile('https://github.com/x/y/blob/main/a.ts');
  assert.ok('error' in file);

  const formatted = ResearchService.format({
    query: 'q',
    generatedAt: '2026-06-14T00:00:00.000Z',
    findings: [{ source: 'https://example.com/a', title: 'A', retrievedAt: '2026-06-14T00:00:00.000Z', snippet: 'hello' }],
    warnings: [],
  });
  assert.match(formatted, /Source: https:\/\/example\.com\/a/);
  assert.match(formatted, /Retrieved: 2026-06-14/);
});

test('autonomous tool registry asks for command approval instead of silently failing', async () => {
  const okResult = command => ({ command, exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1, success: true });
  const calls = { safe: [], approved: [], asked: [] };
  const terminal = {
    evaluateCommand: command =>
      command.includes('rm') ? { risk: 'needs_approval', reason: 'destructive' } : { risk: 'safe', reason: 'ok' },
    runSafeCommand: async command => { calls.safe.push(command); return okResult(command); },
    runApprovedCommand: async command => { calls.approved.push(command); return okResult(command); },
  };

  // Declines (with a clear reason) when the approval handler says no.
  const deny = new AutonomousToolRegistry(null, null, terminal, null, null, async (command, reason) => {
    calls.asked.push([command, reason]);
    return false;
  });
  const denied = await deny.execute({ id: '1', name: 'run_command', args: { command: 'rm -rf build' } });
  assert.equal(denied.success, false);
  assert.match(denied.error, /not approved/);
  assert.equal(calls.approved.length, 0);
  assert.equal(calls.asked.length, 1);

  // Runs as an approved command when the boss approves.
  const allow = new AutonomousToolRegistry(null, null, terminal, null, null, async () => true);
  const ran = await allow.execute({ id: '2', name: 'run_command', args: { command: 'rm -rf build' } });
  assert.equal(ran.success, true);
  assert.equal(calls.approved.length, 1);

  // Safe commands never trigger an approval prompt.
  const safe = await allow.execute({ id: '3', name: 'run_command', args: { command: 'npm test' } });
  assert.equal(safe.success, true);
  assert.deepEqual(calls.safe, ['npm test']);
});

test('search service finds repository context without requiring rg', async () => {
  const root = makeTempWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/agent.ts'), 'export const toolCalling = true;\n');

  const results = await new SearchService(root).search('toolCalling', { maxResults: 5 });

  assert.equal(results.length, 1);
  assert.equal(results[0].file, 'src/agent.ts');
  assert.equal(results[0].line, 1);
});

test('patch service applies focused unified diff hunks', () => {
  const root = makeTempWorkspace();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/demo.ts'), 'const mode = "old";\n');
  const patch = [
    '--- a/src/demo.ts',
    '+++ b/src/demo.ts',
    '@@ -1,1 +1,1 @@',
    '-const mode = "old";',
    '+const mode = "new";',
  ].join('\n');

  const result = new PatchService(root).applyFileChanges([
    { path: 'src/demo.ts', action: 'modify', patch },
  ]);

  assert.equal(result.applied, true);
  assert.equal(fs.readFileSync(path.join(root, 'src/demo.ts'), 'utf8'), 'const mode = "new";\n');
});
