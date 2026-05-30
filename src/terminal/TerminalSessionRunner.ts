import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { CommandPolicyConfig, TerminalSessionResult } from '../types';
import { CommandPolicy } from './CommandPolicy';
import { DangerousCommandError } from '../utils/errors';

interface ActiveSession {
  id: string;
  command: string;
  process: cp.ChildProcess;
  startedAt: string;
  stdout: string;
  stderr: string;
}

export class TerminalSessionRunner {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly policy: CommandPolicy;

  constructor(
    private readonly workspaceRoot: string,
    private readonly logDir: string,
    policyConfig?: Partial<CommandPolicyConfig>
  ) {
    this.policy = new CommandPolicy(policyConfig);
  }

  start(command: string): string {
    const decision = this.policy.evaluate(command, this.workspaceRoot);
    if (decision.risk !== 'safe') {
      throw new DangerousCommandError(command);
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const proc = cp.exec(command, {
      cwd: this.workspaceRoot,
      maxBuffer: 10 * 1024 * 1024,
    });

    const session: ActiveSession = {
      id,
      command,
      process: proc,
      startedAt: new Date().toISOString(),
      stdout: '',
      stderr: '',
    };
    this.sessions.set(id, session);

    proc.stdout?.on('data', chunk => {
      session.stdout += String(chunk);
      this._appendSessionLog(id, String(chunk));
    });
    proc.stderr?.on('data', chunk => {
      session.stderr += String(chunk);
      this._appendSessionLog(id, String(chunk));
    });
    proc.on('close', () => {
      this._appendSessionLog(id, `\n[session closed at ${new Date().toISOString()}]\n`);
    });

    return id;
  }

  read(sessionId: string, maxChars = 12_000): string {
    const session = this.sessions.get(sessionId);
    if (!session) { return ''; }
    const combined = `${session.stdout}\n${session.stderr}`.trim();
    return combined.length > maxChars ? combined.slice(-maxChars) : combined;
  }

  stop(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) { return false; }
    try {
      session.process.kill();
    } catch {
      // Non-fatal: the process may already be gone.
    }
    this.sessions.delete(sessionId);
    return true;
  }

  async runFor(command: string, durationMs: number): Promise<TerminalSessionResult> {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const sessionId = this.start(command);
    await new Promise(resolve => setTimeout(resolve, durationMs));
    const output = this.read(sessionId);
    const stopped = this.stop(sessionId);
    const endedAt = new Date().toISOString();
    return {
      sessionId,
      startedAt,
      endedAt,
      timedOut: stopped,
      command,
      exitCode: stopped ? 124 : 0,
      stdout: output,
      stderr: '',
      durationMs: Date.now() - started,
      success: true,
    };
  }

  stopAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.stop(id);
    }
  }

  private _appendSessionLog(sessionId: string, chunk: string): void {
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
      fs.appendFileSync(path.join(this.logDir, `session-${sessionId}.log`), chunk, 'utf8');
    } catch {
      // Logging is best-effort.
    }
  }
}
