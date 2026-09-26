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
