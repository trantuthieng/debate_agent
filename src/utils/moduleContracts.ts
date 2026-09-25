import * as path from 'path';

export interface ContractCheckFile {
  path: string;
  content: string;
}

/**
 * Deterministic cross-check for a real failure mode seen in practice: a
 * generated CommonJS file destructures names from `require('./relative')`
 * that the target module never exports (or the module is missing entirely).
 * Both the LLM reviewer and the LLM quality auditor have independently
 * approved code with this defect (they read the two files in isolation and
 * do not always notice the mismatch), and it only surfaces later as a
 * runtime "X is not a function" test failure. This check needs no model
 * call, so it runs unconditionally alongside — not instead of — the LLM
 * passes, and its findings feed the fixer with the exact missing name
 * instead of leaving it to guess from a bare stack trace.
 */
export function findUnresolvedRequireImports(
  changedFiles: ContractCheckFile[],
  resolveFile: (relativePath: string) => string | null
): string[] {
  const issues: string[] = [];
  const changedByPath = new Map(changedFiles.map(f => [normalizeRelative(f.path), f.content]));
  const requireRe = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g;

  for (const file of changedFiles) {
    if (!/\.(js|cjs|mjs|ts|tsx)$/.test(file.path)) { continue; }
    requireRe.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = requireRe.exec(file.content))) {
      const names = match[1]
        .split(',')
        .map(part => part.split(':')[0].trim())
        .filter(name => /^[A-Za-z_$][\w$]*$/.test(name));
      if (names.length === 0) { continue; }

      const targetPath = resolveRequireTarget(file.path, match[2], relPath =>
        changedByPath.has(relPath) || resolveFile(relPath) !== null
      );
      if (!targetPath) {
        issues.push(`${file.path} requires "${match[2]}", but no matching file (tried .js/.cjs/.mjs/.ts) was found.`);
        continue;
      }

      const targetContent = changedByPath.get(targetPath) ?? resolveFile(targetPath);
      if (targetContent === null || targetContent === undefined) { continue; }

      const exported = extractCommonJsExports(targetContent);
      if (exported === null) { continue; } // couldn't confidently determine exports; don't risk a false positive

      for (const name of names) {
        if (!exported.has(name)) {
          issues.push(`${file.path} imports "${name}" from "${match[2]}", but ${targetPath} does not export it.`);
        }
      }
    }
  }
  return issues;
}

