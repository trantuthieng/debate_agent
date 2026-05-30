const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { CommandPolicy } = require('../../out/terminal/CommandPolicy');
const { PatchService } = require('../../out/services/patchService');
const { SearchService } = require('../../out/services/searchService');

function makeTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'local-agent-capabilities-test-'));
}

test('command policy classifies safe, network, and destructive commands', () => {
  const policy = new CommandPolicy({ requireApprovalForNetwork: true });

  assert.equal(policy.evaluate('npm test').risk, 'safe');
  assert.equal(policy.evaluate('curl https://example.com').risk, 'needs_approval');
  assert.equal(policy.evaluate('rm -rf dist').risk, 'needs_approval');
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
