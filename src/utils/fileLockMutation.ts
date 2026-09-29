import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { logWarn } from './logging';

const MAX_LOCAL_RECOVERY_ENTRIES = 256;
const localMarkers = new Map<string, { marker: string; active: boolean }>();
const retiredTokens = new Set<string>();

/** A release call is explicit evidence that this exact token is no longer active. */
export function retireLockToken(lockPath: string, token: string): void {
  const key = `${path.resolve(lockPath)}\0${token}`;
  if (!retiredTokens.has(key) && retiredTokens.size >= MAX_LOCAL_RECOVERY_ENTRIES) {
    // Never evict a recovery capability or infer that an unknown owner stopped.
    logWarn('Lock cleanup recovery capacity reached; retaining the lock until its owner retries release.');
    return;
  }
  retiredTokens.add(key);
}

export function forgetRetiredLockToken(lockPath: string, token: string): void {
  const key = `${path.resolve(lockPath)}\0${token}`;
  retiredTokens.delete(key);
}

export function isRetiredLockToken(lockPath: string, owner: { pid: number; token?: string }): boolean {
  return owner.pid === process.pid && !!owner.token && retiredTokens.has(`${path.resolve(lockPath)}\0${owner.token}`);
}

export function isLockPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) { return true; }
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function removeMarker(dir: string, marker: string): void {
  try { fs.unlinkSync(path.join(dir, marker)); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { throw err; } }
  try { fs.rmdirSync(dir); }
  catch (err) {
    // A new holder's directory is already nonempty when it becomes visible.
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((err as NodeJS.ErrnoException).code ?? '')) { throw err; }
  }
}

function retryLocalCleanup(dir: string): void {
  const owner = localMarkers.get(dir);
  if (!owner || owner.active) { return; }
  removeMarker(dir, owner.marker);
  localMarkers.delete(dir);
}

function finishLocalMarker(dir: string): void {
  const owner = localMarkers.get(dir);
  if (!owner) { return; }
  owner.active = false;
  try { retryLocalCleanup(dir); }
  catch (err) {
    // Preserve both the callback result and the exact inactive capability.
    logWarn(`Lock guard cleanup pending: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Serializes lock-file read/replace/delete, including stale reclamation.
 * Publishing a pre-populated directory with rename is atomic. Cleanup only
 * unlinks its unique marker, then removes an EMPTY directory: a delayed
 * reclaimer can never delete a newer holder's nonempty guard (the ABA race).
 * Known finished local callbacks can retry their exact marker cleanup; merely
 * sharing a PID is never sufficient. Unknown or malformed owners fail closed.
 */
export function withFileLockMutation<T>(lockPath: string, action: () => T, waitMs = 0):
  { acquired: true; value: T } | { acquired: false } {
  const guard = path.resolve(`${lockPath}.guard`);
  // Also drain abandoned staging cleanup when later filesystem access works.
  for (const [dir, owner] of localMarkers) {
    if (!owner.active && dir !== guard) {
      try { retryLocalCleanup(dir); } catch { /* retained, bounded, retry later */ }
    }
  }
  retryLocalCleanup(guard);
  if (localMarkers.size >= MAX_LOCAL_RECOVERY_ENTRIES) {
    throw new Error('Lock guard recovery capacity exhausted; pending filesystem cleanup must complete first.');
  }
  fs.mkdirSync(path.dirname(guard), { recursive: true });
  const marker = `${process.pid}-${crypto.randomBytes(16).toString('hex')}`;
  const staging = `${guard}.${marker}`;
  fs.mkdirSync(staging);
  localMarkers.set(staging, { marker, active: true });
  try {
    fs.writeFileSync(path.join(staging, marker), '', { flag: 'wx' });
    const deadline = Date.now() + waitMs;
    for (let attempt = 0; attempt < 4 || Date.now() < deadline; attempt++) {
      try { fs.renameSync(staging, guard); }
      catch (err) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((err as NodeJS.ErrnoException).code ?? '')) { throw err; }
        let entries: string[];
        try { entries = fs.readdirSync(guard); }
        catch (readErr) {
          if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') { continue; }
          throw readErr;
        }
        if (entries.length === 0) {
          try { fs.rmdirSync(guard); } catch { /* replaced by another nonempty guard */ }
          continue;
        }
        if (entries.length !== 1) { return { acquired: false }; }
        const owner = /^(\d+)-[a-f0-9]{32}$/.exec(entries[0]);
        if (!owner) { return { acquired: false }; }
        if (isLockPidAlive(Number(owner[1]))) {
          if (Date.now() >= deadline) { return { acquired: false }; }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          continue;
        }
        removeMarker(guard, entries[0]);
        continue;
      }
      localMarkers.delete(staging);
      localMarkers.set(guard, { marker, active: true });
      try { return { acquired: true, value: action() }; }
      finally { finishLocalMarker(guard); }
    }
    return { acquired: false };
  } finally {
    finishLocalMarker(staging);
  }
}
