import * as cp from 'child_process';
import type { GitCommitSummary, GitRepositorySnapshot, GitStatusFile } from '../types';

interface GitRunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export class GitRepositoryReader {
  constructor(private readonly workspaceRoot: string) {}

  async readSnapshot(): Promise<GitRepositorySnapshot> {
    const generatedAt = new Date().toISOString();
    const warnings: string[] = [];

    const inside = await this.runGit(['rev-parse', '--is-inside-work-tree']);
    if (!inside.success || inside.stdout.trim() !== 'true') {
      return {
        generatedAt,
        workspaceRoot: this.workspaceRoot,
        isRepository: false,
        changedFiles: [],
        changedFileCount: 0,
        untrackedFileCount: 0,
        recentCommits: [],
        warnings,
        error: this.describeGitFailure(inside, 'Workspace is not inside a Git repository.'),
      };
    }

    const repositoryRoot = await this.readOptional(['rev-parse', '--show-toplevel'], warnings);
    const branch = await this.readOptional(['branch', '--show-current'], warnings);
    const head = await this.readOptional(['rev-parse', '--short', 'HEAD'], warnings);
    const status = await this.readOptional(
      ['status', '--porcelain=v1', '--branch', '--untracked-files=all'],
      warnings
    );
    const recentCommitsRaw = await this.readOptional(
      ['log', '-5', '--pretty=format:%h%x09%an%x09%ad%x09%s', '--date=short'],
      warnings
    );
    const unstagedDiffStat = await this.readOptional(['diff', '--no-ext-diff', '--stat', '--'], warnings);
    const stagedDiffStat = await this.readOptional(['diff', '--cached', '--no-ext-diff', '--stat', '--'], warnings);

    const statusLines = status.split(/\r?\n/).filter(Boolean);
    const branchStatus = statusLines.find(line => line.startsWith('##'));
    const changedFiles = statusLines
      .filter(line => !line.startsWith('##'))
      .map(line => this.parseStatusLine(line));

    return {
      generatedAt,
      workspaceRoot: this.workspaceRoot,
      isRepository: true,
      repositoryRoot: repositoryRoot || undefined,
      branch: branch || this.branchFromStatus(branchStatus),
      head: head || undefined,
      branchStatus,
      ...this.parseAheadBehind(branchStatus),
      changedFiles,
      changedFileCount: changedFiles.length,
      untrackedFileCount: changedFiles.filter(file => file.rawStatus === '??').length,
      recentCommits: this.parseCommits(recentCommitsRaw),
      unstagedDiffStat: unstagedDiffStat || undefined,
      stagedDiffStat: stagedDiffStat || undefined,
      warnings,
    };
  }

  private async readOptional(args: string[], warnings: string[]): Promise<string> {
    const result = await this.runGit(args);
    if (!result.success) {
      warnings.push(this.describeGitFailure(result, `git ${args.join(' ')} failed.`));
      return '';
    }
    return result.stdout.trim();
  }

  private runGit(args: string[]): Promise<GitRunResult> {
    return new Promise(resolve => {
      cp.execFile('git', args, {
        cwd: this.workspaceRoot,
        timeout: 15_000,
        maxBuffer: 512 * 1024,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          LC_ALL: 'C',
        },
      }, (error, stdout, stderr) => {
        resolve({
          success: !error,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          error: error?.message,
        });
      });
    });
  }

  private parseStatusLine(line: string): GitStatusFile {
    const rawStatus = line.slice(0, 2);
    const fileText = line.slice(3);
    const renameParts = fileText.split(' -> ');
    const pathText = renameParts[renameParts.length - 1] || fileText;
    const originalPath = renameParts.length > 1 ? renameParts[0] : undefined;

    return {
      path: this.normalizeGitPath(pathText),
      rawStatus,
      indexStatus: rawStatus.charAt(0).trim() || ' ',
      workingTreeStatus: rawStatus.charAt(1).trim() || ' ',
      originalPath: originalPath ? this.normalizeGitPath(originalPath) : undefined,
    };
  }

  private parseCommits(raw: string): GitCommitSummary[] {
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        const [hash = '', author = '', date = '', ...subjectParts] = line.split('\t');
        return {
          hash,
          author,
          date,
          subject: subjectParts.join('\t'),
        };
      })
      .filter(commit => commit.hash.length > 0);
  }

  private parseAheadBehind(branchStatus?: string): Pick<GitRepositorySnapshot, 'ahead' | 'behind'> {
    if (!branchStatus) { return {}; }
    const aheadMatch = /\bahead (\d+)/.exec(branchStatus);
    const behindMatch = /\bbehind (\d+)/.exec(branchStatus);
    return {
      ahead: aheadMatch ? Number(aheadMatch[1]) : undefined,
      behind: behindMatch ? Number(behindMatch[1]) : undefined,
    };
  }

  private branchFromStatus(branchStatus?: string): string | undefined {
    if (!branchStatus) { return undefined; }
    const clean = branchStatus.replace(/^##\s*/, '');
    if (clean.startsWith('No commits yet on ')) {
      return clean.replace('No commits yet on ', '').trim() || undefined;
    }
    return clean.split('...')[0]?.trim() || undefined;
  }

  private normalizeGitPath(value: string): string {
    return value
      .trim()
      .replace(/^"|"$/g, '')
      .replace(/\\/g, '/');
  }

  private describeGitFailure(result: GitRunResult, fallback: string): string {
    return (result.stderr || result.error || fallback).trim();
  }
}
