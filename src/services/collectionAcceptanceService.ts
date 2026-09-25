import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface CollectionCountRequirement {
  label: string;
  expectedCount: number;
  comparison: 'exactly' | 'at-least' | 'at-most';
  sourceText: string;
}

export type CollectionAcceptanceSource =
  | { kind: 'json-array'; file: string; pointer?: string }
  | { kind: 'module-export'; file: string; export: string; pointer?: string };

export interface CollectionAcceptanceBinding {
  label: string;
  source: CollectionAcceptanceSource;
}

export interface CollectionAcceptanceCheck extends CollectionCountRequirement {
  status: 'passed' | 'failed' | 'unverified';
  failureKind?: 'too-few' | 'too-many' | 'missing-binding' | 'ambiguous-binding' | 'invalid-source';
  actualCount?: number;
  source?: CollectionAcceptanceSource;
  diagnostic: string;
}

export interface CollectionAcceptanceReport {
  generatedAt: string;
  checks: CollectionAcceptanceCheck[];
  failed: boolean;
  unverified: boolean;
  summary: string;
}

const COLLECTION_ALIASES: Record<string, string[]> = {
  levels: ['levels', 'level', 'lvls', 'lvl', 'man', 'cap do'],
  stages: ['stages', 'stage', 'giai doan'],
  questions: ['questions', 'question', 'cau hoi'],
  pages: ['pages', 'page', 'trang'],
  items: ['items', 'item', 'muc'],
  slides: ['slides', 'slide'],
  lessons: ['lessons', 'lesson', 'bai hoc'],
  exercises: ['exercises', 'exercise', 'bai tap'],
};

function normalize(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}

function canonicalLabel(label: string): string | null {
  const normalized = normalize(label.trim());
  return Object.keys(COLLECTION_ALIASES).find(key => COLLECTION_ALIASES[key].includes(normalized)) ?? null;
}

/** Deliberately narrow: numeric memory limits, versions, level 20, and items/page are not total collection counts. */
export function extractCollectionCountRequirements(goal: string): CollectionCountRequirement[] {
  const aliases = Object.values(COLLECTION_ALIASES).flat().sort((a, b) => b.length - a.length).join('|');
  const quantifiers = 'at least|at most|no fewer than|no more than|up to|minimum of|maximum of|minimum|maximum|exactly|precisely|it nhat|toi thieu|toi da|chinh xac|dung';
  const modifiers = 'distinct|playable|unique|different|separate|individual|complete|working|interactive|numbered|fully playable|increasingly difficult';
  const pattern = new RegExp(`(?<![\\w.,+\\-/])(?:(?<quantifier>${quantifiers})\\s+)?(?<count>\\d{1,6})(?:\\s+|-)(?:(?:${modifiers})\\s+){0,3}(?<label>${aliases})(?![\\w])`, 'g');
  const normalized = normalize(goal);
  const requirements: CollectionCountRequirement[] = [];
  for (const match of normalized.matchAll(pattern)) {
    const before = normalized.slice(Math.max(0, match.index! - 35), match.index);
    const after = normalized.slice(match.index! + match[0].length, match.index! + match[0].length + 30);
    if (/\b(?:not|rather than|instead of|without|khong phai|khong can)\s*$/.test(before)
      || /^\s*(?:per\b|each\b|a\s+page\b|\/|moi\b|tren moi\b)/.test(after)) { continue; }
    const label = canonicalLabel(match.groups!.label)!;
    const quantifier = match.groups!.quantifier ?? '';
    const comparison: CollectionCountRequirement['comparison'] = /at least|no fewer than|minimum|it nhat|toi thieu/.test(quantifier)
      ? 'at-least' : /at most|no more than|up to|maximum|toi da/.test(quantifier) ? 'at-most' : 'exactly';
    const requirement = { label, expectedCount: Number(match.groups!.count), comparison, sourceText: match[0] };
    if (!requirements.some(item => item.label === label && item.expectedCount === requirement.expectedCount && item.comparison === comparison)) {
      requirements.push(requirement);
    }
  }
  return requirements;
}

