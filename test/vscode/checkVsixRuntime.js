const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Inspect the actual archive, not the repository's compiler or build tree.
// Uses the unzip executable supplied on the macOS/Linux release machines.
const manifest = require('../../package.json');
const vsixPath = path.resolve(process.argv[2] || path.join(__dirname, '../..', 'dist', `${manifest.name}-${manifest.version}.vsix`));
assert.ok(fs.existsSync(vsixPath), `VSIX does not exist: ${vsixPath}`);
const isolated = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lmac-packaged-runtime-')));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) { throw result.error; }
  assert.equal(result.status, 0, `${command} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

const worker = String.raw`
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const { createRequire } = require('node:module');
  const [extension, project, missingCompiler] = process.argv.slice(1);
  const projectRequire = createRequire(path.join(project, 'package.json'));
  assert.throws(() => projectRequire.resolve('typescript'), { code: 'MODULE_NOT_FOUND' },
    'The user project must not see TypeScript from itself or an ancestor');
  let ancestor = project;
  for (;;) {
    assert.equal(fs.existsSync(path.join(ancestor, 'node_modules')), false,
      'Isolation requires no node_modules in the user project or its ancestors: ' + ancestor);
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const gate = require(path.join(extension, 'out/utils/typeScriptGate.js'));
  fs.writeFileSync(path.join(project, 'main.js'), 'document.body.textContent = String(missingPackagedValue);\n');
  const failure = gate.checkTypeScriptTask(project, ['main.js']);
  if (missingCompiler === 'missing') {
    assert.equal(failure.status, 'unavailable', JSON.stringify(failure));
    console.log(JSON.stringify({ compilerMissingStatus: failure.status }));
    process.exit(0);
  }
  const extensionRequire = createRequire(path.join(extension, 'package.json'));
  const compilerPath = extensionRequire.resolve('typescript');
  assert.ok(compilerPath.startsWith(path.join(extension, 'node_modules/typescript') + path.sep), compilerPath);
  const ts = extensionRequire('typescript');
  assert.equal(failure.status, 'failed', JSON.stringify(failure));
  assert.ok(failure.issues.some(issue => /TS2304.*missingPackagedValue/.test(issue)), JSON.stringify(failure));
  fs.writeFileSync(path.join(project, 'main.js'), 'Promise.resolve(new Map()).then(value => { document.body.textContent = String(value.size); });\n');
  const success = gate.checkTypeScriptTask(project, ['main.js']);
  assert.equal(success.status, 'passed', JSON.stringify(success));
  const program = ts.createProgram([path.join(project, 'main.js')], {
    noEmit: true, allowJs: true, checkJs: true, types: [], target: ts.ScriptTarget.ES2020,
    lib: ['lib.es2020.d.ts', 'lib.dom.d.ts'],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, ' ')), [],
    'Bundled DOM/ES2020 declarations and their transitive references must all load');
  assert.equal(typeof extensionRequire('ws').WebSocketServer, 'function');
  console.log(JSON.stringify({ compilerVersion: ts.version, diagnostic: failure.issues[0], validJavaScript: success.status, wsLoaded: true }));
`;

try {
  const entries = run('unzip', ['-Z1', vsixPath]).split(/\r?\n/);
  for (const required of ['out/utils/typeScriptGate.js', 'node_modules/typescript/lib/typescript.js',
    'node_modules/typescript/lib/lib.es2020.d.ts', 'node_modules/typescript/lib/lib.dom.d.ts',
    'node_modules/typescript/LICENSE.txt', 'node_modules/ws/index.js']) {
    assert.ok(entries.includes(`extension/${required}`), `Missing packaged runtime file: ${required}`);
  }
  assert.ok(!entries.some(entry => /(?:^|\/)\.env(?:\.|$)|^extension\/(?:talking\.md|PROJECT_LOG\.md|benchmarks\/)/.test(entry)),
    'VSIX must not contain local environment files or internal run history');
  run('unzip', ['-q', vsixPath, '-d', isolated]);
  const extension = path.join(isolated, 'extension');
  const project = path.join(isolated, 'user-project');
  fs.mkdirSync(project);
  const childOptions = { cwd: project, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '' } };
  console.log(run(process.execPath, ['--no-global-search-paths', '-e', worker, extension, project, 'present'], childOptions));
  fs.renameSync(path.join(extension, 'node_modules/typescript'), path.join(isolated, 'removed-compiler'));
  console.log(run(process.execPath, ['--no-global-search-paths', '-e', worker, extension, project, 'missing'], childOptions));
  console.log(`Packaged runtime check passed: ${fs.statSync(vsixPath).size} bytes, ${entries.length} archive entries.`);
} finally {
  fs.rmSync(isolated, { recursive: true, force: true });
}
