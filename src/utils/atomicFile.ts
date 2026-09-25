import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { logWarn } from './logging';

const TRANSIENT_FS_ERROR_CODES = new Set(['ENOENT', 'EACCES', 'EBUSY', 'EPERM', 'EAGAIN']);

function isTransientFsError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err
    && TRANSIENT_FS_ERROR_CODES.has(String((err as { code?: unknown }).code));
}

/** Blocks the thread briefly without a Promise — these writers are synchronous by design. */
function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Retries a synchronous filesystem operation a few times on a transient error
 * before giving up. Real runs on a cloud-synced workspace volume (OneDrive)
 * have hit brief ENOENT/EACCES hiccups mid-run — almost certainly the sync
 * client momentarily locking or not-yet-materializing a path — that a short
 * retry resolves, versus turning a one-off filesystem hiccup into a failed
 * autonomous run or (worse) an uncaught crash.
 */
export function withFsRetry<T>(fn: () => T, attempts = 3, delayMs = 150): T {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return fn();
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isTransientFsError(err)) { throw err; }
      logWarn(`Transient filesystem error (attempt ${attempt}/${attempts}), retrying: ${err instanceof Error ? err.message : String(err)}`);
      blockingSleep(delayMs * attempt);
    }
  }
  throw lastError;
}

/**
 * Write `content` to `filePath` without ever leaving a torn/partial file on
 * disk if the process is killed mid-write. Writes to a sibling temp file
 * first, then renames over the target — rename is atomic on the same
 * filesystem, and the temp file always lives next to its target so it always
 * is the same filesystem. A crash before the rename leaves the previous good
 * version of `filePath` untouched instead of a half-written checkpoint that
 * `JSON.parse` would silently discard.
 */
export function writeFileAtomic(filePath: string, content: string): void {
  withFsRetry(() => {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    try {
      fs.writeFileSync(tmpPath, content, 'utf8');
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
      throw err;
    }
  });
}
