import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TerminalRunResult } from '../types';

interface ProtocolData {
  [key: string]: unknown;
  product?: string;
  targetId?: string;
  sessionId?: string;
  errorText?: string;
  data?: string;
  type?: string;
  canceled?: boolean;
  args?: Array<{ value?: unknown; description?: string }>;
  result?: { value?: string };
  exceptionDetails?: {
    exception?: { description?: string };
    text?: string;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
    stackTrace?: { callFrames?: Array<{ url?: string; lineNumber?: number; columnNumber?: number }> };
  };
  response?: { status: number; url: string };
}

type ProtocolMessage = {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: ProtocolData;
  result?: ProtocolData;
  error?: { message: string };
};

/** A real Chromium page, controlled through a private pipe; no npm install or open debug port. */
/**
 * " (at /scripts/main.js:1:1)" for an exception, from its script URL or top
 * stack frame. Without it a parse error like "Cannot use import statement
 * outside a module" names no file, and repairs cannot find the cause.
 */
function exceptionLocation(details: NonNullable<ProtocolData['exceptionDetails']>): string {
  const frame = details.stackTrace?.callFrames?.find(candidate => candidate.url);
  const url = details.url || frame?.url;
  if (!url) { return ''; }
  let where = url;
  try { where = new URL(url).pathname; } catch { /* keep the raw URL */ }
  const line = (details.url ? details.lineNumber : frame?.lineNumber) ?? 0;
  const column = (details.url ? details.columnNumber : frame?.columnNumber) ?? 0;
  return ` (at ${where}:${line + 1}:${column + 1})`;
}

export class BrowserSmokeService {
  constructor(private readonly workspaceRoot: string) {}

  async verify(url: string): Promise<TerminalRunResult> {
    const started = Date.now();
    const command = `Browser smoke ${url}`;
    const executable = this._browserExecutable();
    if (!executable) {
      return { command, success: false, exitCode: 1, stdout: '', durationMs: 0,
        stderr: 'Browser runtime verification requires Chrome, Chromium, or Edge. Install one or set DEBATE_AGENT_BROWSER_PATH to its executable.' };
    }

    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-browser-smoke-'));
    const proc = cp.spawn(executable, [
      '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--disable-background-networking', '--disable-component-update',
      '--window-size=1280,900', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    const input = proc.stdio[3] as NodeJS.WritableStream;
    const output = proc.stdio[4] as NodeJS.ReadableStream;
    let nextId = 0;
    let buffer = '';
    let processError = '';
    let browserLogs = '';
    let sessionId = '';
    let loaded = false;
    const errors = new Set<string>();
    const pending = new Map<number, {
      resolve: (value: ProtocolData) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }>();

    const rejectPending = (message: string): void => {
      processError = message;
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(message));
      }
      pending.clear();
    };
    proc.on('error', error => rejectPending(error.message));
    proc.on('exit', (code, signal) => rejectPending(`Browser exited (${code ?? signal}). ${browserLogs.slice(-1500)}`));
    proc.stderr?.on('data', chunk => { browserLogs = (browserLogs + String(chunk)).slice(-4000); });
    input.on('error', error => rejectPending(error.message));
    output.on('data', chunk => {
      buffer += String(chunk);
      let separator: number;
      while ((separator = buffer.indexOf('\0')) >= 0) {
        const raw = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 1);
        let message: ProtocolMessage;
        try { message = JSON.parse(raw) as ProtocolMessage; } catch { continue; }
        if (message.id !== undefined) {
          const request = pending.get(message.id);
          if (!request) { continue; }
          clearTimeout(request.timer);
          pending.delete(message.id);
          if (message.error) { request.reject(new Error(message.error.message)); }
          else { request.resolve(message.result ?? {}); }
          continue;
        }
        if (message.sessionId !== sessionId) { continue; }
        const params = message.params ?? {};
        if (message.method === 'Page.loadEventFired') { loaded = true; }
        if (message.method === 'Runtime.exceptionThrown') {
          const details = params.exceptionDetails ?? {};
          errors.add(`JavaScript exception: ${details.exception?.description ?? details.text ?? 'unknown exception'}${exceptionLocation(details)}`);
        }
        if (message.method === 'Runtime.consoleAPICalled' && params.type === 'error') {
          errors.add(`console.error: ${(params.args ?? []).map((arg: Record<string, unknown>) => arg.value ?? arg.description ?? '').join(' ')}`);
        }
        if (message.method === 'Network.loadingFailed' && !params.canceled) {
          errors.add(`Resource load failed (${params.type ?? 'resource'}): ${params.errorText ?? 'unknown network error'}`);
        }
        if (message.method === 'Network.responseReceived' && params.response && params.response.status >= 400
          && ['Document', 'Script', 'Stylesheet', 'Image', 'Font', 'Fetch', 'XHR'].includes(params.type ?? '')) {
          errors.add(`HTTP ${params.response.status}: ${params.response.url}`);
        }
      }
    });

