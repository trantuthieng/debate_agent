import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { UserAbortError } from '../utils/errors';
import { logWarn } from '../utils/logging';
import { writeFileAtomic } from '../utils/atomicFile';
import { isLockPidAlive, withFileLockMutation, retireLockToken, forgetRetiredLockToken, isRetiredLockToken } from '../utils/fileLockMutation';

interface ModelLockPayload {
  pid: number;
  model: string;
  acquiredAt: number;
  token: string;
}

export interface ModelLoadLockLike {
  acquire(model: string, shouldAbort?: () => boolean): Promise<() => void>;
}

export interface ModelLoadLockOptions {
  /** Retained for compatibility. A live process is never reclaimed by age. */
  staleMs?: number;
  pollMs?: number;
  /** Maximum wait before throwing; inference must never proceed unlocked. */
  timeoutMs?: number;
  /** Override the lock directory (tests only). */
  lockDir?: string;
}

function serverKey(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (['localhost', 'localhost.', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    url.hostname = '127.0.0.1';
  }
  // Credentials, query and fragment do not identify a different server.
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

/** Cross-process inference ownership. All error paths fail closed. */
export class ModelLoadLock implements ModelLoadLockLike {
  private readonly lockPath: string;
  private readonly pollMs: number;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, opts: ModelLoadLockOptions = {}) {
    const dir = opts.lockDir ?? path.join(os.tmpdir(), 'local-multi-agent-coder-locks');
    const key = crypto.createHash('sha1').update(serverKey(baseUrl)).digest('hex');
    this.lockPath = path.join(dir, `${key}.lock`);
    this.pollMs = opts.pollMs ?? 400;
    this.timeoutMs = opts.timeoutMs ?? 30 * 60_000;
    if (!Number.isFinite(this.pollMs) || this.pollMs <= 0 || !Number.isFinite(this.timeoutMs) || this.timeoutMs < 0) {
      throw new Error('Model lock pollMs must be positive and timeoutMs must be nonnegative.');
    }
  }

  async acquire(model: string, shouldAbort?: () => boolean): Promise<() => void> {
    const deadline = Date.now() + this.timeoutMs;
    const token = crypto.randomBytes(16).toString('hex');
    for (;;) {
      if (shouldAbort?.()) { throw new UserAbortError(); }
      const result = withFileLockMutation(this.lockPath, () => {
        const held = this._read();
        if (held && isLockPidAlive(held.pid) && !isRetiredLockToken(this.lockPath, held)) { return false; }
        const payload: ModelLockPayload = { pid: process.pid, model, acquiredAt: Date.now(), token };
        writeFileAtomic(this.lockPath, JSON.stringify(payload));
        if (held?.token) { forgetRetiredLockToken(this.lockPath, held.token); }
        return true;
      });
      if (result.acquired && result.value) { return () => this._release(token); }
      const remaining = deadline - Date.now();
      if (remaining <= 0) { throw new Error(`ModelLoadLock timed out after ${this.timeoutMs}ms waiting for exclusive model ownership.`); }
      await new Promise(resolve => setTimeout(resolve, Math.min(this.pollMs, remaining)));
    }
  }

  private _release(token: string): void {
    retireLockToken(this.lockPath, token);
    try {
      const result = withFileLockMutation(this.lockPath, () => {
        if (this._read()?.token === token) { fs.unlinkSync(this.lockPath); }
        forgetRetiredLockToken(this.lockPath, token);
      }, 1_000);
      if (!result.acquired) { logWarn('ModelLoadLock: could not release busy ownership guard; retaining lock for safety.'); }
    } catch (err) {
      logWarn(`ModelLoadLock: failed to release ownership: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private _read(): ModelLockPayload | null {
    let raw: string;
    try { raw = fs.readFileSync(this.lockPath, 'utf8'); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') { return null; }
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ModelLockPayload>;
      // Legacy payloads without tokens still identify a live owner.
      if (!parsed || !Number.isSafeInteger(parsed.pid) || (parsed.pid ?? 0) <= 0) { throw new Error('Invalid PID'); }
      return parsed as ModelLockPayload;
    } catch { throw new Error(`Cannot establish ownership of corrupt model lock: ${this.lockPath}`); }
  }
}
