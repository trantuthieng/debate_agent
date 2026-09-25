import * as fs from 'fs';
import { writeFileAtomic } from '../utils/atomicFile';

interface RunLockPayload {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
}

/**
 * Tracks whether a live process currently owns this workspace's workflow.
 *
 * A hard process kill (OOM-kill, SIGBUS, an extension-host crash) leaves
 * `project_state.json` stuck at `status: 'running'` forever — nothing gets a
 * chance to mark it `'failed'`. `resume()` used to refuse to touch a
 * `'running'` status at all, which is exactly backwards for the crash this
 * lock exists to detect: it lets `resume()` tell "orphaned by a crash" (no
 * live owner, or a stale heartbeat) apart from "a second window is
 * legitimately running this same project right now" (a live, freshly
 * heartbeating pid), so only the former is safe to reclaim automatically.
 */
export class RunLock {
  constructor(
    private readonly lockPath: string,
    private readonly staleMs = 90_000
  ) {}

  acquire(): void {
    this._write();
  }

  heartbeat(): void {
    this._write();
  }

  /** Only removes the lock if it still belongs to this process. */
  release(): void {
    const payload = this._read();
    if (payload && payload.pid === process.pid) {
      try { fs.unlinkSync(this.lockPath); } catch { /* already gone — nothing to clean up */ }
    }
  }

  /**
   * True when there is no live process behind this lock: missing, corrupt,
   * an owning pid that is no longer running, or a heartbeat older than
   * `staleMs`. False only for a lock with a live pid and a fresh heartbeat.
   */
  isStale(): boolean {
    const payload = this._read();
    if (!payload) { return true; }
    if (!this._isPidAlive(payload.pid)) { return true; }
    const heartbeatAt = Date.parse(payload.heartbeatAt);
    if (!Number.isFinite(heartbeatAt)) { return true; }
    return Date.now() - heartbeatAt > this.staleMs;
  }

  private _write(): void {
    const now = new Date().toISOString();
    const existing = this._read();
    const payload: RunLockPayload = {
      pid: process.pid,
      startedAt: existing?.pid === process.pid ? existing.startedAt : now,
      heartbeatAt: now,
    };
    writeFileAtomic(this.lockPath, JSON.stringify(payload));
  }

  private _read(): RunLockPayload | null {
    try {
      const raw = fs.readFileSync(this.lockPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<RunLockPayload>;
      if (typeof parsed.pid !== 'number' || typeof parsed.heartbeatAt !== 'string') { return null; }
      return parsed as RunLockPayload;
    } catch {
      return null;
    }
  }

  private _isPidAlive(pid: number): boolean {
    try {
      // Signal 0 sends nothing; it only checks whether the pid exists and is
      // ours to signal. Throws ESRCH (dead) or EPERM (alive, owned by another
      // user — still "alive" for our purposes).
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException)?.code === 'EPERM';
    }
  }
}
