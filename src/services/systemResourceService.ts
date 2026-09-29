import * as os from 'os';
import { execFileSync } from 'child_process';
import type { ResourceGuardConfig } from '../types';

/** Processes that are part of running this very extension, or infrastructure
 * the run itself needs — never suggest closing these. */
const EXCLUDED_NAME_PATTERN = /ollama|visual studio code|code helper|electron|claude/i;

/**
 * Estimate a context ceiling for one resident model. Reserve RAM for macOS,
 * the editor and inference scratch space; devote the remaining budget to the
 * KV cache. This is deliberately an estimate, not a promise of available RAM:
 * the live OS pressure guard still decides whether a run may start.
 *
 * Standard attention stores K and V in fp16 by default (2 bytes each). Missing
 * or non-standard architecture metadata uses a conservative context ceiling.
 */
export function estimateModelContextLimit(
  totalMemoryBytes: number,
  modelSizeBytes: number,
  modelInfo: Record<string, unknown> = {}
): number {
  const gib = 1024 ** 3;
  const fallback = totalMemoryBytes >= 32 * gib ? 32_768 : totalMemoryBytes >= 24 * gib ? 16_384 : 8_192;
  const architecture = String(modelInfo['general.architecture'] ?? '');
  const value = (key: string): number => Number(modelInfo[`${architecture}.${key}`]) || 0;
  const nativeContext = value('context_length') || fallback;
  const layers = value('block_count');
  const kvHeads = value('attention.head_count_kv');
  const heads = value('attention.head_count');
  const headSize = heads > 0 ? value('embedding_length') / heads : 0;
  const keySize = value('attention.key_length') || headSize;
  const valueSize = value('attention.value_length') || headSize;
  if (!(modelSizeBytes > 0 && layers > 0 && kvHeads > 0 && keySize > 0 && valueSize > 0)) {
    return Math.min(nativeContext, fallback);
  }
  const osReserve = Math.max(4 * gib, totalMemoryBytes * 0.2);
  const inferenceReserve = Math.max(gib, modelSizeBytes * 0.1);
  const cacheBudget = Math.max(0, totalMemoryBytes - modelSizeBytes - osReserve - inferenceReserve);
  const cacheBytesPerToken = 2 * layers * kvHeads * (keySize + valueSize);
  const context = Math.floor(cacheBudget / cacheBytesPerToken / 1024) * 1024;
  return Math.max(1_024, Math.min(nativeContext, context));
}

export interface ProcessMemoryUsage {
  name: string;
  residentMb: number;
  processCount: number;
}

export type MemoryPressureLevel = 'normal' | 'warning' | 'critical' | null;

export interface ResourceSnapshot {
  platform: string;
  totalMemoryMb: number;
  freeMemoryMb: number;
  freeMemoryPercent: number;
  /** macOS's own memory-pressure verdict (kern.memorystatus_vm_pressure_level); null off-macOS or if unreadable. */
  pressureLevel: MemoryPressureLevel;
  /** Informational only — see ResourceGuardConfig.minFreeMemoryPercent doc for why this isn't the primary signal. */
  swapUsedMb: number | null;
  topProcesses: ProcessMemoryUsage[];
}

export interface ResourceCheckResult {
  snapshot: ResourceSnapshot;
  blocked: boolean;
  reasons: string[];
  /** Human-readable pre-run summary; always produced, shown regardless of the block verdict. */
  advisory: string;
}

/** Injectable system accessors so the guard is deterministically testable without depending on the real host's live memory state. */
export interface SystemResourceDeps {
  totalMemoryBytes: () => number;
  freeMemoryBytes: () => number;
  platform: () => NodeJS.Platform;
  /** Runs a command and returns stdout; throws on a non-zero exit, like execFileSync. */
  execFile: (command: string, args: string[]) => string;
  /** Names of currently-running foreground (non-background-only) GUI apps, macOS only. */
  listForegroundApps: () => string[];
}

const REAL_DEPS: SystemResourceDeps = {
  totalMemoryBytes: () => os.totalmem(),
  freeMemoryBytes: () => os.freemem(),
  platform: () => process.platform,
  execFile: (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 3_000, maxBuffer: 2_000_000 }),
  listForegroundApps: () => {
    if (process.platform !== 'darwin') { return []; }
    try {
      const out = execFileSync(
        'osascript',
        ['-e', 'tell application "System Events" to get name of every process whose background only is false'],
        { encoding: 'utf8', timeout: 5_000, maxBuffer: 1_000_000 }
      );
      return out.split(',').map(name => name.trim()).filter(Boolean);
    } catch {
      return [];
    }
  },
};

/**
 * Pre-flight resource check run once, right before a boss goal starts the
 * autonomous pipeline. Always reports a snapshot (free RAM, swap, biggest RAM
 * consumers) so the boss can close things before a long real-model run; hard
 * blocks only when the host is genuinely under memory pressure, since running
 * five sequential local models on an already-struggling machine risks the
 * exact kind of mid-debate model crash a resource-starved host produces.
 */
export class SystemResourceService {
  private readonly deps: SystemResourceDeps;

  constructor(private readonly config: ResourceGuardConfig, deps: Partial<SystemResourceDeps> = {}) {
    this.deps = { ...REAL_DEPS, ...deps };
  }

  check(): ResourceCheckResult {
    const snapshot = this._snapshot();
    const reasons: string[] = [];
    if (this.config.enabled) {
      if (snapshot.pressureLevel === 'critical') {
        reasons.push(
          'macOS reports critical memory pressure right now — the system is already struggling to find free memory for running apps.'
        );
      } else if (snapshot.pressureLevel === null && snapshot.freeMemoryPercent < this.config.minFreeMemoryPercent) {
        reasons.push(
          `Free memory is ${snapshot.freeMemoryPercent.toFixed(1)}%, below the configured minimum of ${this.config.minFreeMemoryPercent}%.`
        );
      }
    }
    return { snapshot, blocked: reasons.length > 0, reasons, advisory: this._formatAdvisory(snapshot, reasons) };
  }

