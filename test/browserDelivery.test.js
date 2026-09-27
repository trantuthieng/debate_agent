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

const { findMissingScriptTargets } = require('../out/utils/browserDelivery');

test('a package.json script that runs a missing file is reported (run 10: node server.js)', t => {
  const root = project(t, {
    'package.json': JSON.stringify({ scripts: { start: 'node server.js', dev: 'nodemon --watch src ./src/app.js', build: 'vite build', test: 'jest', serve: 'node --inspect tools/run.mjs' } }),
    'src/app.js': '',
  });
  const messages = findMissingScriptTargets(root).map(issue => issue.message);
  assert.equal(messages.length, 2, messages.join('\n'));
  assert.match(messages[0], /"start" runs server\.js, which does not exist/);
  assert.match(messages[1], /"serve" runs tools\/run\.mjs/);
  assert.equal(findMissingScriptTargets(root, ['src/game.js']).length, 0, 'per task: only when package.json or the target changed');
});

test('audit C05: an inline module importing a bare package without an import map is reported', t => {
  const root = project(t, { 'index.html': `<script type="module">import Phaser from 'phaser';</script>` });
  const messages = findBrowserDeliveryIssues(root).map(issue => issue.message);
  assert.equal(messages.length, 1, messages.join('\n'));
  assert.match(messages[0], /An inline script in index\.html imports 'phaser'/);

  const mapped = project(t, { 'index.html': `<script type="importmap">{"imports":{"phaser":"https://cdn.jsdelivr.net/npm/phaser@3/dist/phaser.esm.js"}}</script>\n<script type="module">import Phaser from 'phaser';</script>` });
  assert.deepEqual(findBrowserDeliveryIssues(mapped), [], 'an import map resolves it');
});

test('audit C05: a classic script that import()s a bare package is reported, a relative import() is followed', t => {
  const root = project(t, { 'index.html': '<script src="main.js"></script>', 'main.js': "import('phaser');" });
  assert.match(findBrowserDeliveryIssues(root)[0].message, /main\.js imports 'phaser'/);

  const relative = project(t, {
    'index.html': '<script src="main.js"></script>',
    'main.js': "import('./game.js').then(m => m.start());",
    'game.js': "import Phaser from 'phaser';\nexport function start() {}",
  });
  assert.match(findBrowserDeliveryIssues(relative)[0].message, /game\.js imports 'phaser'/);
});

test('audit C05: a bundler only listed in devDependencies does not count when the page is served by a static server', t => {
  const files = {
    'package.json': JSON.stringify({ devDependencies: { vite: '1.0.0' }, scripts: { start: 'http-server .' } }),
    'index.html': '<script type="module" src="main.js"></script>',
    'main.js': "import Phaser from 'phaser';",
  };
  assert.equal(findBrowserDeliveryIssues(project(t, files)).length, 1);
  const served = { ...files, 'package.json': JSON.stringify({ devDependencies: { vite: '1.0.0' }, scripts: { dev: 'vite', build: 'vite build' } }) };
  assert.deepEqual(findBrowserDeliveryIssues(project(t, served)), [], 'a bundler the scripts run resolves bare imports');
  const npx = { ...files, 'package.json': JSON.stringify({ scripts: { start: 'npx vite --port 5173' } }) };
  assert.deepEqual(findBrowserDeliveryIssues(project(t, npx)), []);
});

test('audit C05: without a bundler a relative import must name the file exactly, since the browser adds no extension', t => {
  const root = project(t, {
    'index.html': '<script type="module" src="src/main.js"></script>',
    'src/main.js': "import { Ball } from './ball';\nimport { Hud } from './hud.js';",
    'src/ball.js': 'export class Ball {}',
    'src/hud.js': 'export class Hud {}',
  });
  const messages = findBrowserDeliveryIssues(root).map(issue => issue.message);
  assert.equal(messages.length, 1, messages.join('\n'));
  assert.match(messages[0], /src\/main\.js imports '\.\/ball'.*the file is src\/ball\.js/);
});
