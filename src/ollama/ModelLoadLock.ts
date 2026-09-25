import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { UserAbortError } from '../utils/errors';
import { logInfo, logWarn } from '../utils/logging';

interface ModelLockPayload {
  pid: number;
  model: string;
  acquiredAt: number;
  /**
   * Random per-acquisition nonce. `Date.now()` alone is not a safe ownership
   * token: it has millisecond resolution and a stale-reclaim retry can land
   * in the very same millisecond as the original acquisition, so comparing
   * timestamps for "is this still my lock?" can false-positive-match a
   * completely different holder's lock and delete it out from under them.
   */
  token: string;
}

/** Minimal shape `OllamaClient` depends on — lets tests inject a fake lock without touching the real filesystem. */
export interface ModelLoadLockLike {
  acquire(model: string, shouldAbort?: () => boolean): Promise<() => void>;
}

export interface ModelLoadLockOptions {
  /** A held lock older than this is assumed abandoned by a dead process. Default 20 min — long enough for a genuinely slow local generation. */
  staleMs?: number;
  /** How long to wait between polls while another process holds the lock. */
  pollMs?: number;
  /** Safety valve: give up waiting and proceed anyway (logging a warning) rather than wedge the extension forever on a stuck lock. */
  timeoutMs?: number;
  /** Override the lock directory (tests only). */
  lockDir?: string;
}

const DEFAULT_STALE_MS = 20 * 60_000;
const DEFAULT_POLL_MS = 400;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * A cross-PROCESS advisory lock so only one process on the machine ever holds
 * a local model "in flight" (loading or generating) at a time — regardless of
 * how many VS Code windows or benchmark scripts are running. `OllamaClient`'s
 * own `generationQueue` only serializes calls WITHIN one process; two
 * processes can each pass their own independent pre-flight RAM check and
 * load two large models at once, which is the documented root cause of real
 * OOM-kills during debate runs (see PROJECT_LOG.md, 2026-09-13).
 *
 * Scoped globally (not per-workspace) and keyed by `baseUrl`, since the
 * shared resource being protected is the Ollama server itself, not any one
 * project. Implemented with bare `fs` primitives — this project ships zero
 * runtime npm dependencies — using `wx` (atomic exclusive create) as the
 * mutual-exclusion primitive.
 */
export class ModelLoadLock implements ModelLoadLockLike {
  private readonly lockPath: string;
  private readonly staleMs: number;
  private readonly pollMs: number;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, opts: ModelLoadLockOptions = {}) {
    const dir = opts.lockDir ?? path.join(os.tmpdir(), 'local-multi-agent-coder-locks');
    const key = crypto.createHash('sha1').update(baseUrl).digest('hex');
    this.lockPath = path.join(dir, `${key}.lock`);
    this.staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Waits until no other process holds the lock, then takes it. Returns a
   * release function the caller MUST invoke (typically in a `finally`) once
   * done with the model. Never throws except for `UserAbortError` when
   * `shouldAbort()` reports the caller was cancelled while waiting.
   */
  async acquire(model: string, shouldAbort?: () => boolean): Promise<() => void> {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    const deadline = Date.now() + this.timeoutMs;
    const acquiredAt = Date.now();
    const token = crypto.randomBytes(8).toString('hex');

    for (;;) {
      if (shouldAbort?.()) { throw new UserAbortError(); }
      const payload: ModelLockPayload = { pid: process.pid, model, acquiredAt, token };
      try {
        const fd = fs.openSync(this.lockPath, 'wx');
        try { fs.writeSync(fd, JSON.stringify(payload)); } finally { fs.closeSync(fd); }
        return () => this._release(payload);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
          // Unexpected FS error (e.g. a race on the lock directory itself) —
          // do not let a filesystem hiccup permanently block model calls.
          logWarn(`ModelLoadLock: unexpected error acquiring "${this.lockPath}": ${err instanceof Error ? err.message : String(err)}. Proceeding without the cross-process lock.`);
          return () => {};
        }
      }

      const held = this._read();
      if (!held || this._isStale(held)) {
        try { fs.unlinkSync(this.lockPath); } catch { /* another process may have just released/reclaimed it — retry */ }
        continue;
      }

      if (Date.now() > deadline) {
        logWarn(`ModelLoadLock: still held by pid ${held.pid} (model "${held.model}") after ${this.timeoutMs}ms. Proceeding without the lock to avoid wedging the extension.`);
        return () => {};
      }
      await sleep(this.pollMs + Math.floor(Math.random() * this.pollMs));
    }
  }

  private _release(mine: ModelLockPayload): void {
    const current = this._read();
    // Only remove the lock if it is still the one we took — a stale-lock
    // reclaim by a third process could otherwise have us delete their lock.
    // Compared by `token` (a random nonce), not `acquiredAt`: Date.now() has
    // millisecond resolution and a reclaim can land in the same millisecond
    // as the original acquisition, which would make a timestamp-only
    // comparison false-positive-match an unrelated holder's lock.
    if (current && current.token === mine.token) {
      try { fs.unlinkSync(this.lockPath); } catch { /* already gone */ }
    }
  }

  private _read(): ModelLockPayload | null {
    try {
      const raw = fs.readFileSync(this.lockPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ModelLockPayload>;
      if (typeof parsed.pid !== 'number' || typeof parsed.acquiredAt !== 'number') { return null; }
      return parsed as ModelLockPayload;
    } catch {
      return null;
    }
  }

  private _isStale(payload: ModelLockPayload): boolean {
    if (!this._isPidAlive(payload.pid)) {
      logInfo(`ModelLoadLock: reclaiming a lock left by dead pid ${payload.pid} (model "${payload.model}").`);
      return true;
    }
    return Date.now() - payload.acquiredAt > this.staleMs;
  }

  private _isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException)?.code === 'EPERM';
    }
  }
}
