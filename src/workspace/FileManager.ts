import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import type { FileChange, FileSnapshot, PatchResult } from '../types';
import { logInfo, logWarn } from '../utils/logging';

// -----------------------------------------------------------------------
// FileManager: safe file operations within the workspace
// -----------------------------------------------------------------------
export class FileManager {
  private readonly workspaceRoot: string;
  private readonly requestedRoot: string;

  constructor(workspaceRoot: string) {
    this.requestedRoot = path.resolve(workspaceRoot);
    // Resolve aliases in the selected root once (e.g. macOS /var -> /private/var).
    // Descendant symlinks, even links to other workspace files, are rejected.
    let ancestor = this.requestedRoot;
    const missing: string[] = [];
    while (!fs.existsSync(ancestor)) {
      missing.unshift(path.basename(ancestor));
      const parent = path.dirname(ancestor);
      if (parent === ancestor) { throw new Error('Workspace has no existing parent.'); }
      ancestor = parent;
    }
    this.workspaceRoot = path.join(fs.realpathSync(ancestor), ...missing);
  }

  // ------------------------------------------------------------------
  // Core read / write
  // ------------------------------------------------------------------

  readWorkspaceFile(relativePath: string): string | null {
    // Validate outside the catch: an unsafe path must not look like a missing file.
    this._resolve(relativePath);
    try {
      const file = this._readFile(relativePath);
      return file ? file.content.toString('utf8') : null;
    } catch (err) {
      logWarn(`Could not read file "${relativePath}": ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  writeWorkspaceFile(relativePath: string, content: string | Uint8Array): void {
    this._writeFile(relativePath, content, false);
    logInfo(`Wrote file: ${relativePath}`);
  }

  /** Same-filesystem replacement preserves the previous checkpoint on failed writes. */
  writeWorkspaceFileAtomic(relativePath: string, content: string): void {
    const destination = this._resolve(relativePath);
    this.ensureDirectory(path.dirname(destination));
    const temporary = path.join(path.dirname(destination),
      `.${path.basename(destination)}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`);
    try {
      this._writeFile(temporary, content, false);
      // Check again after staging: neither metadata parents nor the final target
      // may become symlinks. Rename remains subject to the parent race described below.
      const checkedDestination = this._resolve(relativePath);
      const checkedTemporary = this._resolve(temporary);
      fs.renameSync(checkedTemporary, checkedDestination);
    } catch (err) {
      try { this.deleteWorkspaceFile(temporary); } catch { /* best-effort guarded cleanup */ }
      throw err;
    }
  }

  appendWorkspaceFile(relativePath: string, content: string): void {
    this._writeFile(relativePath, content, true);
  }

  deleteWorkspaceFile(relativePath: string): void {
    const fullPath = this._resolve(relativePath);
    try { fs.unlinkSync(fullPath); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { throw err; } }
  }

  ensureDirectory(dirPath: string): void {
    const fullPath = this._resolve(dirPath);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
    this._resolve(fullPath);
    if (!fs.statSync(fullPath).isDirectory()) { throw new Error(`Not a directory: ${dirPath}`); }
  }

  fileExists(relativePath: string): boolean {
    return fs.existsSync(this._resolve(relativePath));
  }

  getFileSnapshot(relativePath: string): FileSnapshot {
    const normalizedPath = relativePath.replace(/\\/g, '/');
    const fullPath = this._resolve(normalizedPath);
    if (!fs.existsSync(fullPath)) {
      return {
        path: normalizedPath,
        exists: false,
        capturedAt: new Date().toISOString(),
      };
    }

    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) {
      return {
        path: normalizedPath,
        exists: true,
        capturedAt: new Date().toISOString(),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    }

    const file = this._readFile(normalizedPath);
    if (!file) { throw new Error(`File changed while capturing snapshot: ${normalizedPath}`); }
    const { content } = file;
    return {
      path: normalizedPath,
      exists: true,
      capturedAt: new Date().toISOString(),
      hash: createHash('sha256').update(content).digest('hex'),
      size: file.stat.size,
      mtimeMs: file.stat.mtimeMs,
    };
  }

  hasFileChangedSince(snapshot: FileSnapshot): boolean {
    const current = this.getFileSnapshot(snapshot.path);
    return current.exists !== snapshot.exists || current.hash !== snapshot.hash;
  }

  detectConflictingChanges(changes: FileChange[], baselines: Map<string, FileSnapshot> | undefined): string[] {
    const errors: string[] = [];

    for (const change of changes) {
      const normalizedPath = change.path.replace(/\\/g, '/');
      if (normalizedPath.endsWith('/')) {
        // A directory-only scaffold entry (e.g. "src/") has no content to
        // conflict with — re-"creating" a directory that already exists
        // (routine across sprints of an iterative build) is always safe.
        continue;
      }
      const baseline = baselines?.get(normalizedPath);
      const current = this.getFileSnapshot(normalizedPath);

      if (change.action === 'create') {
        if (current.exists && (!baseline || !baseline.exists)) {
          errors.push(`File "${normalizedPath}" already exists but the agent planned to create it without a baseline.`);
        } else if (baseline && this.hasFileChangedSince(baseline)) {
          errors.push(`File "${normalizedPath}" changed after the agent read it.`);
        }
        continue;
      }

      if (!baseline) {
        if (current.exists) {
          errors.push(`File "${normalizedPath}" exists but no read baseline was captured before the agent modified it.`);
        }
        continue;
      }

      if (this.hasFileChangedSince(baseline)) {
        errors.push(`File "${normalizedPath}" changed after the agent read it.`);
      }
    }

    return errors;
  }

  listWorkspaceFiles(relativeDir: string = '', extensions?: string[]): string[] {
    const fullDir = this._resolve(relativeDir);
    if (!fs.existsSync(fullDir)) { return []; }

    const results: string[] = [];
    const skippedDirs = new Set([
      '.agent-workspace',
      '.git',
      '.next',
      '.nuxt',
      '.turbo',
      '.vscode-test',
      'build',
      'coverage',
      'dist',
      'node_modules',
      'out',
    ]);
    const scan = (dir: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(this._resolve(dir), { withFileTypes: true }); }
      catch { return; }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Skip hidden/build/cache dirs that can make VS Code extension host
          // appear frozen when a workspace is large.
          if (!entry.name.startsWith('.') && !skippedDirs.has(entry.name)) {
            scan(fullPath);
          }
        } else if (entry.isFile()) {
          const rel = path.relative(this.workspaceRoot, fullPath).replace(/\\/g, '/');
          if (!extensions || extensions.some(ext => rel.endsWith(ext))) {
            results.push(rel);
          }
        }
      }
    };

    scan(fullDir);
    return results;
  }

  // ------------------------------------------------------------------
  // Patch / diff utilities
  // ------------------------------------------------------------------

  /**
   * Generate a human-readable preview of proposed file changes (no-op, display only).
   */
  createPatchPreview(changes: FileChange[]): string {
    const lines: string[] = ['# Proposed File Changes\n'];

    for (const change of changes) {
      lines.push(`## ${change.action.toUpperCase()}: \`${change.path}\``);
      if (change.description) {
        lines.push(`> ${change.description}\n`);
      }
      if (change.patch) {
        lines.push('```diff');
        lines.push(change.patch);
        lines.push('```\n');
        continue;
      }
      const rawContent = typeof change.content === 'string' ? change.content : String(change.content ?? '');
      const existingContent = this._readExistingChangeTarget(change.path);
      if (
        change.content !== undefined &&
        existingContent !== null &&
        (change.action === 'modify' || change.action === 'append')
      ) {
        const afterContent = change.action === 'append' ? `${existingContent}${rawContent}` : rawContent;
        lines.push('```diff');
        lines.push(...this._createFocusedDiff(change.path, existingContent, afterContent));
        lines.push('```\n');
      } else if (change.action === 'delete' && existingContent !== null) {
        lines.push('```diff');
        lines.push(...this._createFocusedDiff(change.path, existingContent, ''));
        lines.push('```\n');
      } else if (change.content !== undefined) {
        const ext = path.extname(change.path).replace('.', '') || 'text';
        lines.push('```' + ext);
        // Show first 100 lines to keep preview manageable
        const contentLines = rawContent.split('\n');
        if (contentLines.length > 100) {
          lines.push(...contentLines.slice(0, 100));
          lines.push(`\n... (${contentLines.length - 100} more lines) ...`);
        } else {
          lines.push(rawContent);
        }
        lines.push('```\n');
      }
    }

    return lines.join('\n');
  }

  /**
   * Apply a set of file changes to the workspace.
   * In safe mode this should only be called after user approval.
   */
  applyFileChanges(changes: FileChange[], safeMode: boolean): PatchResult {
    const preview = this.createPatchPreview(changes);
    const targetFiles = changes.map(c => c.path);

    if (safeMode && this._requiresApproval(changes)) {
      return {
        applied: false,
        approved: false,
        targetFiles,
        preview,
        error: 'Safe mode: changes require user approval.',
      };
    }

    const errors: string[] = [];
    for (const change of changes) {
      try {
        this._applyChange(change);
      } catch (err) {
        errors.push(`${change.path}: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (errors.length > 0) {
      return {
        applied: false,
        approved: true,
        targetFiles,
        preview,
        error: errors.join('\n'),
      };
    }

    return { applied: true, approved: true, targetFiles, preview };
  }

  /**
   * Apply changes that have already been approved by the user.
   */
  applyApprovedChanges(changes: FileChange[]): PatchResult {
    const targetFiles = changes.map(c => c.path);
    const preview = this.createPatchPreview(changes);
    const errors: string[] = [];

    for (const change of changes) {
      try {
        this._applyChange(change);
      } catch (err) {
        errors.push(`${change.path}: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (errors.length > 0) {
      return { applied: false, approved: true, targetFiles, preview, error: errors.join('\n') };
    }
    return { applied: true, approved: true, targetFiles, preview };
  }

  /**
   * Read multiple files and concatenate them as context for agents.
   */
  readFilesAsContext(relativePaths: string[]): string {
    const parts: string[] = [];
    for (const rel of relativePaths) {
      const content = this.readWorkspaceFile(rel);
      if (content !== null) {
        parts.push(`\n\n### File: ${rel}\n\n${content}`);
      }
    }
    return parts.join('');
  }

  /**
   * Save a patch file to .agent-workspace/patches/ for auditing.
   */
  savePatch(patchId: string, preview: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(patchId)) {
      throw new Error('Patch ID must be a filename without path separators.');
    }
    const relativePath = path.join('.agent-workspace', 'patches', `${patchId}.md`);
    this.writeWorkspaceFile(relativePath, preview);
    return this._resolve(relativePath);
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private _isOutside(relative: string): boolean {
    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  }

  private _resolve(relativePath: string): string {
    const normalized = relativePath.replace(/\\/g, '/');
    let relative = path.relative(this.requestedRoot, path.resolve(this.requestedRoot, normalized));
    // Helpers also accept absolute paths returned by this manager for an aliased root.
    if (this._isOutside(relative) && path.isAbsolute(normalized)) {
      relative = path.relative(this.workspaceRoot, path.resolve(normalized));
    }
    if (this._isOutside(relative)) {
      throw new Error(`Path traversal attempt: "${relativePath}" is outside the workspace.`);
    }

    // Check the pinned root, or its nearest existing parent for a new workspace.
    let ancestor = this.workspaceRoot;
    for (;;) {
      try { fs.lstatSync(ancestor); break; }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { throw err; }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) { throw err; }
        ancestor = parent;
      }
    }
    if (fs.realpathSync(ancestor) !== ancestor) {
      throw new Error(`Workspace root changed or contains a symlink: ${ancestor}`);
    }
    let current = this.workspaceRoot;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(current); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') { break; }
        throw err;
      }
      if (stat.isSymbolicLink() || fs.realpathSync(current) !== current) {
        throw new Error(`Workspace symlink paths are not allowed: "${relativePath}".`);
      }
    }
    return path.join(this.workspaceRoot, relative);
  }

