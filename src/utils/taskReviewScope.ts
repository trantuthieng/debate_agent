import * as fs from 'fs';
import * as path from 'path';

/**
 * What one task has touched across its whole review/fix loop (audit C01/C02).
 *
 * A re-review used to look only at the files of the latest fix patch, so a
 * no-op fix, a fix that edited a different file, or a delete made earlier
 * errors fall out of the checked set, and a browser failure that the previous
 * review already blamed on the task stopped being reported the second time.
 */
export interface TaskReviewScope {
  /** Files the task wrote (created/modified) during this attempt. */
  written: Set<string>;
  /** Files the task deleted during this attempt. */
  deleted: Set<string>;
  /** Runtime checks that failed because of this task and have not passed since. */
  openRuntime: Set<'smoke' | 'build' | 'test'>;
  /** Why some checks could not run (the task is then unverified, not clean). */
  unverified: string[];
}

export interface ScopedFileChange { path: string; action?: string }

export class TaskReviewScopes {
  private readonly scopes = new Map<string, TaskReviewScope>();

  /** Starts a fresh scope for a task that is (re)written from scratch. */
  reset(taskId: string): void { this.scopes.delete(taskId); }

  clear(): void { this.scopes.clear(); }

  get(taskId: string): TaskReviewScope {
    let scope = this.scopes.get(taskId);
    if (!scope) {
      scope = { written: new Set(), deleted: new Set(), openRuntime: new Set(), unverified: [] };
      this.scopes.set(taskId, scope);
    }
    return scope;
  }

  /** Adds one patch's changes; a later write of a deleted file (or vice versa) wins. */
  record(taskId: string, changes: ScopedFileChange[]): TaskReviewScope {
    const scope = this.get(taskId);
    for (const change of changes) {
      if (!change.path) { continue; }
      if (change.action === 'delete') { scope.written.delete(change.path); scope.deleted.add(change.path); }
      else { scope.deleted.delete(change.path); scope.written.add(change.path); }
    }
    return scope;
  }
}

const SOURCE_FILE = /\.(m?[jt]sx?|cjs|vue|svelte)$/;
const RESOLVE_SUFFIXES = ['', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '/index.js', '/index.ts', '/index.mjs'];
const SPECIFIER = /(?:\bimport\s*(?:[^'"()]*?\bfrom\s*)?|\bexport\s+[^'"]*?\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

function withoutExtension(file: string): string { return file.replace(/\.(m?[jt]sx?|cjs)$/, ''); }

/**
 * Project files that import one of `targets` through a relative specifier.
 * Their errors after a task deleted or reshaped a module are that task's
 * doing even though the task never touched them (audit C02).
 */
export function findImporters(rootDir: string, targets: string[], sourceFiles: string[]): string[] {
  const wanted = new Set<string>();
  for (const target of targets) { wanted.add(target); wanted.add(withoutExtension(target)); }
  const importers: string[] = [];
  for (const file of sourceFiles) {
    if (!SOURCE_FILE.test(file) || targets.includes(file)) { continue; }
    let text: string;
    try { text = fs.readFileSync(path.join(rootDir, file), 'utf8'); } catch { continue; }
    if (text.length > 500_000) { continue; }
    const dir = path.posix.dirname(file);
    for (const match of text.matchAll(SPECIFIER)) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) { continue; }
      const base = path.posix.normalize(path.posix.join(dir, specifier.split(/[?#]/)[0]));
      const hit = RESOLVE_SUFFIXES.some(suffix => wanted.has(base + suffix) || wanted.has(withoutExtension(base + suffix)));
      if (hit) { importers.push(file); break; }
    }
  }
  return importers;
}

/** Error text that means an import or export no longer lines up. */
export const IMPORT_BREAKAGE = /does not provide an export|has no exported member|is not exported|Cannot find module|Can't resolve|Module not found|Failed to resolve import|Could not resolve|ERR_MODULE_NOT_FOUND|is not a function|is not a constructor|is not defined|TS2305|TS2307|TS2614|TS2724/i;
