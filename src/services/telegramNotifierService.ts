import * as http from 'http';
import * as https from 'https';

export interface TelegramNotifierOptions {
  botToken?: string;
  chatId?: string;
  onWarn?: (message: string) => void;
  /** Overridable for tests so they can point at a local HTTP fixture instead of the real Telegram API. */
  apiBaseUrl?: string;
  /** Overridable for tests so a serialization test does not need to wait out the real flood-limit spacing. */
  minIntervalMs?: number;
}

/**
 * Fire-and-forget progress notifications to a Telegram chat via the Bot API,
 * so the boss can follow an autonomous run from their phone without watching
 * a terminal — every phase change and failure is pushed as it happens.
 *
 * Optional by design: with no TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID configured
 * this silently no-ops (after a single warning) rather than blocking or
 * failing a run — matching this project's rule of asking for the boss's
 * credentials only when a feature that needs them is actually used.
 */
export class TelegramNotifierService {
  private static readonly DEFAULT_MIN_INTERVAL_MS = 1200;
  private static readonly MAX_MESSAGE_LENGTH = 4000; // Telegram's hard cap is 4096.
  private static readonly DEFAULT_API_BASE_URL = 'https://api.telegram.org';

  private readonly botToken?: string;
  private readonly chatId?: string;
  private readonly onWarn?: (message: string) => void;
  private readonly apiBaseUrl: string;
  private readonly minIntervalMs: number;
  private queue: Promise<void> = Promise.resolve();
  private warnedMissingConfig = false;

  constructor(options: TelegramNotifierOptions) {
    this.botToken = options.botToken?.trim() || undefined;
    this.chatId = options.chatId?.trim() || undefined;
    this.onWarn = options.onWarn;
    this.apiBaseUrl = options.apiBaseUrl || TelegramNotifierService.DEFAULT_API_BASE_URL;
    this.minIntervalMs = options.minIntervalMs ?? TelegramNotifierService.DEFAULT_MIN_INTERVAL_MS;
  }

  get isConfigured(): boolean {
    return Boolean(this.botToken && this.chatId);
  }

  /**
   * Queues a message for delivery. Never throws and never awaited by
   * callers — a slow or unreachable Telegram API must never stall the
   * pipeline it is reporting on. Sends are serialized with a minimum
   * spacing so a burst of phase changes (e.g. several fix attempts in a
   * row) never trips Telegram's per-chat flood limit.
   */
  notify(message: string): void {
    if (!message.trim()) { return; }
    if (!this.isConfigured) {
      if (!this.warnedMissingConfig) {
        this.warnedMissingConfig = true;
        this.onWarn?.(
          'Telegram notifications are not configured (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID) — skipping progress updates.'
        );
      }
      return;
    }
    this.queue = this.queue
      .then(() => this._send(message))
      .catch(err => this.onWarn?.(`Telegram notification failed: ${err instanceof Error ? err.message : String(err)}`))
      .then(() => new Promise<void>(resolve => setTimeout(resolve, this.minIntervalMs)));
  }

  /** Waits for every queued notification to finish sending — tests only; production code never awaits notify(). */
  async flush(): Promise<void> {
    await this.queue;
  }

  private _send(message: string): Promise<void> {
    const body = JSON.stringify({
      chat_id: this.chatId,
      text: message.length > TelegramNotifierService.MAX_MESSAGE_LENGTH
        ? `${message.slice(0, TelegramNotifierService.MAX_MESSAGE_LENGTH)}…`
        : message,
      disable_web_page_preview: true,
    });

    const url = new URL(`/bot${this.botToken}/sendMessage`, this.apiBaseUrl);
    const transport = url.protocol === 'http:' ? http : https;

    return new Promise((resolve, reject) => {
      const req = transport.request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 10_000,
        },
        res => {
          res.on('data', () => { /* drain */ });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve();
            } else {
              reject(new Error(`Telegram API returned HTTP ${res.statusCode ?? 'unknown'}`));
            }
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error('Telegram API request timed out')));
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}
