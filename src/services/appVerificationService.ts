import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import type { AppVerificationConfig, AppVerificationResult, TerminalRunResult } from '../types';
import { TerminalRunner } from '../terminal/TerminalRunner';
import { TerminalSessionRunner } from '../terminal/TerminalSessionRunner';

export class AppVerificationService {
  constructor(
    private readonly workspaceRoot: string,
    private readonly terminal: TerminalRunner,
    private readonly sessions: TerminalSessionRunner,
    private readonly config?: Partial<AppVerificationConfig>
  ) {}

  async verify(): Promise<AppVerificationResult> {
    const cfg = {
      enabled: true,
      startServer: true,
      httpSmokeTest: true,
      browserSmokeTest: false,
      ...this.config,
    };
    const checks: TerminalRunResult[] = [];
    const warnings: string[] = [];
    const smokeUrls: string[] = [];

    if (!cfg.enabled) {
      return this._result(checks, smokeUrls, warnings, false, 'App verification disabled.');
    }

    const packageJson = this._readPackageJson();
    if (!packageJson?.scripts) {
      return this._result(checks, smokeUrls, warnings, false, 'No package scripts found for app verification.');
    }

    const previewCommand = this._previewCommand(packageJson.scripts);
    if (!previewCommand || !cfg.startServer) {
      return this._result(checks, smokeUrls, warnings, false, 'No start/dev/preview script available for smoke verification.');
    }

    let sessionId: string | null = null;
    try {
      sessionId = this.sessions.start(previewCommand);
      await this._delay(4_000);
      const logs = this.sessions.read(sessionId);
      const url = this._extractLocalUrl(logs) ?? 'http://127.0.0.1:5173';
      smokeUrls.push(url);

      if (cfg.httpSmokeTest) {
        const check = await this._httpGet(url);
        checks.push(check);
      }
    } catch (err) {
      warnings.push(`Smoke verification failed to start: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (sessionId) {
        this.sessions.stop(sessionId);
      }
    }

    const failed = checks.some(check => !check.success);
    return this._result(
      checks,
      smokeUrls,
      warnings,
      failed,
      failed ? 'App smoke verification failed.' : 'App smoke verification completed.'
    );
  }

  private _previewCommand(scripts: Record<string, string>): string | null {
    if (scripts.preview) { return 'npm run preview'; }
    if (scripts.dev) { return 'npm run dev'; }
    if (scripts.start) { return 'npm start'; }
    return null;
  }

  private _readPackageJson(): { scripts?: Record<string, string> } | null {
    const packageJsonPath = path.join(this.workspaceRoot, 'package.json');
    if (!fs.existsSync(packageJsonPath)) { return null; }
    try {
      return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { scripts?: Record<string, string> };
    } catch {
      return null;
    }
  }

  private _extractLocalUrl(logs: string): string | null {
    const match = /(https?:\/\/(?:localhost|127\.0\.0\.1):\d+[^\s]*)/i.exec(logs);
    return match?.[1] ?? null;
  }

  private _httpGet(url: string): Promise<TerminalRunResult> {
    const started = Date.now();
    return new Promise(resolve => {
      const req = http.get(url, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8').slice(0, 2000);
          const success = Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 500);
          resolve({
            command: `HTTP GET ${url}`,
            exitCode: success ? 0 : 1,
            stdout: body,
            stderr: success ? '' : `HTTP ${res.statusCode}`,
            durationMs: Date.now() - started,
            success,
          });
        });
      });
      req.setTimeout(8_000, () => {
        req.destroy();
        resolve({
          command: `HTTP GET ${url}`,
          exitCode: 124,
          stdout: '',
          stderr: 'HTTP smoke test timed out.',
          durationMs: Date.now() - started,
          success: false,
        });
      });
      req.on('error', err => {
        resolve({
          command: `HTTP GET ${url}`,
          exitCode: 1,
          stdout: '',
          stderr: err.message,
          durationMs: Date.now() - started,
          success: false,
        });
      });
    });
  }

  private _result(
    checks: TerminalRunResult[],
    smokeUrls: string[],
    warnings: string[],
    failed: boolean,
    summary: string
  ): AppVerificationResult {
    return {
      generatedAt: new Date().toISOString(),
      checks,
      smokeUrls,
      warnings,
      failed,
      summary,
    };
  }

  private _delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