  private _validateDescriptor(relativePath: string, fd: number): fs.Stats {
    const fullPath = this._resolve(relativePath);
    const opened = fs.fstatSync(fd);
    const current = fs.lstatSync(fullPath);
    if (!opened.isFile() || !current.isFile() || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error(`Workspace file changed or is not a regular file: ${relativePath}`);
    }
    return opened;
  }

  private _readFile(relativePath: string): { content: Buffer; stat: fs.Stats } | null {
    const fullPath = this._resolve(relativePath);
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) { return null; }
    const fd = fs.openSync(fullPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = this._validateDescriptor(relativePath, fd);
      return { content: fs.readFileSync(fd), stat };
    } finally { fs.closeSync(fd); }
  }

  private _writeFile(relativePath: string, content: string | Uint8Array, append: boolean): void {
    this.ensureDirectory(path.dirname(this._resolve(relativePath)));
    const fullPath = this._resolve(relativePath);
    // Never truncate at open: validate the opened inode and parents before writing.
    // O_NOFOLLOW closes final-component symlink swaps. Portable Node does not offer
    // openat-style directory-relative operations: a hostile concurrent parent rename
    // can still race a syscall (including creation/unlink). This is not an OS sandbox.
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW |
      fs.constants.O_NONBLOCK | (append ? fs.constants.O_APPEND : 0);
    const fd = fs.openSync(fullPath, flags);
    try {
      this._validateDescriptor(relativePath, fd);
      if (!append) { fs.ftruncateSync(fd, 0); }
      fs.writeFileSync(fd, content, typeof content === 'string' ? 'utf8' : undefined);
    } finally { fs.closeSync(fd); }
  }

  private _applyChange(change: FileChange): void {
    const fullPath = this._resolve(change.path);
    const content = typeof change.content === 'string'
      ? change.content
      : Array.isArray(change.content)
        ? (change.content as unknown[]).join('\n')
        : String(change.content ?? '');

    switch (change.action) {
      case 'create':
      case 'modify':
        if (change.path.endsWith('/')) {
          // A directory-only scaffold entry (e.g. "src/" from a project
          // structure list) — a model has produced this as a literal file
          // path before. Create the directory itself; writing it as an empty
          // file would break every real file later written inside it
          // (ENOTDIR) and can never be recovered without deleting the file.
          if (content.trim() || change.patch) {
            throw new Error('A directory entry cannot contain file content or a patch.');
          }
          if (fs.existsSync(fullPath)) {
            const existing = fs.lstatSync(fullPath);
            if (!existing.isDirectory()) {
              // Recover the exact zero-byte placeholder from an earlier run;
              // never discard meaningful file content or follow a symlink.
              if (!existing.isFile() || existing.size !== 0) {
                throw new Error('Cannot replace a non-empty file or symlink with a directory.');
              }
              fs.unlinkSync(fullPath);
            }
          }
          this.ensureDirectory(fullPath);
          break;
        }
        this.writeWorkspaceFile(change.path, content);
        break;
      case 'append':
        this.appendWorkspaceFile(change.path, content);
        break;
      case 'delete':
        // Note: delete requires explicit user approval (enforced upstream)
        this.deleteWorkspaceFile(change.path);
        break;
    }
  }

  private _requiresApproval(changes: FileChange[]): boolean {
    if (changes.some(change => change.action === 'delete')) { return true; }
    if (changes.length > 10) { return true; }
    for (const change of changes) {
      const content = typeof change.content === 'string' ? change.content : '';
      if (content && content.split('\n').length > 300) { return true; }
    }
    return false;
  }

  private _readExistingChangeTarget(relativePath: string): string | null {
    try {
      return this._readFile(relativePath)?.content.toString('utf8') ?? null;
    } catch {
      return null;
    }
  }

  private _createFocusedDiff(filePath: string, before: string, after: string): string[] {
    if (before === after) {
      return [`--- a/${filePath}`, `+++ b/${filePath}`, '@@ no content changes @@'];
    }

    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    let prefix = 0;
    while (
      prefix < beforeLines.length &&
      prefix < afterLines.length &&
      beforeLines[prefix] === afterLines[prefix]
    ) {
      prefix += 1;
    }

    let suffix = 0;
    while (
      suffix < beforeLines.length - prefix &&
      suffix < afterLines.length - prefix &&
      beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
    ) {
      suffix += 1;
    }

    const contextBefore = Math.max(0, prefix - 3);
    const beforeEnd = Math.max(prefix, beforeLines.length - suffix);
    const afterEnd = Math.max(prefix, afterLines.length - suffix);
    const beforeHunk = beforeLines.slice(contextBefore, beforeEnd + 3).slice(0, 120);
    const afterChanged = afterLines.slice(prefix, afterEnd).slice(0, 120);
    const leadingContext = beforeLines.slice(contextBefore, prefix).slice(-3);
    const trailingContext = beforeLines.slice(beforeEnd, Math.min(beforeEnd + 3, beforeLines.length));
    const omittedBefore = Math.max(0, beforeEnd - prefix - 120);
    const omittedAfter = Math.max(0, afterEnd - prefix - 120);

    const diff = [
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
      `@@ -${contextBefore + 1},${beforeHunk.length} +${contextBefore + 1},${leadingContext.length + afterChanged.length + trailingContext.length} @@`,
      ...leadingContext.map(line => ` ${line}`),
      ...beforeLines.slice(prefix, beforeEnd).slice(0, 120).map(line => `-${line}`),
      ...(omittedBefore > 0 ? [`-... (${omittedBefore} more removed lines)`] : []),
      ...afterChanged.map(line => `+${line}`),
      ...(omittedAfter > 0 ? [`+... (${omittedAfter} more added lines)`] : []),
      ...trailingContext.map(line => ` ${line}`),
    ];

    return diff;
  }
}
