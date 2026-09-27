import * as fs from 'fs';
import * as crypto from 'crypto';
import { writeFileAtomic } from '../utils/atomicFile';
import { isLockPidAlive, withFileLockMutation, retireLockToken, forgetRetiredLockToken, isRetiredLockToken } from '../utils/fileLockMutation';

interface RunLockPayload {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  token?: string;
}

/** A live PID owns its run until release or death; heartbeat age is diagnostic. */
export class RunLock {
  private token: string | undefined;
  private released = false;

  constructor(private readonly lockPath: string, _staleMs = 90_000) {}

  acquire(): void {
    const result = withFileLockMutation(this.lockPath, () => {
      const existing = this._read();
      if (existing && isLockPidAlive(existing.pid) && !isRetiredLockToken(this.lockPath, existing)) {
        throw new Error(`Workflow lock is already held by pid ${existing.pid}.`);
      }
      const now = new Date().toISOString();
      const token = crypto.randomBytes(16).toString('hex');
      writeFileAtomic(this.lockPath, JSON.stringify({ pid: process.pid, startedAt: now, heartbeatAt: now, token }));
      if (existing?.token) { forgetRetiredLockToken(this.lockPath, existing.token); }
      this.token = token;
      this.released = false;
    });
    if (!result.acquired) { throw new Error('Workflow lock ownership is being changed by another process.'); }
  }

  /** A transient timer write failure must not crash the extension host. */
  heartbeat(): void {
    if (!this.token || this.released) { return; }
    try {
      withFileLockMutation(this.lockPath, () => {
        const existing = this._read();
        if (existing?.token !== this.token) { return; }
        writeFileAtomic(this.lockPath, JSON.stringify({ ...existing, heartbeatAt: new Date().toISOString() }));
      });
    } catch { /* live PID still prevents takeover; retry on the next tick */ }
  }

  release(): void {
    if (!this.token) { return; }
    this.released = true;
    const token = this.token;
    retireLockToken(this.lockPath, token);
    try {
      withFileLockMutation(this.lockPath, () => {
        if (this._read()?.token === token) { fs.unlinkSync(this.lockPath); }
        forgetRetiredLockToken(this.lockPath, token);
      }, 1_000);
    } catch { /* failed cleanup must not remove another owner's lock */ }
  }

  isStale(): boolean {
    try {
      const result = withFileLockMutation(this.lockPath, () => {
        const payload = this._read();
        return !payload || !isLockPidAlive(payload.pid) || isRetiredLockToken(this.lockPath, payload);
      });
      return result.acquired && result.value;
    } catch { return false; } // Unknown filesystem state is not proof of death.
  }

  private _read(): RunLockPayload | null {
    let raw: string;
    try { raw = fs.readFileSync(this.lockPath, 'utf8'); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') { return null; }
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<RunLockPayload>;
      if (!parsed || !Number.isSafeInteger(parsed.pid) || (parsed.pid ?? 0) <= 0) {
        throw new Error('Invalid run lock owner.');
      }
      return parsed as RunLockPayload;
    } catch { throw new Error(`Cannot establish ownership of corrupt workflow lock: ${this.lockPath}`); }
  }
}
