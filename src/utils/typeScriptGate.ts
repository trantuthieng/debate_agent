import * as fs from 'fs';
import * as path from 'path';

/**
 * Deterministic per-task TypeScript/JavaScript check, run by the reviewer.
 *
 * Real failure mode (benchmark run 7, 2026-09-26): every task passed LLM
 * review, yet `npm run build` then reported 161 TypeScript errors — e.g.
 * main.ts used MenuScene/GameScene without importing them. Nothing compiles
 * code between tasks (dependencies are only installed after coding), so the
 * errors piled up for the final test-fix loop to untangle.
 *
 * This type-checks the workspace's own sources in memory, without
 * node_modules, and reports only diagnostics that are wrong regardless of
 * missing third-party types: syntax errors, undeclared names, and broken
 * relative imports/exports — and only in the files the task changed.
 * JavaScript is checked the same way (checkJs), except that the globals of
 * libraries a page loads from a CDN (e.g. Phaser) are allowed; an unknown
 * remote script turns undeclared-name reports off for JavaScript.
 */

type Ts = typeof import('typescript');

// Undeclared-name codes; other "cannot find" codes (2580–2593: "install type
// definitions for node/jest/…") only mean @types packages are not installed yet.
const UNDECLARED_NAME = new Set([2304, 2552]);
// Relative-module codes: cannot find module / has no exported member / not a module.
const MODULE_CODES = new Set([2305, 2306, 2307, 2614, 2724]);
const AMBIENT_GLOBALS = new Set([
  'describe', 'it', 'test', 'expect', 'jest', 'vi', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll',
  'process', 'require', 'module', 'exports', '__dirname', '__filename', 'global', 'Buffer',
]);
const MAX_ISSUES = 15;
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const JS_SOURCE = /\.(js|jsx|mjs|cjs)$/;
const MAX_SOURCE_BYTES = 300_000;

function loadTypeScript(projectRoot: string): Ts | null {
  for (const base of [projectRoot, __dirname]) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require(require.resolve('typescript', { paths: [base] })) as Ts;
    } catch { /* try the next location */ }
  }
  return null;
}

function listSources(root: string, dir = '', out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || ['node_modules', 'dist', 'build', 'coverage'].includes(entry.name)) { continue; }
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { listSources(root, rel, out); continue; }
    if (!SOURCE.test(entry.name) || entry.name.endsWith('.d.ts') || entry.name.endsWith('.min.js')) { continue; }
    try { if (fs.statSync(path.join(root, rel)).size > MAX_SOURCE_BYTES) { continue; } } catch { continue; }
    out.push(rel);
  }
  return out;
}