/**
 * Counts source-backed collections, never a model's claimed count or test-summary text.
 * Module bindings execute trusted generated project code with the same trust as its tests;
 * the subprocess limits duration, heap, and output, but is not a security sandbox for imports.
 */
export class CollectionAcceptanceService {
  constructor(private readonly workspaceRoot: string, private readonly options: { moduleTimeoutMs?: number } = {}) {}

  async verify(goal: string, bindings?: CollectionAcceptanceBinding[]): Promise<CollectionAcceptanceReport> {
    const requirements = extractCollectionCountRequirements(goal);
    if (requirements.length === 0) { return this._report([]); }
    let declarations: unknown = bindings;
    let declarationError = '';
    if (bindings === undefined) {
      const manifest = path.join(this.workspaceRoot, 'acceptance.json');
      if (!fs.existsSync(manifest)) { declarations = []; }
      else {
        try {
          const file = this._resolveSourceFile('acceptance.json', false);
          declarations = (JSON.parse(this._readBoundedJson(file)) as { collections?: unknown }).collections;
        } catch (error) { declarationError = `Cannot read acceptance.json: ${this._error(error)}`; }
      }
    }
    if (!declarationError && !Array.isArray(declarations)) { declarationError = 'acceptance.json must contain a collections array of source bindings.'; }

    const checks: CollectionAcceptanceCheck[] = [];
    for (const requirement of requirements) {
      if (declarationError) {
        checks.push({ ...requirement, status: 'failed', failureKind: 'invalid-source', diagnostic: declarationError });
        continue;
      }
      const matches = (declarations as unknown[]).filter(item => this._isObject(item)
        && typeof item.label === 'string' && canonicalLabel(item.label) === requirement.label);
      if (matches.length !== 1) {
        checks.push({ ...requirement, status: 'unverified', failureKind: matches.length > 1 ? 'ambiguous-binding' : 'missing-binding', diagnostic: matches.length > 1
          ? `Multiple bindings for ${requirement.label}; identify one authoritative product collection. No count was assumed.`
          : this._missingBindingDiagnostic(requirement.label) });
        continue;
      }
      const raw = matches[0] as Record<string, unknown>;
      try {
        const source = this._validateSource(raw.source);
        const file = this._resolveSourceFile(source.file);
        const actualCount = source.kind === 'json-array'
          ? this._jsonArrayCount(file, source.pointer)
          : await this._moduleArrayCount(file, source.export, source.pointer);
        const passed = requirement.comparison === 'at-least' ? actualCount >= requirement.expectedCount
          : requirement.comparison === 'at-most' ? actualCount <= requirement.expectedCount
            : actualCount === requirement.expectedCount;
        checks.push({ ...requirement, source, actualCount, status: passed ? 'passed' : 'failed',
          failureKind: passed ? undefined : actualCount < requirement.expectedCount ? 'too-few' : 'too-many',
          diagnostic: `${source.file}${source.kind === 'module-export' ? ` export ${source.export}` : ''}${source.pointer ?? ''} contains ${actualCount} ${requirement.label}; original goal requires ${requirement.comparison} ${requirement.expectedCount}.` });
      } catch (error) {
        checks.push({ ...requirement, status: 'failed', failureKind: 'invalid-source', diagnostic: this._error(error) });
      }
    }
    return this._report(checks);
  }

