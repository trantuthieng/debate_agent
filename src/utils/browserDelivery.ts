import * as fs from 'fs';
import * as path from 'path';

/**
 * Deterministic check that a web page can actually load its code in a browser.
 *
 * Real failure mode (benchmark runs 6 and 8, 2026-09-26): index.html loaded
 * main.js with a classic <script>, while main.js did `import Phaser from
 * 'phaser'` with no bundler or import map. Every task passed review; the page
 * only failed at the final browser smoke test ("Cannot use import statement
 * outside a module"), whose message names no file, and 8 test-fix attempts
 * never found the cause.
 *
 * Checks, for every local <script src> of every project HTML page:
 * - a script using import/export must be loaded with type="module";
 * - without a bundler, a module graph must not import bare package names
 *   ('phaser') that no import map resolves, and the page must not load .ts/.tsx.
 */

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'out']);
const BUNDLERS = ['vite', 'webpack', 'parcel', 'esbuild', 'rollup', 'snowpack', '@vitejs/plugin-react', 'react-scripts', 'next'];

export interface BrowserDeliveryIssue {
  message: string;
  /** Project-relative files involved (the page and/or the script). */
  files: string[];
}

function walk(root: string, dir = '', out: string[] = [], depth = 0): string[] {
  if (depth > 6) { return out; }
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) { continue; }
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { walk(root, rel, out, depth + 1); }
    else if (/\.html?$/i.test(entry.name)) { out.push(rel); }
  }
  return out;
}

function read(root: string, rel: string): string | null {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; }
}

function usesBundler(root: string): boolean {
  const raw = read(root, 'package.json');
  if (!raw) { return false; }
  try {
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const scripts = Object.values(pkg.scripts ?? {}).join('\n');
    return BUNDLERS.some(name => name in deps || new RegExp(`\\b${name.replace(/[/@]/g, '\\$&')}\\b`).test(scripts));
  } catch { return false; }
}

function importMapKeys(html: string): string[] {
  const keys: string[] = [];
  for (const match of html.matchAll(/<script[^>]*type\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { keys.push(...Object.keys((JSON.parse(match[1]) as { imports?: Record<string, string> }).imports ?? {})); } catch { /* invalid map resolves nothing */ }
  }
  return keys;
}

const ESM_SYNTAX = /^\s*(import\s*[\w{*'"]|export\s)/m;
const SPECIFIERS = /(?:^|[;\s])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|[;\s])import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm;

function specifiers(code: string): string[] {
  const found: string[] = [];
  for (const match of code.matchAll(SPECIFIERS)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec) { found.push(spec); }
  }
  return found;
}

const isBare = (spec: string) => !/^(\.{1,2}\/|\/|https?:|data:|blob:)/.test(spec);

function resolveLocal(root: string, fromFile: string, spec: string): string | null {
  const base = spec.startsWith('/') ? spec.slice(1) : path.posix.join(path.posix.dirname(fromFile), spec);
  const normalized = path.posix.normalize(base);
  if (normalized.startsWith('..')) { return null; }
  for (const candidate of [normalized, `${normalized}.js`, `${normalized}.mjs`, `${normalized}/index.js`]) {
    try { if (fs.statSync(path.join(root, candidate)).isFile()) { return candidate; } } catch { /* try next */ }
  }
  return null;
}

export function findBrowserDeliveryIssues(root: string, changedFiles?: string[]): BrowserDeliveryIssue[] {
  const bundled = usesBundler(root);
  const issues: BrowserDeliveryIssue[] = [];
  const seen = new Set<string>();
  const add = (issue: BrowserDeliveryIssue) => {
    if (seen.has(issue.message)) { return; }
    seen.add(issue.message);
    issues.push(issue);
  };

  for (const page of walk(root)) {
    const html = read(root, page);
    if (!html) { continue; }
    const mapped = importMapKeys(html);
    const resolvedByMap = (spec: string) => mapped.some(key => key === spec || (key.endsWith('/') && spec.startsWith(key)));

    for (const tag of html.matchAll(/<script\b([^>]*)>/gi)) {
      const attrs = tag[1];
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
      if (!src || /^(https?:)?\/\//i.test(src)) { continue; }
      const isModule = /\btype\s*=\s*["']module["']/i.test(attrs);
      const entry = resolveLocal(root, page, src.split(/[?#]/)[0]) ?? (src.startsWith('/') ? null : resolveLocal(root, '', src.split(/[?#]/)[0]));
      if (!entry) { continue; } // missing files are the HTTP smoke check's job

      if (!bundled && /\.tsx?$/.test(entry)) {
        add({ files: [page, entry],
          message: `${page} loads ${entry} directly, but browsers cannot run TypeScript without a build step. Add a bundler (e.g. Vite with "dev"/"build" scripts) or load compiled JavaScript.` });
        continue;
      }
      const code = read(root, entry) ?? '';
      if (!isModule && ESM_SYNTAX.test(code)) {
        add({ files: [page, entry],
          message: `${page} loads ${entry} with a classic <script>, but ${entry} uses import/export, so the browser throws "Cannot use import statement outside a module". Add type="module" to that <script> tag.` });
      }
      if (bundled || (!isModule && !ESM_SYNTAX.test(code))) { continue; }

      // Follow the module graph through relative imports.
      const queue = [entry];
      const visited = new Set<string>();
      while (queue.length > 0 && visited.size < 50) {
        const file = queue.shift()!;
        if (visited.has(file)) { continue; }
        visited.add(file);
        for (const spec of specifiers(read(root, file) ?? '')) {
          if (isBare(spec)) {
            if (!resolvedByMap(spec)) {
              add({ files: [page, file],
                message: `${file} imports '${spec}', but ${page} runs it in the browser without a bundler or import map, so the browser cannot resolve '${spec}'. Load it from a CDN (a <script src="https://…"> global, or an <script type="importmap"> entry), or build with a bundler such as Vite.` });
            }
          } else if (!/^(https?:|data:|blob:)/.test(spec)) {
            const next = resolveLocal(root, file, spec);
            if (next && /\.(m?js|jsx)$/.test(next)) { queue.push(next); }
          }
        }
      }
    }
  }

  if (!changedFiles) { return issues; }
  const changed = new Set(changedFiles);
  return issues.filter(issue => issue.files.some(file => changed.has(file)));
}
