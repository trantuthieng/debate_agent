import * as fs from 'fs';
import * as path from 'path';
import type { FileChange, PatchResult } from '../types';
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
      if (change.content !== undefined) {
        const ext = path.extname(change.path).replace('.', '') || 'text';
        lines.push('```' + ext);
        // Show first 100 lines to keep preview manageable
        const rawContent = typeof change.content === 'string' ? change.content : String(change.content ?? '');
        const contentLines = rawContent.split('\n');
        if (contentLines.length > 100) {
          lines.push(...contentLines.slice(0, 100));
          lines.push(`\n... (${contentLines.length - 100} more lines) ...`);
        } else {
          lines.push(change.content);
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
}