  private _validateSource(value: unknown): CollectionAcceptanceSource {
    if (!this._isObject(value) || typeof value.file !== 'string' || !value.file.trim()) {
      throw new Error('Collection binding needs a source file; self-declared counts are not evidence.');
    }
    if (value.pointer !== undefined && (typeof value.pointer !== 'string' || (value.pointer !== '' && !value.pointer.startsWith('/')) || /~(?![01])/.test(value.pointer))) {
      throw new Error('Source pointer must be an RFC 6901 JSON Pointer (empty or starting with /, using ~0 and ~1 escapes).');
    }
    if (value.kind === 'json-array') {
      if (path.extname(value.file).toLowerCase() !== '.json') { throw new Error('json-array source must name a JSON file.'); }
      return { kind: value.kind, file: value.file, pointer: value.pointer as string | undefined };
    }
    if (value.kind === 'module-export' && typeof value.export === 'string' && /^[A-Za-z_$][\w$]*$/.test(value.export)) {
      if (!/\.[cm]?js$/i.test(value.file)) { throw new Error('module-export source must name a built JavaScript .js/.cjs/.mjs file.'); }
      return { kind: value.kind, file: value.file, export: value.export, pointer: value.pointer as string | undefined };
    }
    throw new Error('Supported collection sources are json-array or module-export with a named/default array export. Counts and arbitrary expressions are not accepted.');
  }

  private _resolveSourceFile(file: string, productSource = true): string {
    if (path.isAbsolute(file)) { throw new Error('Collection source must use a path relative to the workspace.'); }
    const root = fs.realpathSync(this.workspaceRoot);
    const absolute = fs.realpathSync(path.resolve(root, file));
    const relative = path.relative(root, absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Collection source resolves outside the workspace.');
    }
    if (!fs.statSync(absolute).isFile()) { throw new Error('Collection source must be a file.'); }
    if (productSource && (relative.split(path.sep).some(part => ['.agent-workspace', '.git', 'node_modules'].includes(part)) || relative === 'acceptance.json')) {
      throw new Error('Bind a product data/module file, not agent metadata, dependencies, or acceptance.json itself.');
    }
    return absolute;
  }

  private _readBoundedJson(file: string): string {
    if (fs.statSync(file).size > 4 * 1024 * 1024) { throw new Error('Collection JSON exceeds the 4 MiB verification limit; use a module-export binding.'); }
    return fs.readFileSync(file, 'utf8');
  }

