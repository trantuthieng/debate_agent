const assert = require('node:assert/strict');
const test = require('node:test');

const { findUnresolvedRequireImports, findBrowserIncompatibleNodeUsage, findUnreferencedExportingFiles, isBinaryAssetPath, toolchainMarkerStack, stackTextMentions } = require('../../out/utils/moduleContracts');

// Reproduces a real failed run: a generated test file destructured six names
// from '../src/logic', but src/logic.js only defined createInitialState and
// never exported anything. Both the LLM reviewer and the LLM quality auditor
// approved it ("production-ready"); npm test then failed with
// "TypeError: createInitialState is not a function".
test('flags a require of names a module with zero export syntax never exports', () => {
  // src/logic.js in the real failed run had no module.exports at all, so as a
  // CommonJS module it exports nothing — every destructured name is missing.
  const issues = findUnresolvedRequireImports(
    [
      {
        path: 'test/logic.test.js',
        content: `const { MAX_LEVEL, advanceLevel, createInitialState, updateGame } = require('../src/logic');\ntest('x', () => {});`,
      },
    ],
    relPath =>
      relPath === 'src/logic.js'
        ? 'function createInitialState() { return {}; }\nfunction updateGame() {}\n'
        : null
  );
  assert.equal(issues.length, 4);
  assert.ok(issues.every(i => i.includes('test/logic.test.js') && i.includes('does not export it')));
});

test('flags only the missing names, not ones the module actually exports', () => {
  const issues = findUnresolvedRequireImports(
    [
      {
        path: 'test/logic.test.js',
        content: `const { createInitialState, updateGame, advanceLevel } = require('../src/logic');`,
      },
    ],
    relPath =>
      relPath === 'src/logic.js'
        ? 'function createInitialState() { return {}; }\nmodule.exports = { createInitialState };\n'
        : null
  );
  assert.equal(issues.length, 2);
  assert.ok(issues.some(i => i.includes('updateGame')));
  assert.ok(issues.some(i => i.includes('advanceLevel')));
});

test('does not flag a module with zero export syntax when nothing is destructured', () => {
  const issues = findUnresolvedRequireImports(
    [{ path: 'src/app.js', content: `require('./logic');\n` }],
    relPath => (relPath === 'src/logic.js' ? 'function noop() {}\n' : null)
  );
  assert.deepEqual(issues, []);
});

test('passes when the target module exports everything requested', () => {
  const issues = findUnresolvedRequireImports(
    [
      {
        path: 'test/logic.test.js',
        content: `const { createInitialState, updateGame } = require('../src/logic');`,
      },
    ],
    relPath =>
      relPath === 'src/logic.js'
        ? `function createInitialState() { return {}; }\nfunction updateGame() {}\nmodule.exports = { createInitialState, updateGame };\n`
        : null
  );
  assert.deepEqual(issues, []);
});

test('resolves the target from the other changed files in the same task before hitting disk', () => {
  const issues = findUnresolvedRequireImports(
    [
      {
        path: 'test/logic.test.js',
        content: `const { createInitialState } = require('../src/logic');`,
      },
      {
        path: 'src/logic.js',
        content: `function createInitialState() { return {}; }\nmodule.exports = { createInitialState };\n`,
      },
    ],
    () => null // disk has nothing yet — both files are new in this same task
  );
  assert.deepEqual(issues, []);
});

test('flags a require of a file that does not exist at all', () => {
  const issues = findUnresolvedRequireImports(
    [{ path: 'src/app.js', content: `const { helper } = require('./missing');` }],
    () => null
  );
  assert.equal(issues.length, 1);
  assert.match(issues[0], /no matching file/);
});

test('treats module.exports = Identifier as inconclusive, not a false positive', () => {
  const issues = findUnresolvedRequireImports(
    [{ path: 'test/x.test.js', content: `const { foo } = require('./thing');` }],
    relPath => (relPath === 'test/thing.js' ? `class Thing { foo() {} }\nmodule.exports = Thing;\n` : null)
  );
  assert.deepEqual(issues, []);
});

