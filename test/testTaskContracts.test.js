const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { findUndeclaredPackageImports, findLanguageMismatch, findTestScriptIssues, isPlaceholderScript } = require('../out/utils/testTaskContracts');

function project(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-contracts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

// Benchmark run 8's test task output.
const run8 = {
  'package.json': JSON.stringify({ scripts: { test: "echo 'No tests yet.'" }, dependencies: { phaser: '^3.60.0' } }),
  'src/scripts/main.js': "import Phaser from 'phaser';\n",
  'tests/game.test.ts': "import { expect } from 'chai';\nimport { Game } from 'phaser';\nimport fs from 'node:fs';\nimport path from 'path';\nimport MainScene from '../src/scripts/main';\n",
};

test('run 8: a TS test in a JS project, an undeclared chai import and a placeholder test script are all reported', t => {
  const root = project(t, run8);
  const changed = ['tests/game.test.ts'];
  const all = Object.keys(run8);

  const language = findLanguageMismatch(root, changed, all);
  const deps = findUndeclaredPackageImports(root, changed);
  const script = findTestScriptIssues(root, changed);

  assert.match(language[0], /tests\/game\.test\.ts is TypeScript, but this is a JavaScript project/);
  assert.equal(deps.length, 1, deps.join('\n'));
  assert.match(deps[0], /imports 'chai'.*does not declare "chai"/);
  assert.match(script[0], /"test" script is a placeholder/);
});

test('a TypeScript project, declared/aliased/import-mapped packages and a real runner pass', t => {
  const root = project(t, {
    'package.json': JSON.stringify({ scripts: { test: 'vitest run' }, dependencies: { phaser: '^3' }, devDependencies: { vitest: '^2', '@testing-library/dom': '^10' } }),
    'tsconfig.json': '{}',
    'index.html': '<script type="importmap">{"imports":{"lodash":"https://cdn.jsdelivr.net/npm/lodash-es/lodash.js"}}</script>',
    'tests/game.test.ts': "import { describe, it, expect } from 'vitest';\nimport { screen } from '@testing-library/dom/dist/queries';\nimport Phaser from 'phaser';\nimport x from '@/utils/x';\nimport _ from 'lodash';\nimport { readFileSync } from 'node:fs';\n",
  });
  const changed = ['tests/game.test.ts'];
  assert.deepEqual(findLanguageMismatch(root, changed, ['tests/game.test.ts']), []);
  assert.deepEqual(findUndeclaredPackageImports(root, changed), []);
  assert.deepEqual(findTestScriptIssues(root, changed), []);
});

test('the test script is only required when the task writes tests', t => {
  const root = project(t, { 'package.json': JSON.stringify({ scripts: {} }), 'src/game.js': 'export {};\n' });
  assert.deepEqual(findTestScriptIssues(root, ['src/game.js']), []);
  assert.match(findTestScriptIssues(root, ['src/game.test.js'])[0], /no "test" script/);
});

test('placeholder scripts are recognised; real commands are not', () => {
  for (const script of ["echo 'No tests yet.'", 'echo "later" && exit 0', 'true']) { assert.equal(isPlaceholderScript(script), true, script); }
  for (const script of ['vitest run', 'echo start && jest', 'node --test']) { assert.equal(isPlaceholderScript(script), false, script); }
});
