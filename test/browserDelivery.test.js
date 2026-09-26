const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { findBrowserDeliveryIssues } = require('../out/utils/browserDelivery');

function project(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

// Benchmark run 8's exact layout.
const run8 = {
  'package.json': JSON.stringify({ scripts: { start: 'npx http-server src' }, dependencies: { phaser: '^3.60.0' } }),
  'src/index.html': '<body><script src="scripts/main.js"></script></body>',
  'src/scripts/main.js': "import Phaser from 'phaser';\nimport GameState from './gameState.js';\n",
  'src/scripts/gameState.js': "import Phaser from 'phaser';\nexport default class GameState {}\n",
};

test('a classic <script> loading an ES module, and bare npm imports without a bundler, are reported', t => {
  const root = project(t, run8);
  const messages = findBrowserDeliveryIssues(root).map(issue => issue.message);
  assert.equal(messages.length, 3, messages.join('\n'));
  assert.match(messages[0], /src\/index\.html loads src\/scripts\/main\.js with a classic <script>.*type="module"/);
  assert.ok(messages.some(m => /src\/scripts\/main\.js imports 'phaser'/.test(m)));
  assert.ok(messages.some(m => /src\/scripts\/gameState\.js imports 'phaser'/.test(m)), 'follows relative imports');
});

test('only issues touching the task\'s changed files are reported per task', t => {
  const root = project(t, run8);
  assert.equal(findBrowserDeliveryIssues(root, ['src/scripts/gameState.js']).length, 1);
  assert.equal(findBrowserDeliveryIssues(root, ['README.md']).length, 0);
});

test('valid delivery models pass: module + import map, CDN global, and a Vite bundler', t => {
  const importMap = project(t, {
    'index.html': '<script type="importmap">{"imports":{"phaser":"https://cdn.jsdelivr.net/npm/phaser@3/dist/phaser.esm.js"}}</script><script type="module" src="main.js"></script>',
    'main.js': "import Phaser from 'phaser';\n",
  });
  const cdnGlobal = project(t, {
    'index.html': '<script src="https://cdn.jsdelivr.net/npm/phaser@3/dist/phaser.min.js"></script><script src="game.js"></script>',
    'game.js': 'new Phaser.Game({});\n',
  });
  const vite = project(t, {
    'package.json': JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' }, devDependencies: { vite: '^5' }, dependencies: { phaser: '^3' } }),
    'index.html': '<script type="module" src="/src/main.ts"></script>',
    'src/main.ts': "import Phaser from 'phaser';\n",
  });
  for (const root of [importMap, cdnGlobal, vite]) {
    assert.deepEqual(findBrowserDeliveryIssues(root), []);
  }
});

test('TypeScript loaded directly by a page without a bundler is reported', t => {
  const root = project(t, {
    'index.html': '<script type="module" src="src/main.ts"></script>',
    'src/main.ts': 'export const x: number = 1;\n',
  });
  assert.match(findBrowserDeliveryIssues(root)[0].message, /cannot run TypeScript without a build step/);
});