test('treats an ESM-syntax target file as inconclusive rather than flagging it', () => {
  const issues = findUnresolvedRequireImports(
    [{ path: 'test/x.test.js', content: `const { foo } = require('./thing');` }],
    relPath => (relPath === 'test/thing.js' ? `export function foo() {}\n` : null)
  );
  assert.deepEqual(issues, []);
});

test('ignores destructured requires of bare package names', () => {
  const issues = findUnresolvedRequireImports(
    [{ path: 'test/x.test.js', content: `const { test } = require('node:test');` }],
    () => null
  );
  assert.deepEqual(issues, []);
});

// Reproduces a real failed run (2026-09-12): a generated src/utils/levelManager.js
// read levels.json via `require('fs')` + `path.join(__dirname, ...)` but was
// declared `export default { ... }` for a Vite/browser bundle. It passed both
// LLM review and the quality audit, then crashed the moment the browser
// loaded it: "ReferenceError: require is not defined".
test('flags a file that mixes ESM export syntax with require("fs")/__dirname', () => {
  const issues = findBrowserIncompatibleNodeUsage([
    {
      path: 'src/utils/levelManager.js',
      content:
        `const fs = require('fs');\nconst path = require('path');\n\n` +
        `const levels = JSON.parse(fs.readFileSync(path.join(__dirname, '../levels.json'), 'utf8'));\n\n` +
        `function loadLevel(id) { return levels.levels.find(l => l.id === id); }\n\n` +
        `export default { loadLevel };\n`,
    },
  ]);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /levelManager\.js/);
  assert.match(issues[0], /require\("fs"\)/);
  assert.match(issues[0], /__dirname/);
});

test('does not flag a pure ESM file with no Node-only APIs', () => {
  const issues = findBrowserIncompatibleNodeUsage([
    { path: 'src/utils/levelManager.js', content: `import levels from '../levels.json';\nexport default { loadLevel: id => levels.levels.find(l => l.id === id) };\n` },
  ]);
  assert.deepEqual(issues, []);
});

test('does not flag a pure CommonJS file with no ESM syntax at all', () => {
  const issues = findBrowserIncompatibleNodeUsage([
    { path: 'scripts/build.js', content: `const fs = require('fs');\nconst path = require('path');\nfs.readFileSync(path.join(__dirname, 'x'));\nmodule.exports = {};\n` },
  ]);
  assert.deepEqual(issues, []);
});

test('does not flag require() of a non-builtin package alongside ESM syntax', () => {
  const issues = findBrowserIncompatibleNodeUsage([
    { path: 'src/thing.js', content: `import Phaser from 'phaser';\nconst legacy = require('./legacy-helper');\nexport default class Thing {}\n` },
  ]);
  assert.deepEqual(issues, []);
});

test('ignores non-JS/TS files', () => {
  const issues = findBrowserIncompatibleNodeUsage([
    { path: 'src/levels.json', content: `{"__dirname": "not actually code"}` },
  ]);
  assert.deepEqual(issues, []);
});

// Reproduces a real failed run (2026-09-12): Ball.js/Paddle.js/Brick.js were
// fully implemented, well-formed classes that game.js never imported — the
// game never created a paddle, ball, or a single collider, and nothing
// caught it because each file reads fine in isolation.
test('flags classes that are fully implemented but never imported anywhere', () => {
  const issues = findUnreferencedExportingFiles([
    { path: 'src/objects/Ball.js', content: `export default class Ball {}\n` },
    { path: 'src/objects/Paddle.js', content: `export default class Paddle {}\n` },
    { path: 'src/objects/Brick.js', content: `export default class Brick {}\n` },
    { path: 'src/utils/levelManager.js', content: `export default { loadLevel() {} };\n` },
    {
      path: 'src/game.js',
      content: `import Phaser from 'phaser';\nimport LevelManager from './utils/levelManager.js';\nnew Phaser.Game({});\n`,
    },
  ]);
  assert.equal(issues.length, 3);
  assert.ok(issues.some(i => i.includes('Ball.js')));
  assert.ok(issues.some(i => i.includes('Paddle.js')));
  assert.ok(issues.some(i => i.includes('Brick.js')));
  assert.ok(issues.every(i => !i.includes('levelManager.js') && !i.includes('game.js')));
});