    const call = (method: string, params: Record<string, unknown> = {}, targetSession?: string): Promise<ProtocolData> => {
      if (processError) { return Promise.reject(new Error(processError)); }
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser protocol timed out: ${method}`)); }, 15_000);
        pending.set(id, { resolve, reject, timer });
        input.write(`${JSON.stringify({ id, method, params, ...(targetSession ? { sessionId: targetSession } : {}) })}\0`);
      });
    };

    try {
      const version = await call('Browser.getVersion');
      const target = await call('Target.createTarget', { url: 'about:blank' });
      const attached = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      sessionId = String(attached.sessionId);
      await call('Page.enable', {}, sessionId);
      await call('Runtime.enable', {}, sessionId);
      await call('Network.enable', {}, sessionId);
      const navigation = await call('Page.navigate', { url }, sessionId);
      if (navigation.errorText) { errors.add(`Navigation failed: ${navigation.errorText}`); }
      const deadline = Date.now() + 20_000;
      while (!loaded && Date.now() < deadline && !processError) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!loaded) { errors.add('Page did not finish loading within 20 seconds.'); }
      // Observe startup callbacks, dynamic imports, canvas initialization, and rejected promises.
      await new Promise(resolve => setTimeout(resolve, 1_500));
      const page = await call('Runtime.evaluate', {
        expression: `JSON.stringify({url:location.href,title:document.title,readyState:document.readyState,bodyText:(document.body?.innerText||'').slice(0,1500),canvases:[...document.querySelectorAll('canvas')].map(c=>({width:c.width,height:c.height})),elementCount:document.body?.querySelectorAll('*').length||0})`,
        returnByValue: true,
      }, sessionId);
      if (page.exceptionDetails) { errors.add('Could not inspect the loaded page.'); }
      const pageEvidence = JSON.parse(page.result?.value ?? '{}') as Record<string, unknown>;
      if (!pageEvidence.elementCount && !pageEvidence.bodyText) { errors.add('The browser rendered an empty document.'); }
      const screenshotPath = path.join(this.workspaceRoot, '.agent-workspace', 'logs', 'browser-smoke.png');
      const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      fs.writeFileSync(screenshotPath, Buffer.from(String(screenshot.data), 'base64'));
      return { command, success: errors.size === 0, exitCode: errors.size ? 1 : 0,
        durationMs: Date.now() - started,
        stdout: JSON.stringify({ browser: version.product, page: pageEvidence, screenshotPath }, null, 2),
        stderr: [...errors].join('\n').slice(0, 16_000) };
    } catch (error) {
      return { command, success: false, exitCode: 1, stdout: '', durationMs: Date.now() - started,
        stderr: `Browser smoke failed: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      rejectPending('Browser smoke finished.');
      proc.kill();
      await new Promise<void>(resolve => {
        if (proc.exitCode !== null || proc.signalCode !== null) { resolve(); return; }
        const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 2_000);
        proc.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* best effort */ }
    }
  }

  private _browserExecutable(): string | null {
    const candidates = [
      process.env.DEBATE_AGENT_BROWSER_PATH,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
      process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)']!, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    return candidates.find((candidate): candidate is string => Boolean(candidate && fs.existsSync(candidate))) ?? null;
  }
}
