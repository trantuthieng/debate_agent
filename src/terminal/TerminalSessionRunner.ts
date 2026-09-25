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
  closed: boolean;
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
    // Own a process group, not just the shell: npm spawns a server grandchild.
    const proc = cp.spawn(command, {
      cwd: this.workspaceRoot,
      shell: true,
      detached: process.platform !== 'win32',
    });

    const session: ActiveSession = {
      id,
      command,
      process: proc,
      startedAt: new Date().toISOString(),
      stdout: '',
      stderr: '',
      closed: false,
    };
    this.sessions.set(id, session);

    proc.stdout?.on('data', chunk => {
      session.stdout = (session.stdout + String(chunk)).slice(-1_000_000);
      this._appendSessionLog(id, String(chunk));
    });
    proc.stderr?.on('data', chunk => {
      session.stderr = (session.stderr + String(chunk)).slice(-1_000_000);
      this._appendSessionLog(id, String(chunk));
    });
    proc.on('close', () => {
      session.closed = true;
      this._appendSessionLog(id, `\n[session closed at ${new Date().toISOString()}]\n`);
    });
    proc.on('error', error => {
      session.closed = true;
      session.stderr += `\n${error.message}`;
    });

    return id;
  }

  read(sessionId: string, maxChars = 12_000): string {
    const session = this.sessions.get(sessionId);
    if (!session) { return ''; }
    const combined = `${session.stdout}\n${session.stderr}${session.closed ? '\n[session closed]' : ''}`.trim();
    return combined.length > maxChars ? combined.slice(-maxChars) : combined;
  }

  stop(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) { return false; }
    try {
      if (session.process.pid && process.platform !== 'win32') {
        process.kill(-session.process.pid, 'SIGTERM');
        // Escalate only the group owned by this session if descendants ignore TERM.
        const groupId = session.process.pid;
        const timer = setTimeout(() => { try { process.kill(-groupId, 'SIGKILL'); } catch { /* exited */ } }, 2_000);
        timer.unref();
      } else if (session.process.pid) {
        cp.spawn('taskkill', ['/pid', String(session.process.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
      } else { session.process.kill(); }
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