test('does not flag a file that is actually imported elsewhere', () => {
  const issues = findUnreferencedExportingFiles([
    { path: 'src/scenes/Menu.js', content: `export default class Menu {}\n` },
    { path: 'src/game.js', content: `import Menu from './scenes/Menu.js';\n` },
  ]);
  assert.deepEqual(issues, []);
});

test('does not flag a file only referenced from an HTML <script src>', () => {
  const issues = findUnreferencedExportingFiles([
    { path: 'src/game.js', content: `export function start() {}\n` },
    { path: 'index.html', content: `<body><script type="module" src="/src/game.js"></script></body>` },
  ]);
  assert.deepEqual(issues, []);
});

test('does not flag conventional entry points (index/main/app/server/config) even if unreferenced', () => {
  const issues = findUnreferencedExportingFiles([
    { path: 'src/index.js', content: `export function start() {}\n` },
    { path: 'webpack.config.js', content: `module.exports = { entry: './src/index.js' };\n` },
  ]);
  assert.deepEqual(issues, []);
});

test('does not flag test files even if unreferenced', () => {
  const issues = findUnreferencedExportingFiles([
    { path: 'test/unit/foo.test.js', content: `module.exports = { helper() {} };\n` },
  ]);
  assert.deepEqual(issues, []);
});

test('does not flag a file with no export syntax at all', () => {
  const issues = findUnreferencedExportingFiles([
    { path: 'src/sideEffectOnly.js', content: `console.log('just runs, exports nothing');\n` },
  ]);
  assert.deepEqual(issues, []);
});

// Reproduces a real failed run (2026-09-17): the architect/task planner
// assigned `src/assets/spritesheet.png` to a coding task. A text-only LLM
// always writes such a file 0 bytes, the heuristic "file is empty" review
// issue recurred identically across fix attempts, and the run's stuck-loop
// guard correctly gave up — failing the whole build over a plan that was
// never achievable. isBinaryAssetPath() lets task normalization strip these
// paths before a code worker is ever asked to author them.
test('isBinaryAssetPath flags common image/audio/video/font/archive extensions', () => {
  for (const p of [
    'src/assets/spritesheet.png', 'a.JPG', 'icon.ico', 'bg.webp',
    'sound.mp3', 'theme.OGG', 'clip.mp4', 'font.woff2', 'archive.zip', 'doc.pdf',
  ]) {
    assert.equal(isBinaryAssetPath(p), true, `${p} should be flagged as binary`);
  }
});

test('isBinaryAssetPath does not flag text-based files, including SVG', () => {
  for (const p of ['src/game.js', 'index.html', 'levels.json', 'icon.svg', 'README.md', 'src/assets/']) {
    assert.equal(isBinaryAssetPath(p), false, `${p} should not be flagged as binary`);
  }
});

test('toolchainMarkerStack recognizes build manifests that trigger stack-specific checks', () => {
  assert.equal(toolchainMarkerStack('Package.swift'), 'swift');
  assert.equal(toolchainMarkerStack('native/Cargo.toml'), 'rust');
  assert.equal(toolchainMarkerStack('go.mod'), 'go');
  assert.equal(toolchainMarkerStack('pom.xml'), 'java');
  assert.equal(toolchainMarkerStack('build.gradle.kts'), 'java');
  assert.equal(toolchainMarkerStack('App.csproj'), 'dotnet');
  assert.equal(toolchainMarkerStack('package.json'), null);
  assert.equal(toolchainMarkerStack('src/game.swift'), null);
});

test('stackTextMentions matches the requested stack without false positives on common words', () => {
  assert.equal(stackTextMentions('swift', ', SwiftUI, Core Data, | , iOS,'), true);
  assert.equal(stackTextMentions('swift', ', JavaScript, Phaser 3, | , web browser, | build a brick breaker game'), false);
  assert.equal(stackTextMentions('go', ', Go, Gin,'), true);
  assert.equal(stackTextMentions('go', 'let players go to the next level'), false);
  assert.equal(stackTextMentions('java', ', JavaScript, Node.js,'), false);
  assert.equal(stackTextMentions('java', ', Kotlin, Android,'), true);
  assert.equal(stackTextMentions('dotnet', ', C#, ASP.NET Core,'), true);
});
