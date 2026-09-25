import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import type { AppVerificationConfig, AppVerificationResult, TerminalRunResult } from '../types';
import { TerminalRunner } from '../terminal/TerminalRunner';
import { TerminalSessionRunner } from '../terminal/TerminalSessionRunner';
import { BrowserSmokeService } from './browserSmokeService';

interface HttpCheck extends TerminalRunResult { contentType?: string }

export class AppVerificationService {
  constructor(
    private readonly workspaceRoot: string,
    private readonly terminal: TerminalRunner,
    private readonly sessions: TerminalSessionRunner,
    private readonly config?: Partial<AppVerificationConfig>
  ) {}

  async verify(): Promise<AppVerificationResult> {
    const cfg = { enabled: true, startServer: true, httpSmokeTest: true, browserSmokeTest: true, ...this.config };
    const checks: TerminalRunResult[] = [];
    const warnings: string[] = [];
    const smokeUrls: string[] = [];
    if (!cfg.enabled) { return this._result(checks, smokeUrls, warnings, 'App verification disabled.'); }

    const scripts = this._readPackageScripts();
    const previewCommand = this._previewCommand(scripts);
    const staticRoot = this._staticRoot();
    if (!previewCommand && !staticRoot) {
      if (this._hasBrowserManifest()) {
        checks.push(this._failure('Web entry point', 'Browser artifact has no runnable start/dev/preview server or index.html. Provide an HTML entry point and a working production build or web server.'));
      }
      return this._result(checks, smokeUrls, warnings, 'No start/dev/preview script or static index.html available for smoke verification.');
    }
    if (!cfg.startServer || (!cfg.httpSmokeTest && !cfg.browserSmokeTest)) {
      checks.push(this._failure('App verification configuration', 'Web artifact verification requires a running server and at least one enabled smoke check.'));
      return this._result(checks, smokeUrls, warnings, 'Web artifact runtime verification was not performed.');
    }

    let sessionId: string | null = null;
    let server: http.Server | null = null;
    try {
      let url: string;
      if (previewCommand) {
        const script = scripts[previewCommand.includes('preview') ? 'preview' : previewCommand.includes('dev') ? 'dev' : 'start'];
        const port = await this._availablePort();
        const command = this._withPort(previewCommand, script, port);
        sessionId = this.sessions.start(command);
        const ready = await this._waitForServer(sessionId, command === previewCommand ? undefined : port);
        checks.push(ready.check);
        url = ready.url;
        if (!ready.check.success) {
          return this._result(checks, smokeUrls, warnings, 'App server did not become ready.');
        }
      } else {
        server = this._staticServer(staticRoot!);
        url = await this._listen(server);
      }
      smokeUrls.push(url);
      const document = await this._httpGet(url);
      checks.push(document);
      if (document.success) {
        checks.push(...await this._checkResources(url, document.stdout));
        if (cfg.browserSmokeTest) {
          checks.push(await new BrowserSmokeService(this.workspaceRoot).verify(url));
        } else {
          warnings.push('Browser smoke is disabled: HTTP evidence does not prove JavaScript executes successfully.');
        }
      }
    } catch (error) {
      checks.push(this._failure('App smoke startup', error instanceof Error ? error.message : String(error)));
    } finally {
      if (sessionId) { this.sessions.stop(sessionId); }
      if (server) { await new Promise<void>(resolve => { server!.close(() => resolve()); server!.closeAllConnections(); }); }
    }
    return this._result(checks, smokeUrls, warnings, checks.some(check => !check.success)
      ? 'App runtime verification failed.' : 'App runtime verification completed.');
  }

  private _previewCommand(scripts: Record<string, string>): string | null {
    const manager = this.terminal.detectPackageManager?.() ?? 'npm';
    const run = (name: string): string => manager === 'yarn' ? `yarn ${name}`
      : manager === 'npm' && name === 'start' ? 'npm start' : `${manager} run ${name}`;
    if (scripts.preview) { return run('preview'); }
    if (scripts.dev && this._looksLikeServerScript(scripts.dev)) { return run('dev'); }
    // A CLI's `node src/cli.js` start command is not an HTTP server.
    if (scripts.start && this._looksLikeServerScript(scripts.start)) { return run('start'); }
    return null;
  }

