import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { CommandPolicyConfig, TerminalRunResult } from '../types';
import { CommandPolicy, type CommandPolicyDecision } from './CommandPolicy';
import { DangerousCommandError, UserAbortError } from '../utils/errors';
import { logInfo, logWarn, logError } from '../utils/logging';

export class TerminalRunner {
  private readonly workspaceRoot: string;
  private readonly terminalLogPath: string;
  private readonly commandPolicy: CommandPolicy;
  private readonly activeProcesses = new Set<cp.ChildProcess>();
  private cancellationRequested = false;

  constructor(workspaceRoot: string, terminalLogPath: string, commandPolicyConfig?: Partial<CommandPolicyConfig>) {
    this.workspaceRoot = workspaceRoot;
    this.terminalLogPath = terminalLogPath;
    this.commandPolicy = new CommandPolicy(commandPolicyConfig);
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Check if a command is considered dangerous.
   */
  isDangerous(command: string): boolean {
    return this.commandPolicy.isDangerous(command);
  }

  /**
   * Check if a command is on the safe list.
   */
  isSafe(command: string): boolean {
    return this.commandPolicy.isSafe(command);
  }

  /**
   * Classify a command (safe / needs_approval / blocked) against the policy,
   * taking the workspace root into account for external-write detection. Lets
   * callers route risky commands through an approval prompt instead of failing.
   */
  evaluateCommand(command: string): CommandPolicyDecision {
    return this.commandPolicy.evaluate(command, this.workspaceRoot);
  }

  /**
   * Run a command if it is safe.
   * Throws DangerousCommandError if the command is dangerous (caller must get user approval first).
   */
  async runSafeCommand(command: string, timeoutMs: number = 120_000): Promise<TerminalRunResult> {
    const decision = this.commandPolicy.evaluate(command, this.workspaceRoot);
    if (decision.risk !== 'safe') {
      logWarn(`Command requires approval (${decision.reason}): ${command}`);
      throw new DangerousCommandError(command);
    }
    return this._run(command, timeoutMs);
  }

  /**
   * Run a command that has been explicitly approved by the user.
   */
  async runApprovedCommand(command: string, timeoutMs: number = 120_000): Promise<TerminalRunResult> {
    logInfo(`Running user-approved command: ${command}`);
    return this._run(command, timeoutMs);
  }

  /**
   * Stop any running terminal commands. This lets the extension Stop command
   * break out of long installs, tests, or native build probes quickly.
   */
  cancelActiveCommands(): void {
    if (this.activeProcesses.size === 0) { return; }
    this.cancellationRequested = true;
    for (const proc of this.activeProcesses) {
      try { proc.kill(); } catch { /* ignore */ }
    }
  }

  /**
   * Run common project commands (compile, test, lint).
   * These are always safe and never require approval.
   */
  async runCompile(packageManager: 'npm' | 'pnpm' | 'yarn' = 'npm'): Promise<TerminalRunResult> {
    const cmds: Record<string, string> = {
      npm: 'npm run compile',
      pnpm: 'pnpm run compile',
      yarn: 'yarn build',
    };
    return this._run(cmds[packageManager] ?? 'npm run compile');
  }

  async runTests(packageManager: 'npm' | 'pnpm' | 'yarn' = 'npm'): Promise<TerminalRunResult> {
    const cmds: Record<string, string> = {
      npm: 'npm test',
      pnpm: 'pnpm test',
      yarn: 'yarn test',
    };
    return this._run(cmds[packageManager] ?? 'npm test', 300_000);
  }

  async runLint(packageManager: 'npm' | 'pnpm' | 'yarn' = 'npm'): Promise<TerminalRunResult> {
    const cmds: Record<string, string> = {
      npm: 'npm run lint',
      pnpm: 'pnpm run lint',
      yarn: 'yarn lint',
    };
    return this._run(cmds[packageManager] ?? 'npm run lint');
  }

  hasPackageScript(scriptName: string): boolean {
    const packageJsonPath = path.join(this.workspaceRoot, 'package.json');
    if (!fs.existsSync(packageJsonPath)) { return false; }

    try {
      const raw = fs.readFileSync(packageJsonPath, 'utf8');
      const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
      return typeof parsed.scripts?.[scriptName] === 'string';
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private _run(command: string, timeoutMs: number = 120_000): Promise<TerminalRunResult> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      logInfo(`Terminal: ${command}`);

      const proc = cp.exec(command, {
        cwd: this.workspaceRoot,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
      });
      this.activeProcesses.add(proc);

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (result: TerminalRunResult) => {
        if (settled) { return; }
        settled = true;
        this.activeProcesses.delete(proc);
        if (this.activeProcesses.size === 0) {
          this.cancellationRequested = false;
        }

        if (!result.success) {
          logWarn(`Command failed (exit ${result.exitCode}): ${command}`);
        }

        this._appendToLog(result);
        if (result.error === 'Command cancelled by user.') {
          reject(new UserAbortError());
          return;
        }
        resolve(result);
      };

      proc.stdout?.on('data', (chunk: string) => { stdout += chunk; });
      proc.stderr?.on('data', (chunk: string) => { stderr += chunk; });

      proc.on('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
        const durationMs = Date.now() - startTime;
        const code = exitCode ?? -1;
        const cancelled = this.cancellationRequested && signal !== null;
        const success = code === 0 && !cancelled;

        const result: TerminalRunResult = {
          command,
          exitCode: code,
          stdout,
          stderr,
          durationMs,
          success,
          error: cancelled ? 'Command cancelled by user.' : undefined,
        };

        finish(result);
      });

      proc.on('error', (err: Error) => {
        const durationMs = Date.now() - startTime;
        const result: TerminalRunResult = {
          command,
          exitCode: -1,
          stdout,
          stderr,
          durationMs,
          success: false,
          error: err.message,
        };

        logError(`Terminal error: ${err.message}`);
        finish(result);
      });
    });
  }

  private _appendToLog(result: TerminalRunResult): void {
    try {
      const separator = '─'.repeat(60);
      const entry =
        `\n${separator}\n` +
        `Command : ${result.command}\n` +
        `Exit    : ${result.exitCode}\n` +
        `Duration: ${result.durationMs}ms\n` +
        `Time    : ${new Date().toISOString()}\n` +
        (result.stdout ? `STDOUT:\n${result.stdout}\n` : '') +
        (result.stderr ? `STDERR:\n${result.stderr}\n` : '') +
        (result.error  ? `ERROR:\n${result.error}\n`   : '') +
        `${separator}\n`;

      const logDir = path.dirname(this.terminalLogPath);
      if (!fs.existsSync(logDir)) { fs.mkdirSync(logDir, { recursive: true }); }
      fs.appendFileSync(this.terminalLogPath, entry, 'utf8');
    } catch {
      // Non-fatal
    }
  }

  /**
   * Detect what package manager is used in the current project.
   */
  detectPackageManager(): 'npm' | 'pnpm' | 'yarn' {
    if (fs.existsSync(path.join(this.workspaceRoot, 'pnpm-lock.yaml'))) { return 'pnpm'; }
    if (fs.existsSync(path.join(this.workspaceRoot, 'yarn.lock')))      { return 'yarn'; }
    return 'npm';
  }
}
