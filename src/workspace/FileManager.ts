import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { FileChange, FileSnapshot, PatchResult } from '../types';
import { logInfo, logWarn } from '../utils/logging';

// -----------------------------------------------------------------------
// FileManager: safe file operations within the workspace
// -----------------------------------------------------------------------
export class FileManager {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  // ------------------------------------------------------------------
  // Core read / write
  // ------------------------------------------------------------------

  readWorkspaceFile(relativePath: string): string | null {
    const fullPath = this._resolve(relativePath);
    if (!fs.existsSync(fullPath)) { return null; }
    try {
      return fs.readFileSync(fullPath, 'utf8');
    } catch (err) {
      logWarn(`Could not read file "${relativePath}": ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  writeWorkspaceFile(relativePath: string, content: string): void {
    const fullPath = this._resolve(relativePath);
    this.ensureDirectory(path.dirname(fullPath));
    fs.writeFileSync(fullPath, content, 'utf8');
    logInfo(`Wrote file: ${relativePath}`);
  }

  appendWorkspaceFile(relativePath: string, content: string): void {
    const fullPath = this._resolve(relativePath);
    this.ensureDirectory(path.dirname(fullPath));
    fs.appendFileSync(fullPath, content, 'utf8');
  }

  ensureDirectory(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
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

    const content = fs.readFileSync(fullPath);
    return {
      path: normalizedPath,
      exists: true,
      capturedAt: new Date().toISOString(),
      hash: createHash('sha256').update(content).digest('hex'),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
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
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
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
    const patchDir = path.join(this.workspaceRoot, '.agent-workspace', 'patches');
    this.ensureDirectory(patchDir);
    const patchFile = path.join(patchDir, `${patchId}.md`);
    fs.writeFileSync(patchFile, preview, 'utf8');
    return patchFile;
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private _resolve(relativePath: string): string {
    // Prevent path traversal outside workspace
    const resolved = path.resolve(this.workspaceRoot, relativePath);
    const relative = path.relative(this.workspaceRoot, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Path traversal attempt: "${relativePath}" is outside the workspace.`);
    }
    return resolved;
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
        this.ensureDirectory(path.dirname(fullPath));
        fs.writeFileSync(fullPath, content, 'utf8');
        break;
      case 'append':
        this.ensureDirectory(path.dirname(fullPath));
        fs.appendFileSync(fullPath, content, 'utf8');
        break;
      case 'delete':
        // Note: delete requires explicit user approval (enforced upstream)
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
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
      const fullPath = this._resolve(relativePath);
      if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) { return null; }
      return fs.readFileSync(fullPath, 'utf8');
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
