import * as fs from 'fs';
import * as path from 'path';
import type { FileChange, PatchResult } from '../types';

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
  constructor(private readonly workspaceRoot: string) {}

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

    const errors: string[] = [];
    for (const change of patchChanges) {
      try {
        const parsed = this.parse(change.patch!, change.path);
        for (const filePatch of parsed) {
          this._applyParsedPatch(filePatch);
        }
      } catch (err) {
        errors.push(`${change.path}: ${err instanceof Error ? err.message : String(err)}`);
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

  private _applyParsedPatch(filePatch: ParsedPatchFile): void {
    const fullPath = this._resolve(filePatch.path);
    const existing = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : '';
    let lines = existing.split('\n');
    let offset = 0;

    for (const hunk of filePatch.hunks) {
      const targetIndex = Math.max(0, hunk.oldStart - 1 + offset);
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

      const currentSlice = lines.slice(targetIndex, targetIndex + oldLines.length);
      if (currentSlice.join('\n') !== oldLines.join('\n')) {
        throw new Error(`Hunk context mismatch at line ${hunk.oldStart}.`);
      }

      lines = [
        ...lines.slice(0, targetIndex),
        ...newLines,
        ...lines.slice(targetIndex + oldLines.length),
      ];
      offset += newLines.length - oldLines.length;
    }

    const content = lines.join('\n');
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, content, 'utf8');
  }

  private _resolve(relativePath: string): string {
    const resolved = path.resolve(this.workspaceRoot, this._normalizePath(relativePath));
    const relative = path.relative(this.workspaceRoot, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Patch path is outside the workspace: ${relativePath}`);
    }
    return resolved;
  }

  private _normalizePath(value: string): string {
    return value.replace(/^a\//, '').replace(/^b\//, '').replace(/\\/g, '/');
  }
}
