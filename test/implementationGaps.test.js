const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { findUnwiredModules, findCommentOnlyImplementations, findProjectCommentOnlyImplementations } = require('../out/utils/implementationGaps');

function project(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-gaps-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

// Benchmark run 11's delivered layout, reduced.
const run11 = {
  'src/index.html': '<canvas id="gameCanvas"></canvas><script type="module" src="index.js"></script>',
  'src/index.js': "function updateGameState() {\n  // Update game state logic here\n}\nfunction loop() { updateGameState(); requestAnimationFrame(loop); }\nloop();\n",
  'src/game/Paddle.js': 'export default class Paddle { moveLeft() { this.x -= 8; } }\n',
  'src/game/Input.js': "function onKey(event) {\n  switch (event.key) {\n    case 'ArrowLeft':\n      // Move paddle left\n      break;\n    case 'Enter':\n    case ' ':\n      // Start or restart game\n      break;\n    case 'p':\n      togglePause();\n      break;\n  }\n}\n",
  'tests/game.test.js': "import Paddle from '../src/game/Paddle.js';\n",
  'vite.config.js': 'export default {};\n',
};

test('run 11: modules no page loads are reported even though a test imports them', t => {
  const { entries, unwired } = findUnwiredModules(project(t, run11));
  assert.deepEqual(entries, ['src/index.html']);
  assert.deepEqual(unwired.sort(), ['src/game/Input.js', 'src/game/Paddle.js']);
});

test('run 11: an empty loop body and comment-only key cases are reported with their location', t => {
  const issues = findProjectCommentOnlyImplementations(project(t, run11));
  assert.ok(issues.some(i => /src\/index\.js:1 has a function body that is only a comment \("Update game state logic here"\)/.test(i)), issues.join('\n'));
  assert.ok(issues.some(i => /src\/game\/Input\.js:\d+ has a switch case that is only a comment \("Move paddle left"\)/.test(i)), issues.join('\n'));
  assert.ok(issues.some(i => /"Start or restart game"/.test(i)), issues.join('\n'));
  assert.ok(!issues.some(i => /togglePause|'p'/.test(i)), 'a case with code is fine');
});

test('a wired game (static, dynamic and extensionless imports, a worker, a server script) has no gaps', t => {
  const root = project(t, {
    'package.json': JSON.stringify({ scripts: { start: 'node server/index.js', dev: 'vite' } }),
    'server/index.js': "const util = require('./util');\n",
    'server/util.js': 'module.exports = {};\n',
    'index.html': '<script type="module">import { boot } from "./src/main";\nboot();</script>',
    'src/main.ts': "import Paddle from './game/Paddle.js';\nexport async function boot() { const m = await import('./game/levels'); new Worker('./worker.js'); return [Paddle, m]; }\n",
    'src/game/Paddle.ts': 'export default class Paddle {}\n',
    'src/game/levels.js': 'export const levels = [];\n',
    'src/worker.js': 'self.onmessage = () => {};\n',
    'src/tests.js': 'export {};\n',
  });
  assert.deepEqual(findUnwiredModules(root).unwired, []);
  assert.deepEqual(findUnwiredModules(project(t, { 'cli.js': 'export {};\n' })), { entries: [], unwired: [] }, 'no page: not a web app');
});

test('deliberate no-ops, catch blocks, empty bodies and tests are not stubs', () => {
  const code = [
    'export function dispose() {\n  // No cleanup required\n}',
    'try { risky(); } catch (err) {\n  // ignore: best effort\n}',
    'const noop = () => {};',
    'function preload() {\n  // Load assets (none: shapes are drawn procedurally)\n}',
    "switch (k) {\n  case 'a':\n  // fall through\n  case 'b':\n    go();\n    break;\n}",
    'function real() {\n  // move left\n  x -= 1;\n}',
  ].join('\n');
  assert.deepEqual(findCommentOnlyImplementations('src/a.js', code), []);
  assert.deepEqual(findCommentOnlyImplementations('tests/a.test.js', 'function f() {\n  // TODO\n}'), []);
});
