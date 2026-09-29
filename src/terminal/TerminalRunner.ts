import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { CommandPolicyConfig, TerminalRunResult } from '../types';
import { CommandPolicy, type CommandPolicyDecision } from './CommandPolicy';
import { DangerousCommandError, UserAbortError } from '../utils/errors';
import { logInfo, logWarn, logError } from '../utils/logging';

const MAX_OUTPUT_CHARS = 1_000_000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const TERMINATION_GRACE_MS = 1_000;

export class TerminalRunner {
  private readonly workspaceRoot: string;
  private readonly terminalLogPath: string;
  private readonly commandPolicy: CommandPolicy;
  private readonly activeProcesses = new Map<cp.ChildProcess, () => void>();

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
    for (const cancel of this.activeProcesses.values()) { cancel(); }
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

      // A distinct process group lets Stop/timeout reach the shell's children
      // (npm, test runners, servers), including those that ignore SIGTERM.
      const proc = cp.spawn(command, {
        cwd: this.workspaceRoot,
        shell: true,
        detached: process.platform !== 'win32',
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let settled = false;
      let closed = false;
      let exitCode: number | null = null;
      let processError: string | undefined;
      let termination: 'cancelled' | 'timeout' | undefined;
      let cleanupComplete = false;
      let timeout: NodeJS.Timeout | undefined;
      let escalation: NodeJS.Timeout | undefined;
      let cleanupDeadline: NodeJS.Timeout | undefined;

      const finish = (): void => {
        if (settled) { return; }
        if (termination && !cleanupComplete) { return; }
        if (!closed && !processError) { return; }
        settled = true;
        clearTimeout(timeout);
        clearTimeout(escalation);
        clearTimeout(cleanupDeadline);
        this.activeProcesses.delete(proc);
        const output = (value: string, truncated: boolean): string => truncated
          ? '[Output truncated; showing the final output.]\n' + value : value;
        const result: TerminalRunResult = {
          command,
          exitCode: termination === 'timeout' ? 124 : termination ? -1 : exitCode ?? -1,
          stdout: output(stdout, stdoutTruncated),
          stderr: output(stderr, stderrTruncated),
          durationMs: Date.now() - startTime,
          success: !termination && !processError && exitCode === 0,
          error: termination === 'cancelled' ? 'Command cancelled by user.'
            : termination === 'timeout' ? `Command timed out after ${timeoutMs}ms.` : processError,
        };

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

      const signalTree = (signal: NodeJS.Signals): void => {
        if (!proc.pid) { return; }
        if (process.platform === 'win32') {
          // taskkill owns the tree traversal on Windows; /F also handles a
          // child that will not cooperate with a graceful termination request.
          const killer = cp.spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
          killer.on('error', () => { try { proc.kill(signal); } catch { /* already exited */ } });
          killer.unref();
        } else {
          try { process.kill(-proc.pid, signal); } catch { /* owned group already exited */ }
        }
      };
      const terminate = (reason: 'cancelled' | 'timeout'): void => {
        if (settled || termination) { return; }
        termination = reason;
        clearTimeout(timeout);
        signalTree('SIGTERM');
        // Do not settle on shell close until the escalation has reached its
        // descendants too: some children close their pipes and ignore TERM.
        escalation = setTimeout(() => {
          signalTree('SIGKILL');
          cleanupComplete = true;
          finish();
          if (!settled) {
            cleanupDeadline = setTimeout(() => {
              // Bound completion even if a separately detached descendant has
              // inherited the pipes. Only our owned group is signalled above.
              proc.stdout?.destroy();
              proc.stderr?.destroy();
              closed = true;
              finish();
            }, TERMINATION_GRACE_MS);
          }
        }, TERMINATION_GRACE_MS);
      };
      this.activeProcesses.set(proc, () => terminate('cancelled'));
      if (timeoutMs > 0) { timeout = setTimeout(() => terminate('timeout'), timeoutMs); }

      proc.stdout?.setEncoding('utf8');
      proc.stderr?.setEncoding('utf8');
      proc.stdout?.on('data', (chunk: string) => {
        stdoutTruncated ||= stdout.length + chunk.length > MAX_OUTPUT_CHARS;
        stdout = (stdout + chunk).slice(-MAX_OUTPUT_CHARS);
      });
      proc.stderr?.on('data', (chunk: string) => {
        stderrTruncated ||= stderr.length + chunk.length > MAX_OUTPUT_CHARS;
        stderr = (stderr + chunk).slice(-MAX_OUTPUT_CHARS);
      });

      proc.on('close', (code: number | null) => {
        closed = true;
        exitCode = code;
        finish();
      });

      proc.on('error', (err: Error) => {
        processError = err.message;
        logError(`Terminal error: ${err.message}`);
        finish();
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
      const bytes = Buffer.from(entry, 'utf8');
      const currentSize = fs.existsSync(this.terminalLogPath) ? fs.statSync(this.terminalLogPath).size : 0;
      if (currentSize + bytes.length > MAX_LOG_BYTES) {
        // Rotate in place rather than growing a second, unbounded history.
        const marker = Buffer.from('[Earlier terminal log output truncated.]\n');
        fs.writeFileSync(this.terminalLogPath, Buffer.concat([marker, bytes.subarray(-MAX_LOG_BYTES + marker.length)]));
      } else {
        fs.appendFileSync(this.terminalLogPath, bytes);
      }
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
