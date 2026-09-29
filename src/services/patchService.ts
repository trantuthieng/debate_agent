import * as path from 'path';
import type { FileChange, PatchResult } from '../types';
import { FileManager } from '../workspace/FileManager';

interface ParsedPatchFile {
  path: string;
  hunks: ParsedHunk[];
}

interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

export class PatchService {
  private readonly fileManager: FileManager;

  constructor(private readonly workspaceRoot: string) {
    this.fileManager = new FileManager(workspaceRoot);
  }

  hasUnifiedPatch(changes: FileChange[]): boolean {
    return changes.some(change => typeof change.patch === 'string' && change.patch.trim().length > 0);
  }

  applyFileChanges(changes: FileChange[]): PatchResult {
    const patchChanges = changes.filter(change => change.patch?.trim());
    if (patchChanges.length === 0) {
      return {
        applied: false,
        approved: true,
        targetFiles: changes.map(change => change.path),
        preview: '',
        error: 'No unified patch changes were provided.',
      };
    }

    // Compute every resulting file in memory first. Only commit to disk if ALL
    // patches apply cleanly. Filesystem failures while committing can still leave
    // a partially written batch; this is not a multi-file atomic transaction.
    const errors: string[] = [];
    const pendingWrites = new Map<string, string>();
    for (const change of patchChanges) {
      try {
        const parsed = this.parse(change.patch!, change.path);
        for (const filePatch of parsed) {
          const { fullPath, content } = this._computePatchedContent(filePatch, pendingWrites);
          pendingWrites.set(fullPath, content);
        }
      } catch (err) {
        errors.push(`${change.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (errors.length === 0) {
      for (const [fullPath, content] of pendingWrites) {
        try { this.fileManager.writeWorkspaceFile(fullPath, content); }
        catch (err) {
          errors.push(`${fullPath}: ${err instanceof Error ? err.message : String(err)}`);
          break;
        }
      }
    }

    return {
      applied: errors.length === 0,
      approved: true,
      targetFiles: patchChanges.map(change => change.path),
      preview: patchChanges.map(change => change.patch).join('\n\n'),
      error: errors.length > 0 ? errors.join('\n') : undefined,
    };
  }

  parse(rawPatch: string, fallbackPath: string): ParsedPatchFile[] {
    const lines = rawPatch.split(/\r?\n/);
    const files: ParsedPatchFile[] = [];
    let current: ParsedPatchFile | null = null;
    let currentHunk: ParsedHunk | null = null;

    for (const line of lines) {
      const fileMatch = /^\+\+\+\s+b\/(.+)$/.exec(line) ?? /^\+\+\+\s+(.+)$/.exec(line);
      if (fileMatch) {
        current = { path: this._normalizePath(fileMatch[1] === '/dev/null' ? fallbackPath : fileMatch[1]), hunks: [] };
        files.push(current);
        currentHunk = null;
        continue;
      }

      const hunkMatch = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
      if (hunkMatch) {
        if (!current) {
          current = { path: this._normalizePath(fallbackPath), hunks: [] };
          files.push(current);
        }
        currentHunk = {
          oldStart: Number(hunkMatch[1]),
          oldCount: Number(hunkMatch[2] ?? '1'),
          newStart: Number(hunkMatch[3]),
          newCount: Number(hunkMatch[4] ?? '1'),
          lines: [],
        };
        current.hunks.push(currentHunk);
        continue;
      }

      if (currentHunk && /^[ +\-\\]/.test(line)) {
        currentHunk.lines.push(line);
      }
    }

    if (files.length === 0) {
      throw new Error('Patch does not contain any file headers.');
    }
    return files;
  }

  createUnifiedPatch(change: FileChange, before: string | null): string {
    const after = change.action === 'delete'
      ? ''
      : String(change.content ?? '');
    const beforeLines = (before ?? '').split('\n');
    const afterLines = after.split('\n');
    const oldCount = before === null ? 0 : beforeLines.length;
    const newCount = afterLines.length;
    return [
      `--- a/${change.path}`,
      `+++ b/${change.path}`,
      `@@ -1,${oldCount} +1,${newCount} @@`,
      ...beforeLines.map(line => `-${line}`),
      ...afterLines.map(line => `+${line}`),
    ].join('\n');
  }

  private _computePatchedContent(
    filePatch: ParsedPatchFile,
    pendingWrites: Map<string, string>
  ): { fullPath: string; content: string } {
    const fullPath = this._resolve(filePatch.path);
    // Honour earlier hunks staged for the same file in this batch.
    const existing = pendingWrites.has(fullPath)
      ? pendingWrites.get(fullPath)!
      : this.fileManager.readWorkspaceFile(fullPath) ?? '';
    let lines = existing.split('\n');
    let offset = 0;

    for (const hunk of filePatch.hunks) {
      let targetIndex = Math.max(0, hunk.oldStart - 1 + offset);
      const oldLines: string[] = [];
      const newLines: string[] = [];

      for (const line of hunk.lines) {
        const marker = line[0];
        const content = line.slice(1);
        if (marker === ' ' || marker === '-') {
          oldLines.push(content);
        }
        if (marker === ' ' || marker === '+') {
          newLines.push(content);
        }
      }

      const expected = oldLines.join('\n');
      const matchesAt = (idx: number): boolean =>
        lines.slice(idx, idx + oldLines.length).join('\n') === expected;

      // Local models routinely emit unified diffs whose @@ line numbers have
      // drifted from the real file (stale context, edits elsewhere). Rather
      // than fail the whole patch on an off-by-N, locate the context block
      // anywhere in the file and apply there. Pure insertions (no old lines)
      // keep the declared position. Only a genuinely absent context throws.
      if (oldLines.length > 0 && !matchesAt(targetIndex)) {
        let found = -1;
        for (let i = 0; i + oldLines.length <= lines.length; i++) {
          if (matchesAt(i)) { found = i; break; }
        }
        if (found === -1) {
          throw new Error(`Hunk context mismatch at line ${hunk.oldStart}.`);
        }
        targetIndex = found;
      }

      lines = [
        ...lines.slice(0, targetIndex),
        ...newLines,
        ...lines.slice(targetIndex + oldLines.length),
      ];
      offset += newLines.length - oldLines.length;
    }

    return { fullPath, content: lines.join('\n') };
  }

  private _resolve(relativePath: string): string {
    const resolved = path.resolve(this.workspaceRoot, this._normalizePath(relativePath));
    const relative = path.relative(this.workspaceRoot, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Patch path is outside the workspace: ${relativePath}`);
    }
    this.fileManager.fileExists(resolved); // Validate parents and final symlinks even for a new target.
    return resolved;
  }

  private _normalizePath(value: string): string {
    return value.replace(/^a\//, '').replace(/^b\//, '').replace(/\\/g, '/');
  }
}