  private _snapshot(): ResourceSnapshot {
    const totalMemoryMb = Math.round(this.deps.totalMemoryBytes() / (1024 * 1024));
    const freeMemoryMb = Math.round(this.deps.freeMemoryBytes() / (1024 * 1024));
    const freeMemoryPercent = totalMemoryMb > 0 ? (freeMemoryMb / totalMemoryMb) * 100 : 100;
    return {
      platform: this.deps.platform(),
      totalMemoryMb,
      freeMemoryMb,
      freeMemoryPercent,
      pressureLevel: this._darwinPressureLevel(),
      swapUsedMb: this._darwinSwapUsedMb(),
      topProcesses: this._topProcesses(),
    };
  }

  private _darwinPressureLevel(): MemoryPressureLevel {
    if (this.deps.platform() !== 'darwin') { return null; }
    try {
      const out = this.deps.execFile('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']).trim();
      const level = Number(out);
      if (level >= 4) { return 'critical'; }
      if (level >= 2) { return 'warning'; }
      if (level >= 1) { return 'normal'; }
      return null;
    } catch {
      return null;
    }
  }

  private _darwinSwapUsedMb(): number | null {
    if (this.deps.platform() !== 'darwin') { return null; }
    try {
      const out = this.deps.execFile('sysctl', ['vm.swapusage']);
      const match = out.match(/used\s*=\s*([\d.]+)M/i);
      return match ? Math.round(Number(match[1])) : null;
    } catch {
      return null;
    }
  }

  private _topProcesses(): ProcessMemoryUsage[] {
    return this._processesByRam().slice(0, Math.max(1, this.config.topProcessCount));
  }

  /**
   * Every non-excluded process, aggregated by friendly name and sorted by RAM
   * descending — uncapped, unlike _topProcesses()'s advisory-sized slice, so
   * closableApps() can search past the first `topProcessCount` entries for
   * ones that are actually closeable foreground apps.
   */
  private _processesByRam(): ProcessMemoryUsage[] {
    if (this.deps.platform() === 'win32') { return []; }
    try {
      const out = this.deps.execFile('ps', ['-Ao', 'pid,rss,comm', '-m']);
      const byName = new Map<string, ProcessMemoryUsage>();
      for (const line of out.split('\n').slice(1)) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (!match) { continue; }
        const rssKb = Number(match[2]);
        const name = this._friendlyName(match[3]);
        if (!name || EXCLUDED_NAME_PATTERN.test(name)) { continue; }
        const existing = byName.get(name) ?? { name, residentMb: 0, processCount: 0 };
        existing.residentMb += rssKb / 1024;
        existing.processCount += 1;
        byName.set(name, existing);
      }
      return [...byName.values()]
        .sort((a, b) => b.residentMb - a.residentMb)
        .map(p => ({ ...p, residentMb: Math.round(p.residentMb) }));
    } catch {
      return [];
    }
  }

  /**
   * Greedily picks foreground (user-facing, non-background-only) apps —
   * never a background daemon or this extension's own infrastructure —
   * whose combined RAM could plausibly close the gap between the current
   * free memory and targetFreeMb. Returns an empty list (never invents apps
   * to suggest) when no foreground app is actually using enough RAM to help,
   * or when foreground-app detection isn't available on this platform.
   */
  closableApps(currentFreeMb: number, targetFreeMb: number): ProcessMemoryUsage[] {
    const gapMb = targetFreeMb - currentFreeMb;
    if (gapMb <= 0) { return []; }
    const foreground = new Set(this.deps.listForegroundApps().map(name => name.toLowerCase()));
    if (foreground.size === 0) { return []; }
    const candidates = this._processesByRam().filter(p => foreground.has(p.name.toLowerCase()));
    const picked: ProcessMemoryUsage[] = [];
    let freed = 0;
    for (const app of candidates) {
      if (freed >= gapMb) { break; }
      picked.push(app);
      freed += app.residentMb;
    }
    return picked;
  }

  private _friendlyName(comm: string): string {
    const appMatch = comm.match(/\/([^/]+)\.app\//);
    if (appMatch) { return appMatch[1]; }
    const segments = comm.trim().split(/\s+/)[0]?.split('/') ?? [];
    return segments[segments.length - 1] || comm.trim();
  }

  private _formatAdvisory(snapshot: ResourceSnapshot, reasons: string[]): string {
    const lines = [
      `System resources before starting: ${snapshot.freeMemoryMb} MB free of ${snapshot.totalMemoryMb} MB` +
        ` (${snapshot.freeMemoryPercent.toFixed(1)}%)` +
        (snapshot.swapUsedMb !== null ? `, ${snapshot.swapUsedMb} MB swap in use` : '') +
        (snapshot.pressureLevel ? `, OS memory pressure: ${snapshot.pressureLevel}` : '') + '.',
    ];
    if (snapshot.topProcesses.length > 0) {
      lines.push('Biggest RAM users right now — consider closing what you do not need for this run:');
      for (const p of snapshot.topProcesses) {
        lines.push(`  - ${p.name}: ~${p.residentMb} MB${p.processCount > 1 ? ` across ${p.processCount} processes` : ''}`);
      }
    }
    if (reasons.length > 0) {
      lines.push('', 'BLOCKED — not enough headroom to safely run five local models sequentially:', ...reasons.map(r => `  - ${r}`));
      lines.push('Close some of the apps above (or wait for other work to finish) and start again.');
    }
    return lines.join('\n');
  }
}