function normalizeRelative(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function resolveRequireTarget(
  fromPath: string,
  relativeImport: string,
  exists: (relativePath: string) => boolean
): string | null {
  const dir = path.posix.dirname(normalizeRelative(fromPath));
  const joined = path.posix.normalize(path.posix.join(dir, relativeImport));
  const candidates = /\.\w+$/.test(joined)
    ? [joined]
    : [joined, `${joined}.js`, `${joined}.cjs`, `${joined}.mjs`, `${joined}.ts`, `${joined}/index.js`];
  return candidates.find(exists) ?? null;
}

const ESM_SYNTAX_RE = /^\s*export\s+(default\s+|const\s+|let\s+|var\s+|function\s+|class\s+|\{)/m;
const ESM_IMPORT_RE = /\bimport\s.+\sfrom\s/;

/**
 * Best-effort extraction of the names a CommonJS module exports. Returns
 * null (not an empty set) whenever the file's export shape can't be
 * confidently parsed — e.g. `module.exports = SomeIdentifier`, a spread
 * (`...rest`) inside the export object, or ESM `export`/`import` syntax our
 * CJS-only heuristic isn't built to read — so the caller treats it as
 * inconclusive rather than flagging every import as missing. A file with NO
 * export syntax of any kind is not ambiguous, though: as a CommonJS module it
 * exports nothing, so this confidently returns an empty set for it (this is
 * exactly the real-world case the check exists to catch — a module a test
 * requires but that never got a `module.exports`).
 */
function extractCommonJsExports(content: string): Set<string> | null {
  const names = new Set<string>();
  let sawCjsExportSyntax = false;

  const objMatch = /module\.exports\s*=\s*\{/.exec(content);
  if (objMatch) {
    const braceStart = objMatch.index + objMatch[0].length - 1;
    const body = extractBalancedBraceBody(content, braceStart);
    if (body === null) { return null; }
    sawCjsExportSyntax = true;
    for (const rawEntry of splitTopLevel(body)) {
      const entry = rawEntry.trim();
      if (!entry) { continue; }
      if (entry.startsWith('...')) { return null; } // spread — can't verify statically
      const key = entry.split(':')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(key)) { names.add(key); }
    }
  } else if (/module\.exports\s*=\s*[A-Za-z_$]/.test(content)) {
    return null; // module.exports = SomeIdentifier — shape unknown statically
  }

  const assignRe = /(?:module\.exports|exports)\.([A-Za-z_$][\w$]*)\s*=/g;
  let m: RegExpExecArray | null;
  while ((m = assignRe.exec(content))) {
    sawCjsExportSyntax = true;
    names.add(m[1]);
  }

  if (ESM_SYNTAX_RE.test(content) || ESM_IMPORT_RE.test(content)) {
    return sawCjsExportSyntax ? names : null;
  }

  return names;
}

const NODE_ONLY_GLOBAL_RE = /\b(__dirname|__filename)\b/;
const NODE_BUILTIN_REQUIRE_RE = /require\(\s*['"](fs|path|os|child_process|readline|repl|cluster|worker_threads|dgram|dns|net|tls|zlib)(?:\/[^'"]*)?['"]\s*\)/;

/**
 * Deterministic cross-check for the other real failure mode seen in practice
 * (twice, in two separately generated browser-game projects): a file written
 * with ES module `import`/`export` syntax — the shape a browser bundler
 * expects — that ALSO calls Node-only filesystem/process APIs
 * (`require('fs')`, `path.join(__dirname, ...)`, etc). Node and a browser
 * disagree about which half of that file is valid, so it is never correct
 * regardless of target: a browser bundle throws `ReferenceError: require is
 * not defined` (or `__dirname is not defined`) the moment the file loads,
 * and a plain Node `require()` of the same file throws `SyntaxError: Cannot
 * use import statement outside a module`. Both LLM review passes have missed
 * this (the file "looks" fine read in isolation), so — like the check above
 * — this runs unconditionally rather than only when a model is unavailable.
 */
export function findBrowserIncompatibleNodeUsage(changedFiles: ContractCheckFile[]): string[] {
  const issues: string[] = [];
  for (const file of changedFiles) {
    if (!/\.(js|jsx|ts|tsx|mjs)$/.test(file.path)) { continue; }
    if (!(ESM_SYNTAX_RE.test(file.content) || ESM_IMPORT_RE.test(file.content))) { continue; }

    const globalMatch = NODE_ONLY_GLOBAL_RE.exec(file.content);
    const requireMatch = NODE_BUILTIN_REQUIRE_RE.exec(file.content);
    if (!globalMatch && !requireMatch) { continue; }

    const found = [
      requireMatch ? `require("${requireMatch[1]}")` : null,
      globalMatch ? globalMatch[1] : null,
    ].filter(Boolean).join(' and ');
    issues.push(
      `${file.path} uses ES module import/export syntax alongside Node-only ${found}. ` +
      `A browser bundle has no filesystem or Node globals, so this throws at runtime the moment the file loads. ` +
      `Rewrite it as pure ESM (e.g. "import data from './file.json'" instead of ` +
      `"fs.readFileSync(path.join(__dirname, ...))"), or, if this file genuinely only ever runs under Node, ` +
      `remove all import/export syntax and use plain CommonJS (require/module.exports) instead — never mix both in one file.`
    );
  }
  return issues;
}

// Extensions no LLM can produce real content for: it only emits text, so a
// "file" at one of these paths is always empty or corrupt garbage, never a
// real asset. Seen in practice (2026-09-17): the architect/task planner
// assigned `src/assets/spritesheet.png` to a coding task; the code worker
// wrote it 0 bytes every attempt, the heuristic "file is empty" review issue
// recurred identically across fix attempts, and the run's stuck-loop guard
// correctly gave up — failing the whole build over a plan that was never
// achievable by a text-only model. `.svg` is deliberately excluded: it's
// plain text XML, so a model can genuinely author one.
const BINARY_ASSET_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.tiff', '.tif',
  '.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac',
  '.mp4', '.mov', '.webm', '.avi',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.pdf', '.zip',
]);

/**
 * True when `filePath` has an extension only a real binary tool (not a
 * text-generating LLM) could ever produce meaningful content for.
 */
export function isBinaryAssetPath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_ASSET_EXTENSIONS.has(ext);
}

export type ToolchainMarkerStack = 'swift' | 'rust' | 'go' | 'java' | 'dotnet';

/**
 * The stack a build-manifest file declares, or null if `filePath` is not one.
 * These files are not inert: the verification planner turns their mere
 * existence into a mandatory check (`Package.swift` → `swift test`). A real
 * run (2026-09-19) had the test-fixer invent a `Package.swift` inside a pure
 * JS/Phaser game, and every remaining fix attempt was burned on a Swift check
 * the project could never pass.
 */
export function toolchainMarkerStack(filePath: string): ToolchainMarkerStack | null {
  const base = path.basename(filePath);
  if (base === 'Package.swift') { return 'swift'; }
  if (base === 'Cargo.toml') { return 'rust'; }
  if (base === 'go.mod') { return 'go'; }
  if (/^(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradlew)$/.test(base)) { return 'java'; }
  if (/\.(csproj|fsproj|sln)$/i.test(base)) { return 'dotnet'; }
  return null;
}