/** Globals that well-known browser libraries define when loaded by a classic <script>. */
const LIBRARY_GLOBALS: Array<[RegExp, string[]]> = [
  [/phaser/i, ['Phaser']],
  [/three(\.module)?(\.min)?\.js|\/three@|\/three\//i, ['THREE']],
  [/pixi/i, ['PIXI']],
  [/matter(-js)?/i, ['Matter']],
  [/howler/i, ['Howl', 'Howler']],
  [/gsap/i, ['gsap', 'TweenMax', 'TweenLite', 'TimelineMax', 'ScrollTrigger']],
  [/jquery/i, ['$', 'jQuery']],
  [/lodash|underscore/i, ['_']],
  [/chart(\.umd)?(\.min)?\.js|chart\.js/i, ['Chart']],
  [/\bd3(\.v\d)?(\.min)?\.js|\/d3@|\/d3\//i, ['d3']],
  [/react-dom/i, ['ReactDOM']],
  [/\breact(\.production|\.development)?(\.min)?\.js|\/react@|\/react\/umd/i, ['React']],
  [/\bvue(\.global)?(\.prod)?(\.min)?\.js|\/vue@/i, ['Vue']],
  [/tone(\.min)?\.js|\/tone@/i, ['Tone']],
  [/kaboom/i, ['kaboom']],
  [/babylon/i, ['BABYLON']],
];

/**
 * Globals provided by the scripts project pages load from a CDN or as
 * vendored bundles (*.min.js, node_modules/…), which the checker cannot see.
 * Returns the set of those globals, empty when there are no such scripts, or
 * null when some script is not a known library (then any undeclared name may
 * be one of its globals). Audit D05: this used to switch undeclared-name
 * checks off entirely whenever any CDN script was present, hiding typos.
 */
function remoteScriptGlobals(root: string): Set<string> | null {
  const globals = new Set<string>();
  let unknown = false;
  const visit = (dir: string, depth: number) => {
    if (depth > 4 || unknown) { return; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || ['node_modules', 'dist', 'build', 'coverage'].includes(entry.name)) { continue; }
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { visit(rel, depth + 1); continue; }
      if (!/\.html?$/i.test(entry.name)) { continue; }
      let html = '';
      try { html = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
      for (const match of html.matchAll(/<script[^>]+src\s*=\s*["']([^"']+)["']/gi)) {
        const src = match[1];
        if (!/^(https?:)?\/\//i.test(src) && !/\.min\.js|node_modules\//i.test(src)) { continue; }
        const known = LIBRARY_GLOBALS.find(([pattern]) => pattern.test(src));
        if (!known) { unknown = true; return; }
        known[1].forEach(name => globals.add(name));
      }
    }
  };
  visit('', 0);
  return unknown ? null : globals;
}

/**
 * Outcome of the gate. `unavailable` (no TypeScript compiler could be loaded,
 * e.g. an installed VSIX without it) and `skipped` (project too large) mean
 * nothing was checked; they must never be read as a pass (audit C03).
 */
export interface TypeScriptGateResult {
  status: 'passed' | 'failed' | 'unavailable' | 'skipped' | 'not-applicable';
  issues: string[];
  reason?: string;
}

const MAX_PROJECT_SOURCES = 400;

export function findTypeScriptTaskIssues(projectRoot: string, changedFiles: string[]): string[] {
  return checkTypeScriptTask(projectRoot, changedFiles).issues;
}

export function checkTypeScriptTask(projectRoot: string, changedFiles: string[], loader: (root: string) => Ts | null = loadTypeScript): TypeScriptGateResult {
  const changed = new Set(changedFiles.filter(file => SOURCE.test(file) && !file.endsWith('.d.ts') && !file.endsWith('.min.js')));
  if (changed.size === 0) { return { status: 'not-applicable', issues: [] }; }
  const ts = loader(projectRoot);
  if (!ts) {
    return { status: 'unavailable', issues: [],
      reason: 'No TypeScript compiler could be loaded (neither in the project nor bundled with the extension), so JS/TS files were not type-checked.' };
  }

  const sources = listSources(projectRoot);
  if (sources.length === 0) { return { status: 'not-applicable', issues: [] }; }
  if (sources.length > MAX_PROJECT_SOURCES) {
    return { status: 'skipped', issues: [],
      reason: `The project has ${sources.length} source files (limit ${MAX_PROJECT_SOURCES}), so the per-task type check was skipped.` };
  }
  const options: import('typescript').CompilerOptions = {
    noEmit: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    allowJs: true,
    checkJs: true,
    resolveJsonModule: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    skipLibCheck: true,
    strict: false,
    types: [],
    lib: ['lib.es2020.d.ts', 'lib.dom.d.ts'],
  };
  const program = ts.createProgram(sources.map(file => path.join(projectRoot, file)), options);

  const libraryGlobals = [...changed].some(file => JS_SOURCE.test(file)) ? remoteScriptGlobals(projectRoot) : new Set<string>();
  const issues: string[] = [];
  for (const file of changed) {
    const isJs = JS_SOURCE.test(file);
    const sourceFile = program.getSourceFile(path.join(projectRoot, file));
    if (!sourceFile) { continue; }
    const diagnostics = [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)];
    for (const diagnostic of diagnostics) {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
      const syntax = diagnostic.code >= 1000 && diagnostic.code < 2000;
      const name = /'([^']+)'/.exec(message)?.[1] ?? '';
      const undeclared = UNDECLARED_NAME.has(diagnostic.code)
        && !(isJs && (libraryGlobals === null || libraryGlobals.has(name)))
        && !AMBIENT_GLOBALS.has(name);
      const relativeModule = MODULE_CODES.has(diagnostic.code) && /['"]\.\.?\//.test(message);
      if (!syntax && !undeclared && !relativeModule) { continue; }
      const line = diagnostic.start !== undefined
        ? sourceFile.getLineAndCharacterOfPosition(diagnostic.start).line + 1
        : 0;
      issues.push(`[${isJs ? 'javascript' : 'typescript'}] ${file}:${line} TS${diagnostic.code}: ${message}`);
      if (issues.length >= MAX_ISSUES) { return { status: 'failed', issues }; }
    }
  }
  return { status: issues.length > 0 ? 'failed' : 'passed', issues };
}
