import * as fs from 'fs';
import * as path from 'path';

/**
 * Deterministic checks for a product that passes its tests but does nothing
 * (benchmark run 11, 2026-09-27): src/index.js was an empty game loop
 * ("// Update game state logic here") that imported none of the game
 * modules, and every key handler in Input.js was a comment ("// Move paddle
 * left"). Paddle/Ball/Level were real and unit-tested directly, so 25/25
 * tests passed and the pipeline delivered a game that could not be started.
 */

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'out', '.git']);
const SOURCE = /\.(m?[jt]sx?|cjs)$/;
const TEST = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)tests?\.[cm]?[jt]sx?$/i;
const CONFIG = /(^|\/)[^/]*\.config\.[cm]?[jt]s$|(^|\/)(\.eslintrc|babel\.config|jest\.setup)[^/]*$/;

function walk(root: string, dir = '', out: string[] = [], depth = 0): string[] {
  if (depth > 8) { return out; }
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) { continue; }
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { walk(root, rel, out, depth + 1); } else { out.push(rel); }
  }
  return out;
}

function read(root: string, rel: string): string {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; }
}

const SPECIFIER = /(?:\bimport\s*(?:[^'"()]*?\bfrom\s*)?|\bexport\s+[^'"]*?\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bnew\s+(?:Shared)?Worker\s*\(\s*)['"]([^'"]+)['"]/g;
const EXTENSIONS = ['', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '/index.js', '/index.ts'];

function resolve(files: Set<string>, from: string, spec: string): string | null {
  if (!/^(\.{1,2}\/|\/)/.test(spec)) { return null; }
  const clean = spec.split(/[?#]/)[0];
  const base = clean.startsWith('/') ? clean.slice(1) : path.posix.join(path.posix.dirname(from), clean);
  const normalized = path.posix.normalize(base);
  const noExt = normalized.replace(/\.(m?js|cjs|jsx)$/, '');
  for (const candidate of [...EXTENSIONS.map(e => normalized + e), ...EXTENSIONS.map(e => noExt + e)]) {
    if (files.has(candidate)) { return candidate; }
  }
  return null;
}

/**
 * Source modules no HTML page ever loads. Walks every page's local
 * <script src> and inline module imports through relative imports (bundler
 * resolution: extensionless and .js→.ts allowed). Tests, configs and files
 * run by package.json scripts (servers, tools) are not expected to be
 * reachable. Returns [] when the project has no HTML page (not a web app).
 */
export function findUnwiredModules(root: string): { entries: string[]; unwired: string[] } {
  const all = walk(root);
  const files = new Set(all);
  const pages = all.filter(file => /\.html?$/i.test(file) && !TEST.test(file));
  if (pages.length === 0) { return { entries: [], unwired: [] }; }

  const reachable = new Set<string>();
  const queue: string[] = [];
  const visitCode = (from: string, code: string) => {
    for (const match of code.matchAll(SPECIFIER)) {
      const target = resolve(files, from, match[1]);
      if (target && !reachable.has(target)) { reachable.add(target); queue.push(target); }
    }
  };
  for (const page of pages) {
    const html = read(root, page);
    for (const tag of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag[1])?.[1];
      if (src) {
        if (/^(https?:)?\/\//i.test(src)) { continue; }
        const target = resolve(files, page, src.startsWith('/') ? src : `./${src.replace(/^\.\//, '')}`);
        if (target && !reachable.has(target)) { reachable.add(target); queue.push(target); }
      } else {
        visitCode(page, tag[2]);
      }
    }
  }
  // Files package.json scripts run directly (node server.js, tsx tools/x.ts) and what they import.
  try {
    const scripts = Object.values((JSON.parse(read(root, 'package.json')) as { scripts?: Record<string, string> }).scripts ?? {}).join('\n');
    for (const match of scripts.matchAll(/(?:^|[\s;&|])(?:node|nodemon|tsx|ts-node|bun)\s+(?:--?[\w-]+(?:=\S+)?\s+)*([\w./-]+\.(?:m?[jt]s|cjs))/g)) {
      const target = resolve(files, '', `./${match[1].replace(/^\.\//, '')}`);
      if (target && !reachable.has(target)) { reachable.add(target); queue.push(target); }
    }
  } catch { /* no manifest */ }
  while (queue.length > 0) {
    const file = queue.shift()!;
    visitCode(file, read(root, file));
  }

  const unwired = all.filter(file => SOURCE.test(file) && !file.endsWith('.d.ts') && !TEST.test(file) && !CONFIG.test(file)
    && !/\.min\.js$/.test(file) && !reachable.has(file));
  return { entries: pages, unwired };
}

/** Comments that say the empty body is on purpose. */
const DELIBERATE = /no[- ]?op|nothing to do|intentional|on purpose|ignore|swallow|no cleanup|not needed|best[- ]effort|already|drain|fall ?through|handled (?:by|in|elsewhere)|unused|(?:load|preload)(?:ing)? (?:the )?assets|no (?:external )?(?:assets|image|files)/i;

/** Removes string/template/regex-free comments only enough to see whether a block has code. */
function onlyComments(block: string): boolean {
  const withoutComments = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return withoutComments.trim() === '' && /\/\/|\/\*/.test(block);
}

/**
 * Function bodies and switch cases that contain only a comment describing
 * what should happen ("// Move paddle left"), i.e. an implementation that
 * was never written. An empty body without a comment ({}), a comment next to
 * real code, and test files are not reported.
 */
export function findCommentOnlyImplementations(file: string, code: string): string[] {
  if (TEST.test(file)) { return []; }
  const issues: string[] = [];
  const lineOf = (index: number) => code.slice(0, index).split('\n').length;
  // Function/method/arrow bodies: "...) {" or "=> {" followed by a block with no nested braces.
  for (const match of code.matchAll(/(\)\s*(?::\s*[\w<>[\]|, ]+\s*)?|=>\s*)\{([^{}]*)\}/g)) {
    const before = code.slice(Math.max(0, match.index! - 60), match.index!);
    if (/\bcatch\s*\([^)]*$/.test(before)) { continue; } // swallowing an error is a decision, not a stub
    if (onlyComments(match[2]) && !DELIBERATE.test(match[2])) {
      const comment = /\/\/\s*([^\n]*)|\/\*\s*([\s\S]*?)\*\//.exec(match[2]);
      issues.push(`${file}:${lineOf(match.index!)} has a function body that is only a comment ("${(comment?.[1] ?? comment?.[2] ?? '').trim().slice(0, 60)}"), so it does nothing.`);
    }
  }
  // switch cases whose only content is a comment (optionally followed by break).
  for (const match of code.matchAll(/\bcase\s+[^:\n]+:((?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/))+)\s*(?:break\s*;)?(?=\s*(?:case\b|default\b|\}))/g)) {
    if (DELIBERATE.test(match[1])) { continue; }
    const comment = /\/\/\s*([^\n]*)/.exec(match[1]);
    issues.push(`${file}:${lineOf(match.index!)} has a switch case that is only a comment ("${(comment?.[1] ?? '').trim().slice(0, 60)}"), so that input does nothing.`);
  }
  return [...new Set(issues)].slice(0, 20);
}

/** findCommentOnlyImplementations over every non-test source file of the project. */
export function findProjectCommentOnlyImplementations(root: string): string[] {
  return walk(root).filter(file => SOURCE.test(file) && !file.endsWith('.d.ts') && !TEST.test(file) && !CONFIG.test(file) && !/\.min\.js$/.test(file))
    .flatMap(file => findCommentOnlyImplementations(file, read(root, file))).slice(0, 30);
}