const TOOLCHAIN_STACK_RE: Record<ToolchainMarkerStack, RegExp> = {
  swift: /\bswift(ui)?\b|\bios\b|\bipados\b|\bmacos\b|\bwatchos\b|\btvos\b|\bvisionos\b|\bxcode\b|\bapple platform/,
  rust: /\brust\b|\bcargo\b/,
  go: /\bgolang\b|\bgo\s+(module|modules|1\.\d+|language|backend|service|server|cli)\b|,\s*go\b/,
  java: /\bjava\b|\bkotlin\b|\bscala\b|\bgradle\b|\bmaven\b|\bandroid\b|\bspring\b|\bjvm\b/,
  dotnet: /\.net\b|\bdotnet\b|\bc#|\bcsharp\b|\bf#|\bblazor\b|\basp\.net\b|\bunity\b|\bmaui\b/,
};

/**
 * True when `stackText` (brief chosenStack/targetPlatforms + user prompt,
 * any case) plausibly asks for the stack `stack`. List items should be
 * comma-joined with a leading ", " so a bare "Go" entry is recognizable.
 */
export function stackTextMentions(stack: ToolchainMarkerStack, stackText: string): boolean {
  return TOOLCHAIN_STACK_RE[stack].test(stackText.toLowerCase());
}

const HAS_EXPORT_RE =/\bexport\s+(default\b|class\b|function\b|const\b|let\b|var\b|\{)|\bmodule\.exports\b|\bexports\.\w+\s*=/;
const CONVENTIONAL_ENTRY_RE = /(^|\/)(index|main|app|server|bootstrap|bin\/[^/]+|[\w.-]+\.config)\.[cm]?[jt]sx?$/i;
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const TEST_DIR_RE = /(^|\/)(tests?|__tests__|__mocks__)\//i;

/**
 * Deterministic, END-OF-BUILD-ONLY cross-check: a file that exports real
 * content but is never referenced (import/require specifier, or an HTML
 * `<script src>`) by anything else in the finished project. This is exactly
 * what a real run produced (2026-09-12): `Ball.js`/`Paddle.js`/`Brick.js`
 * were fully implemented, well-formed classes that no other file ever
 * imported — the actual game never created a paddle, a ball, or a single
 * collider, and nothing caught it because each file reads fine in isolation.
 *
 * Deliberately scoped to run ONCE, over the whole finished project tree, not
 * per task: a multi-task sprint plan legitimately creates a file in one task
 * and wires it in a later one, so checking this after every task would flag
 * normal, unfinished-but-in-progress work as a defect. By final delivery,
 * everything is supposed to be wired together — an export still unreferenced
 * at that point is a real signal, not a false alarm.
 *
 * The reference search is deliberately permissive (a bare basename match,
 * not full module resolution with aliases/index-resolution/dynamic
 * `import()`) because this check is advisory, not a build gate: a missed
 * real reference only means an orphan goes unreported, whereas a
 * wrongly-flagged real reference would cast doubt on a fine file. Prefer
 * under-flagging.
 */
export function findUnreferencedExportingFiles(files: ContractCheckFile[]): string[] {
  const candidates = files.filter(f =>
    /\.(js|jsx|ts|tsx|mjs|cjs)$/.test(f.path) &&
    !TEST_FILE_RE.test(f.path) &&
    !TEST_DIR_RE.test(f.path) &&
    !CONVENTIONAL_ENTRY_RE.test(f.path) &&
    HAS_EXPORT_RE.test(f.content)
  );
  if (candidates.length === 0) { return []; }

  const issues: string[] = [];
  for (const candidate of candidates) {
    const base = basenameNoExt(candidate.path);
    if (!base) { continue; }
    const referenceRe = new RegExp(`['"\`][^'"\`]*\\b${escapeRegExp(base)}(\\.[cm]?[jt]sx?)?['"\`]`);
    const isReferencedElsewhere = files.some(other => other.path !== candidate.path && referenceRe.test(other.content));
    if (!isReferencedElsewhere) {
      issues.push(
        `${candidate.path} exports code but is never imported, required, or <script src="...">-referenced by any other ` +
        `file in the finished project — it looks like dead code, or a class/module the app was supposed to wire in but ` +
        `never did (e.g. a Sprite/component defined but never instantiated). Either wire it into the app, or remove it ` +
        `if it is genuinely unused.`
      );
    }
  }
  return issues;
}

function basenameNoExt(relativePath: string): string {
  const base = relativePath.split('/').pop() ?? '';
  return base.replace(/\.[cm]?[jt]sx?$/, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractBalancedBraceBody(content: string, openBraceIndex: number): string | null {
  let depth = 0;
  for (let i = openBraceIndex; i < content.length; i++) {
    if (content[i] === '{') { depth++; }
    else if (content[i] === '}') {
      depth--;
      if (depth === 0) { return content.slice(openBraceIndex + 1, i); }
    }
  }
  return null;
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '{' || ch === '(' || ch === '[') { depth++; }
    else if (ch === '}' || ch === ')' || ch === ']') { depth--; }
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) { parts.push(current); }
  return parts;
}