  private _jsonArrayCount(file: string, pointer = ''): number {
    let value: unknown = JSON.parse(this._readBoundedJson(file));
    for (const token of pointer ? pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~')) : []) {
      if (value === null || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, token)) {
        throw new Error(`Collection JSON Pointer ${pointer} was not found in ${path.basename(file)}.`);
      }
      value = (value as Record<string, unknown>)[token];
    }
    if (!Array.isArray(value)) {
      const children = value && typeof value === 'object' ? Object.entries(value)
        .filter(([, child]) => Array.isArray(child))
        .slice(0, 8).map(([key]) => `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`) : [];
      throw new Error(`Collection source ${path.basename(file)}${pointer} must resolve to an array, not a declared numeric count.${children.length ? ` Arrays exist at JSON Pointer(s): ${children.join(', ')}. Update acceptance.json to bind the array actually used by the product.` : ''}`);
    }
    return value.length;
  }

  private _moduleArrayCount(file: string, exportName: string, pointer = ''): Promise<number> {
    // Arguments are passed directly; neither paths nor bindings are interpolated into executable code.
    const probe = String.raw`
      import fs from 'node:fs';
      import { pathToFileURL } from 'node:url';
      const [file, name, pointer] = process.argv.slice(1);
      try {
        const mod = await import(pathToFileURL(file).href);
        let value;
        if (Object.prototype.hasOwnProperty.call(mod, name)) value = mod[name];
        else if (mod.default && Object.prototype.hasOwnProperty.call(mod.default, name)) value = mod.default[name];
        else throw new Error('Module has no export named ' + name);
        for (const token of pointer ? pointer.slice(1).split('/').map(p=>p.replace(/~1/g,'/').replace(/~0/g,'~')) : []) {
          if (value === null || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value,token)) throw new Error('Module pointer not found: ' + pointer);
          value = value[token];
        }
        if (!Array.isArray(value)) throw new Error('Module export must resolve to an array, not a function or declared count.');
        for (let index=0;index<value.length;index++) {
          if (!Object.prototype.hasOwnProperty.call(value,index)) throw new Error('Module collection is sparse: reserved array slots are not materialized collection entries.');
        }
        fs.writeSync(3, JSON.stringify({actualCount:value.length}));
        process.exit(0);
      } catch(error) {
        console.error(error && error.stack || String(error));
        process.exit(1);
      }
    `;
    return new Promise((resolve, reject) => {
      const proc = cp.spawn(process.execPath, ['--max-old-space-size=256', '--input-type=module', '-e', probe, file, exportName, pointer], {
        cwd: this.workspaceRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true,
      });
      let diagnostic = '';
      let evidence = '';
      let totalBytes = 0;
      let settled = false;
      const finish = (error?: Error, count?: number): void => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        try {
          if (proc.pid && process.platform !== 'win32') { process.kill(-proc.pid, 'SIGKILL'); }
          else if (proc.pid && proc.exitCode === null) {
            cp.spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
          }
        } catch { /* The process group has already exited. */ }
        if (error) { reject(error); } else { resolve(count!); }
      };
      const timeout = Math.max(50, Math.min(this.options.moduleTimeoutMs ?? 5_000, 30_000));
      const timer = setTimeout(() => finish(new Error(`Collection module ${path.basename(file)} timed out after ${timeout} ms.`)), timeout);
      const capture = (chunk: Buffer): void => {
        totalBytes += chunk.length;
        diagnostic = (diagnostic + String(chunk)).slice(-8_000);
        if (totalBytes > 128_000) { finish(new Error(`Collection module ${path.basename(file)} exceeded its output limit.`)); }
      };
      proc.stdout?.on('data', capture);
      proc.stderr?.on('data', capture);
      (proc.stdio[3] as NodeJS.ReadableStream).on('data', chunk => {
        evidence += String(chunk);
        if (evidence.length > 4_096) { finish(new Error('Collection module returned excessive verification evidence.')); }
      });
      proc.on('error', error => finish(error));
      proc.on('close', code => {
        if (settled) { return; }
        if (code !== 0) { finish(new Error(`Collection module ${path.basename(file)} failed (exit ${code}): ${diagnostic}`)); return; }
        try {
          const result = JSON.parse(evidence) as { actualCount?: unknown };
          if (typeof result.actualCount !== 'number' || !Number.isSafeInteger(result.actualCount) || result.actualCount < 0) {
            throw new Error('Module probe returned no measured array length.');
          }
          finish(undefined, result.actualCount);
        } catch (error) { finish(new Error(`Could not measure module collection: ${this._error(error)}`)); }
      });
    });
  }

  private _missingBindingDiagnostic(label: string): string {
    return `No authoritative source binding for ${label}. Add acceptance.json with {"collections":[{"label":"${label}","source":{"kind":"json-array","file":"src/${label}.json","pointer":""}}]}, or bind {"kind":"module-export","file":"src/${label}.js","export":"${label}"} to an actual exported array. Procedural collections are supported; do not substitute a claimed count or a test-summary string.`;
  }

  private _isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private _error(error: unknown): string { return error instanceof Error ? error.message : String(error); }

  private _report(checks: CollectionAcceptanceCheck[]): CollectionAcceptanceReport {
    const failed = checks.some(check => check.status === 'failed');
    const unverified = checks.some(check => check.status === 'unverified');
    return { generatedAt: new Date().toISOString(), checks, failed, unverified,
      summary: checks.length === 0 ? 'No supported explicit collection-count requirements found in the original goal.'
        : failed ? 'Collection count verification failed.' : unverified ? 'Collection count requirements still need source-backed evidence.'
          : 'Declared product collections satisfy the original goal counts; gameplay and semantic quality are separate checks.' };
  }
}
