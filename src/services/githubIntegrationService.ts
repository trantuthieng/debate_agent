import * as cp from 'child_process';
import type { GitHubIntegrationConfig, GitHubRepositoryContext } from '../types';

export class GitHubIntegrationService {
  constructor(
    private readonly workspaceRoot: string,
    private readonly config?: Partial<GitHubIntegrationConfig>
  ) {}

  async readContext(): Promise<GitHubRepositoryContext> {
    const cfg = {
      enabled: true,
      preferGhCli: true,
      ...this.config,
    };
    const generatedAt = new Date().toISOString();
    const warnings: string[] = [];

    if (!cfg.enabled) {
      return { generatedAt, available: false, warnings: ['GitHub integration disabled.'] };
    }

    const remote = await this._runGit(['config', '--get', 'remote.origin.url']);
    const branch = await this._runGit(['branch', '--show-current']);
    if (!remote.success || !remote.stdout.trim()) {
      return {
        generatedAt,
        available: false,
        currentBranch: branch.stdout.trim() || undefined,
        warnings: ['No remote.origin.url found.'],
      };
    }

    const parsed = this._parseGitHubRemote(remote.stdout.trim());
    if (!parsed) {
      return {
        generatedAt,
        available: false,
        remoteUrl: remote.stdout.trim(),
        currentBranch: branch.stdout.trim() || undefined,
        warnings: ['origin remote is not a GitHub repository URL.'],
      };
    }

    let pullRequestNumber: number | undefined;
    if (cfg.preferGhCli) {
      const pr = await this._runGh(['pr', 'view', '--json', 'number', '--jq', '.number']);
      if (pr.success && /^\d+$/.test(pr.stdout.trim())) {
        pullRequestNumber = Number(pr.stdout.trim());
      } else if (pr.stderr.trim() || pr.error) {
        warnings.push(`gh pr view unavailable: ${((pr.stderr || pr.error) ?? '').trim()}`);
      }
    }

    return {
      generatedAt,
      available: true,
      remoteUrl: remote.stdout.trim(),
      owner: parsed.owner,
      repo: parsed.repo,
      currentBranch: branch.stdout.trim() || undefined,
      pullRequestNumber,
      warnings,
    };
  }

  private _parseGitHubRemote(remote: string): { owner: string; repo: string } | null {
    const https = /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/.exec(remote);
    if (https) {
      return { owner: https[1], repo: https[2].replace(/\.git$/, '') };
    }
    const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(remote);
    if (ssh) {
      return { owner: ssh[1], repo: ssh[2].replace(/\.git$/, '') };
    }
    return null;
  }

  private _runGit(args: string[]): Promise<{ success: boolean; stdout: string; stderr: string; error?: string }> {
    return this._execFile('git', args);
  }

  private _runGh(args: string[]): Promise<{ success: boolean; stdout: string; stderr: string; error?: string }> {
    return this._execFile('gh', args);
  }

  private _execFile(command: string, args: string[]): Promise<{ success: boolean; stdout: string; stderr: string; error?: string }> {
    return new Promise(resolve => {
      cp.execFile(command, args, {
        cwd: this.workspaceRoot,
        timeout: 15_000,
        maxBuffer: 512 * 1024,
        env: {
          ...process.env,
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
}
