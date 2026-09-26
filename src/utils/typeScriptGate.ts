import * as fs from 'fs';
import * as path from 'path';

/**
 * Deterministic per-task TypeScript check, run by the reviewer.
 *
 * Real failure mode (benchmark run 7, 2026-09-26): every task passed LLM
 * review, yet `npm run build` then reported 161 TypeScript errors — e.g.
 * main.ts used MenuScene/GameScene without importing them. Nothing compiles
 * code between tasks (dependencies are only installed after coding), so the
 * errors piled up for the final test-fix loop to untangle.
 *
 * This type-checks the workspace's own .ts/.tsx sources in memory, without
 * node_modules, and reports only diagnostics that are wrong regardless of
 * missing third-party types: syntax errors, undeclared names, and broken
 * relative imports/exports — and only in the files the task changed.
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
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') { continue; }
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { listSources(root, rel, out); }
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) { out.push(rel); }
  }
  return out;
}

export function findTypeScriptTaskIssues(projectRoot: string, changedFiles: string[]): string[] {
  const changed = new Set(changedFiles.filter(file => /\.(ts|tsx)$/.test(file) && !file.endsWith('.d.ts')));
  if (changed.size === 0) { return []; }
  const ts = loadTypeScript(projectRoot);
  if (!ts) { return []; }

  const sources = listSources(projectRoot);
  if (sources.length === 0 || sources.length > 400) { return []; }
  const options: import('typescript').CompilerOptions = {
    noEmit: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    allowJs: true,
    resolveJsonModule: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    skipLibCheck: true,
    strict: false,
    types: [],
    lib: ['lib.es2020.d.ts', 'lib.dom.d.ts'],
  };
  const program = ts.createProgram(sources.map(file => path.join(projectRoot, file)), options);

  const issues: string[] = [];
  for (const file of changed) {
    const sourceFile = program.getSourceFile(path.join(projectRoot, file));
    if (!sourceFile) { continue; }
    const diagnostics = [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)];
    for (const diagnostic of diagnostics) {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
      const syntax = diagnostic.code >= 1000 && diagnostic.code < 2000;
      const undeclared = UNDECLARED_NAME.has(diagnostic.code)
        && !AMBIENT_GLOBALS.has(/'([^']+)'/.exec(message)?.[1] ?? '');
      const relativeModule = MODULE_CODES.has(diagnostic.code) && /['"]\.\.?\//.test(message);
      if (!syntax && !undeclared && !relativeModule) { continue; }
      const line = diagnostic.start !== undefined
        ? sourceFile.getLineAndCharacterOfPosition(diagnostic.start).line + 1
        : 0;
      issues.push(`[typescript] ${file}:${line} TS${diagnostic.code}: ${message}`);
      if (issues.length >= MAX_ISSUES) { return issues; }
    }
  }
  return issues;
}