  private _looksLikeServerScript(script: string): boolean {
    return /(?:^|[\s/.-])(serve|server|http-server|vite|next|nuxt|astro|webpack-dev-server)(?:$|[\s/.-])|webpack\s+serve|python\d*\s+-m\s+http\.server/i.test(script);
  }

  private _withPort(command: string, script: string, port: number): string {
    if (/\b(?:vite|next|nuxt|astro|webpack-dev-server)\b|webpack\s+serve/.test(script)) {
      // Use an unused port so an old preview cannot masquerade as this build.
      return `${command}${command.startsWith('yarn ') ? '' : ' --'} --port ${port}`;
    }
    return command;
  }

  private async _waitForServer(sessionId: string, assignedPort?: number): Promise<{ url: string; check: TerminalRunResult }> {
    const started = Date.now();
    let url = assignedPort ? `http://127.0.0.1:${assignedPort}` : '';
    let last: TerminalRunResult | undefined;
    while (Date.now() - started < 45_000) {
      const logs = this.sessions.read(sessionId);
      const advertised = this._extractLocalUrl(logs);
      if (advertised && (!assignedPort || Number(new URL(advertised).port) === assignedPort)) {
        // localhost may resolve to ::1 while a framework binds IPv6 only.
        // Honor this process's advertised loopback host, but never a stale port.
        url = advertised;
      }
      if (/EADDRINUSE|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERROR in\b|compiled with \d+ errors?|\[session closed/.test(logs)) {
        return { url, check: this._failure('App server startup', logs.slice(-12_000)) };
      }
      if (url) {
        last = await this._httpGet(url, 1_000);
        if (last.success) {
          return { url, check: { ...last, command: `App server ready ${url}`, stdout: logs.slice(-8_000) } };
        }
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return { url, check: this._failure('App server startup',
      `Server did not become ready within 45 seconds. ${url ? last?.stderr ?? '' : 'The server must print its localhost URL.'}\n${this.sessions.read(sessionId)}`) };
  }

  private _staticRoot(): string | null {
    for (const dir of ['dist', 'build', 'out', '.', 'public']) {
      const root = path.join(this.workspaceRoot, dir);
      if (fs.existsSync(path.join(root, 'index.html'))) { return root; }
    }
    return null;
  }

  private _staticServer(root: string): http.Server {
    const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
      '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };
    return http.createServer((req, res) => {
      try {
        const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
        const file = path.resolve(root, `.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`);
        const realRoot = fs.realpathSync(root);
        const realFile = fs.realpathSync(file);
        const relative = path.relative(realRoot, realFile);
        if (relative.startsWith('..') || path.isAbsolute(relative)
          || relative.split(path.sep).some(part => part.startsWith('.')) || !fs.statSync(realFile).isFile()) {
          res.writeHead(403); res.end('Forbidden'); return;
        }
        res.writeHead(200, { 'Content-Type': mime[path.extname(realFile).toLowerCase()] ?? 'application/octet-stream' });
        const stream = fs.createReadStream(realFile);
        stream.on('error', () => res.destroy());
        stream.pipe(res);
      } catch { res.writeHead(404); res.end('Not found'); }
    });
  }

  private _listen(server: http.Server): Promise<string> {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') { reject(new Error('No HTTP listen address.')); return; }
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
  }

  private async _availablePort(): Promise<number> {
    const server = http.createServer();
    const url = await this._listen(server);
    await new Promise<void>(resolve => server.close(() => resolve()));
    return Number(new URL(url).port);
  }

  private _readPackageScripts(): Record<string, string> {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(this.workspaceRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
      return Object.fromEntries(Object.entries(parsed.scripts ?? {}).filter((item): item is [string, string] => typeof item[1] === 'string'));
    } catch { return {}; }
  }

  private _hasBrowserManifest(): boolean {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(this.workspaceRoot, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>;
      };
      const dependencies = { ...parsed.dependencies, ...parsed.devDependencies };
      return ['phaser', 'pixi.js', 'three', 'react-dom', 'vue', 'svelte', 'vite', 'next', 'nuxt', 'astro', '@angular/core']
        .some(name => name in dependencies);
    } catch { return false; }
  }

  private _extractLocalUrl(logs: string): string | null {
    const clean = logs.replace(/\u001b\[[0-9;]*m/g, '');
    const match = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+(?:\/[^\s<>"']*)?/i.exec(clean);
    return match?.[0].replace('0.0.0.0', '127.0.0.1') ?? null;
  }

  private async _checkResources(baseUrl: string, html: string): Promise<TerminalRunResult[]> {
    const checks: TerminalRunResult[] = [];
    const urls = new Map<string, boolean>();
    const base = /<base\b[^>]*href\s*=\s*["']([^"']+)/i.exec(html)?.[1];
    for (const tag of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
      const isScript = tag[1].toLowerCase() === 'script';
      if (!isScript && !/\brel\s*=\s*["'](?:stylesheet|modulepreload)["']/i.test(tag[0])) { continue; }
      const src = /\b(?:src|href)\s*=\s*["']([^"']+)["']/i.exec(tag[0])?.[1];
      if (!src || /^(?:data|blob):/i.test(src)) { continue; }
      const url = new URL(src, base ? new URL(base, baseUrl) : baseUrl);
      if (url.origin === new URL(baseUrl).origin) { urls.set(url.href, isScript); }
    }
    for (const [url, isScript] of urls) {
      const check = await this._httpGet(url);
      if (check.success && (/text\/html/i.test(check.contentType ?? '') || /^\s*<!doctype html|^\s*<html/i.test(check.stdout))) {
        check.success = false; check.exitCode = 1;
        check.stderr = `Expected ${isScript ? 'JavaScript' : 'stylesheet/module'} but received HTML; check bundle URL and static/publicPath configuration.`;
      }
      checks.push(check);
    }
    return checks;
  }

  private _httpGet(url: string, timeoutMs = 8_000, redirects = 0): Promise<HttpCheck> {
    const started = Date.now();
    return new Promise(resolve => {
      let settled = false;
      const finish = (check: HttpCheck): void => {
        if (settled) { return; }
        settled = true;
        clearTimeout(deadline);
        resolve(check);
      };
      const transport = url.startsWith('https:') ? https : http;
      const req = transport.get(url, { headers: { Accept: '*/*' } }, res => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
          res.resume();
          const remainingMs = Math.max(1, timeoutMs - (Date.now() - started));
          void this._httpGet(new URL(res.headers.location, url).href, remainingMs, redirects + 1)
            .then(finish, error => finish(this._failure(`HTTP GET ${url}`, String(error))));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', chunk => {
          if (bytes < 512_000) { const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)); chunks.push(data); bytes += data.length; }
        });
        res.on('end', () => {
          const success = Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300);
          finish({ command: `HTTP GET ${url}`, exitCode: success ? 0 : 1, stdout: Buffer.concat(chunks).toString('utf8'),
            stderr: success ? '' : `HTTP ${res.statusCode}`, durationMs: Date.now() - started, success,
            contentType: res.headers['content-type'] });
        });
        res.on('error', error => finish(this._failure(`HTTP GET ${url}`, error.message)));
      });
      // Socket timeouts only measure inactivity: a broken server can otherwise
      // send one byte repeatedly and keep the entire verification phase alive forever.
      const deadline = setTimeout(() => {
        req.destroy();
        finish({ ...this._failure(`HTTP GET ${url}`, 'HTTP smoke test wall-clock deadline exceeded.'), durationMs: Date.now() - started });
      }, timeoutMs);
      req.setTimeout(timeoutMs, () => req.destroy(new Error('HTTP smoke test timed out.')));
      req.on('error', error => finish({ ...this._failure(`HTTP GET ${url}`, error.message), durationMs: Date.now() - started }));
    });
  }

  private _failure(command: string, stderr: string): TerminalRunResult {
    return { command, success: false, exitCode: 1, stdout: '', stderr, durationMs: 0 };
  }

  private _result(checks: TerminalRunResult[], smokeUrls: string[], warnings: string[], summary: string): AppVerificationResult {
    return { generatedAt: new Date().toISOString(),
      // Never feed entire minified bundles back into a local model's limited context.
      checks: checks.map(check => ({ ...check, stdout: check.stdout.slice(0, 8_000), stderr: check.stderr.slice(0, 12_000) })),
      smokeUrls, warnings, failed: checks.some(check => !check.success), summary };
  }
}
