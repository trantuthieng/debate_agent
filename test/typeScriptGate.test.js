const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { findTypeScriptTaskIssues } = require('../out/utils/typeScriptGate');

function project(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

test('flags a name used without import and a wrong named import from a relative module', t => {
  const root = project(t, {
    'src/scenes/MenuScene.ts': 'export default class MenuScene {}\n',
    'src/main.ts': "import Phaser from 'phaser';\nconst scenes = [MenuScene];\nnew Phaser.Game({ scene: scenes });\n",
    'src/tests/menu.test.ts': "import { MenuScene } from '../scenes/MenuScene';\ndescribe('menu', () => { it('exists', () => { expect(MenuScene).toBeDefined(); }); });\n",
  });

  const issues = findTypeScriptTaskIssues(root, ['src/main.ts', 'src/tests/menu.test.ts']);

  assert.equal(issues.length, 2, issues.join('\n'));
  assert.match(issues[0], /src\/main\.ts:2 TS2304: Cannot find name 'MenuScene'/);
  assert.match(issues[1], /src\/tests\/menu\.test\.ts:1 TS2614/);
});

test('missing third-party packages, test globals and errors in unchanged files are not reported', t => {
  const root = project(t, {
    'src/game.ts': "import Phaser from 'phaser';\nexport class Game extends Phaser.Scene { create() { this.add.text(0, 0, 'hi'); } }\n",
    'src/broken.ts': 'const x = undefinedThing;\n',
    'src/game.test.ts': "import { Game } from './game';\ndescribe('g', () => { it('ok', () => { expect(new Game()).toBeTruthy(); }); });\n",
  });

  assert.deepEqual(findTypeScriptTaskIssues(root, ['src/game.ts', 'src/game.test.ts']), []);
  assert.deepEqual(findTypeScriptTaskIssues(root, ['README.md']), []);
});

test('JavaScript: broken relative imports and undeclared names are reported', t => {
  const root = project(t, {
    'index.html': '<script type="module" src="src/main.js"></script>',
    'src/levels.js': 'export const levels = [1, 2];\n',
    'src/main.js': "import { levels } from './levels.js';\nimport { missing } from './levels.js';\nimport extra from './level6.json';\nconsole.log(levels, missing, extra, scoreBoard);\n",
  });

  const issues = findTypeScriptTaskIssues(root, ['src/main.js']);

  assert.ok(issues.every(issue => issue.startsWith('[javascript] src/main.js')), issues.join('\n'));
  assert.ok(issues.some(issue => /TS2305|TS2614/.test(issue) && /missing/.test(issue)));
  assert.ok(issues.some(issue => /TS2307/.test(issue) && /level6\.json/.test(issue)));
  assert.ok(issues.some(issue => /scoreBoard/.test(issue)));
});

test('JavaScript: globals from CDN or vendored scripts are not reported as undeclared', t => {
  for (const src of ['https://cdn.jsdelivr.net/npm/phaser@3/dist/phaser.min.js', 'lib/phaser.min.js']) {
    const root = project(t, {
      'index.html': `<script src="${src}"></script><script src="game.js"></script>`,
      'game.js': 'const game = new Phaser.Game({});\nconsole.log(game);\n',
    });
    assert.deepEqual(findTypeScriptTaskIssues(root, ['game.js']), [], src);
  }
});

test('audit C03: without a loadable compiler the gate reports unavailable, never a silent pass', t => {
  const { checkTypeScriptTask } = require('../out/utils/typeScriptGate');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-gate-c03-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.js'), 'const x = totallyMissingName;\n');

  const missing = checkTypeScriptTask(root, ['main.js'], () => null);
  assert.equal(missing.status, 'unavailable');
  assert.deepEqual(missing.issues, []);
  assert.match(missing.reason, /not type-checked/);

  const real = checkTypeScriptTask(root, ['main.js']);
  assert.equal(real.status, 'failed');
  assert.match(real.issues[0], /totallyMissingName/);
  assert.equal(checkTypeScriptTask(root, ['README.md']).status, 'not-applicable');
});

test('audit C03: a project over the source limit reports skipped', t => {
  const { checkTypeScriptTask } = require('../out/utils/typeScriptGate');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-gate-c03-big-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let i = 0; i < 401; i++) { fs.writeFileSync(path.join(root, `m${i}.js`), `export const v${i} = ${i};\n`); }
  const result = checkTypeScriptTask(root, ['m0.js']);
  assert.equal(result.status, 'skipped');
  assert.match(result.reason, /401 source files/);
});

test('audit D05: with a CDN Phaser, its global is allowed but a typo is still reported; an unknown CDN script stays permissive', t => {
  const root = project(t, {
    'index.html': '<script src="https://cdn.jsdelivr.net/npm/phaser@3/dist/phaser.min.js"></script><script src="game.js"></script>',
    'game.js': 'const game = new Phaser.Game({});\nconsole.log(game, scoreBoardd);\n',
  });
  const issues = findTypeScriptTaskIssues(root, ['game.js']);
  assert.equal(issues.length, 1, issues.join('\n'));
  assert.match(issues[0], /scoreBoardd/);

  const unknown = project(t, {
    'index.html': '<script src="https://example.com/some-engine.js"></script><script src="game.js"></script>',
    'game.js': 'Engine.start(); console.log(anythingGoes);\n',
  });
  assert.deepEqual(findTypeScriptTaskIssues(unknown, ['game.js']), []);
});
