import * as fs from 'fs';
import { builtinModules } from 'module';
import * as path from 'path';

/**
 * Deterministic checks for test-writing tasks.
 *
 * Real failure mode (benchmark run 8, 2026-09-26): in a JavaScript project the
 * test task wrote tests/game.test.ts (TypeScript, no tsconfig), imported
 * 'chai' that package.json never declared, and left package.json's test script
 * as `echo 'No tests yet.'` — so the tests could never run, and nothing flagged
 * it until the end of the run.
 */

export const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$/i;
const JS_TS_FILE = /\.(m?[jt]sx?|cjs)$/;
const BUILTINS = new Set(builtinModules);

/** A script made only of echo / exit 0 / true segments runs nothing. */
export function isPlaceholderScript(script: string): boolean {
  const segments = script.split(/&&|\|\||;/).map(part => part.trim()).filter(Boolean);
  return segments.length > 0 && segments.every(part => /^(echo\b.*|exit\s+0|true|:)$/i.test(part));
}

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function readPackageJson(root: string): PackageJson | null {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as PackageJson; } catch { return null; }
}

function read(root: string, file: string): string {
  try { return fs.readFileSync(path.join(root, file), 'utf8'); } catch { return ''; }
}

function importMapKeys(root: string): string[] {
  const keys: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 4) { return; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') { continue; }
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { visit(rel, depth + 1); continue; }
      if (!/\.html?$/i.test(entry.name)) { continue; }
      for (const match of read(root, rel).matchAll(/<script[^>]*type\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi)) {
        try { keys.push(...Object.keys((JSON.parse(match[1]) as { imports?: Record<string, string> }).imports ?? {})); } catch { /* ignore */ }
      }
    }
  };
  visit('', 0);
  return keys;
}

/** Package name of a bare specifier ('@scope/pkg/sub' → '@scope/pkg'), or null for non-packages. */
function packageName(spec: string): string | null {
  if (/^(\.{1,2}\/|\/|[a-z]+:|[@~#]\/|~|#)/i.test(spec)) { return null; } // relative, URL, node:, aliases
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function importedSpecifiers(code: string): string[] {
  const specs: string[] = [];
  const pattern = /(?:^|[;\s])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|[;\s])import\s*['"]([^'"]+)['"]|\b(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/gm;
  for (const match of code.matchAll(pattern)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec) { specs.push(spec); }
  }
  return specs;
}

/** Bare package imports in the changed files that package.json does not declare. */
export function findUndeclaredPackageImports(root: string, changedFiles: string[]): string[] {
  const pkg = readPackageJson(root);
  if (!pkg) { return []; }
  const declared = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies }));
  const mapped = importMapKeys(root);
  const issues: string[] = [];
  for (const file of changedFiles.filter(f => JS_TS_FILE.test(f) && !/(^|\/)node_modules\//.test(f))) {
    for (const spec of new Set(importedSpecifiers(read(root, file)))) {
      const name = packageName(spec);
      if (!name || BUILTINS.has(name) || declared.has(name)) { continue; }
      if (mapped.some(key => key === spec || (key.endsWith('/') && spec.startsWith(key)))) { continue; }
      issues.push(`[deps] ${file} imports '${spec}', but package.json does not declare "${name}". Add it to dependencies/devDependencies, or use a package the project already declares.`);
    }
  }
  return issues;
}

/** New TypeScript files in a project that has no TypeScript setup. */
export function findLanguageMismatch(root: string, changedFiles: string[], allSourceFiles: string[]): string[] {
  const changedTs = changedFiles.filter(file => /\.tsx?$/.test(file) && !file.endsWith('.d.ts'));
  if (changedTs.length === 0 || fs.existsSync(path.join(root, 'tsconfig.json'))) { return []; }
  const otherTs = allSourceFiles.filter(file => /\.tsx?$/.test(file) && !file.endsWith('.d.ts')
    && !/(^|\/)(node_modules|\.agent-workspace)\//.test(file) && !changedTs.includes(file));
  if (otherTs.length > 0) { return []; }
  return changedTs.map(file =>
    `[language] ${file} is TypeScript, but this is a JavaScript project (no tsconfig.json and no other TypeScript files). Write it as a .js file in the project's language.`);
}

/** When a task writes JS/TS tests, package.json must have a test script that really runs them. */
export function findTestScriptIssues(root: string, changedFiles: string[]): string[] {
  if (!changedFiles.some(file => TEST_FILE.test(file) && JS_TS_FILE.test(file))) { return []; }
  const pkg = readPackageJson(root);
  if (!pkg) { return []; }
  const script = pkg.scripts?.test;
  if (!script) {
    return ['[tests] package.json has no "test" script, so the new tests never run. Add a test runner (e.g. vitest or jest) to devDependencies and a "test" script that runs these files.'];
  }
  if (isPlaceholderScript(script)) {
    return [`[tests] package.json "test" script is a placeholder ("${script}"), so the new tests never run. Replace it with a real runner command (e.g. "vitest run" or "jest") and declare that runner in devDependencies.`];
  }
  return [];
}
