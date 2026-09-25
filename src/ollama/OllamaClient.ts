import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import { estimateModelContextLimit } from '../services/systemResourceService';
import type {
  AgentRole,
  ModelOptions,
  OllamaMessage,
  OllamaChatRequest,
  OllamaChatResponse,
  OllamaCallLog,
} from '../types';
import { OllamaConnectionError, ModelNotFoundError, UserAbortError } from '../utils/errors';
import { logInfo, logWarn, logError } from '../utils/logging';
import { ModelLoadLock, type ModelLoadLockLike } from './ModelLoadLock';

// Default request timeout in milliseconds
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
// How long a text-model stays warm in VRAM after a call. Kept modest because
// consecutive debate phases usually switch models, so a long keep-alive just
// pins idle weights and risks OOM on constrained hardware (e.g. 24 GB Macs).
const DEFAULT_TEXT_KEEP_ALIVE_SECONDS = 30;

export interface LocalModelInventoryEntry {
  name: string;
  size?: number;
  digest?: string;
}

export interface LocalModelDetails {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
}

/** Injectable HTTP transport; production does not use Undici's 300s header limit. */
export type OllamaTransport = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Ollama stream:false can withhold headers for the entire inference. Native
 * fetch has a separate Undici 300-second header timeout, which aborts healthy
 * generations before our configured 600-second deadline. Use Node's HTTP
 * client with no pooled socket timeout; the caller's AbortSignal owns the
 * deadline through connection, headers and the complete response body.
 */
const nodeHttpTransport: OllamaTransport = (url, init) => new Promise((resolve, reject) => {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    reject(new Error(`Unsupported Ollama URL protocol: ${parsed.protocol}`));
    return;
  }
  if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') {
    reject(new Error('Ollama HTTP transport expects a serialized JSON request body.'));
    return;
  }
  const request = (parsed.protocol === 'https:' ? https : http).request(parsed, {
    method: init.method ?? 'GET',
    headers: Object.fromEntries(new Headers(init.headers).entries()),
    agent: false,
    signal: init.signal ?? undefined,
  }, response => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    response.on('error', reject);
    response.on('end', () => {
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value === undefined) { continue; }
          for (const entry of Array.isArray(value) ? value : [value]) { headers.append(name, entry); }
        }
        const status = response.statusCode ?? 502;
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), {
          status, statusText: response.statusMessage, headers,
        }));
      } catch (err) { reject(err); }
    });
  });
  request.on('error', reject);
  request.end(init.body ?? undefined);
});

export class OllamaClient {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly textKeepAliveSeconds: number;
  private logFilePath: string | null = null;
  private readonly activeControllers = new Set<AbortController>();
  private cancellationRequested = false;
  private cancellationEpoch = 0;
  private generationQueue: Promise<void> = Promise.resolve();
  private lastResidentModel: string | null = null;
  private readonly modelInventory = new Map<string, LocalModelInventoryEntry>();
  private readonly modelDetails = new Map<string, LocalModelDetails>();
  private readonly modelLoadLock: ModelLoadLockLike;

  constructor(
    baseUrl: string,
    logFilePath?: string,
    requestTimeoutMs: number = DEFAULT_TIMEOUT_MS,
    textKeepAliveSeconds: number = DEFAULT_TEXT_KEEP_ALIVE_SECONDS,
    private readonly transport: OllamaTransport = nodeHttpTransport,
    modelLoadLock?: ModelLoadLockLike
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.logFilePath = logFilePath ?? null;
    this.requestTimeoutMs = Math.max(30_000, requestTimeoutMs);
    this.textKeepAliveSeconds = Math.max(0, textKeepAliveSeconds);
    // Cross-PROCESS lock: only one process on the machine ever holds a model
    // in flight at a time, on top of the in-process generationQueue below.
    this.modelLoadLock = modelLoadLock ?? new ModelLoadLock(this.baseUrl);
  }

  setLogFilePath(filePath: string): void {
    this.logFilePath = filePath;
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Send a chat request to Ollama.
   * Reuse a warm model for consecutive calls; unload it before switching
   * models so a sequential debate does not keep multiple weight sets in RAM.
   */
  async chat(
    model: string,
    messages: OllamaMessage[],
    agentRole: AgentRole | string = 'unknown',
    options?: ModelOptions,
    outputFile: string = '',
    inputFiles: string[] = []
  ): Promise<string> {
    const startTime = Date.now();
    let success = false;
    let errorMsg: string | undefined;
    let content = '';

    try {
      const response = await this._sendChatRequest(model, messages, false, options);
      content = response.message?.content ?? '';
      success = true;
      return content;
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const duration = Date.now() - startTime;
      this._writeCallLog({
        timestamp: new Date().toISOString(),
        agentRole,
        model,
        durationMs: duration,
        success,
        error: errorMsg,
        inputFiles,
        outputFile,
        usedFallback: false,
      });
      // The next different-model call explicitly releases these weights.
    }
  }

  /**
   * Send a chat request and parse the response as JSON.
   * Uses Ollama's format: "json" to request JSON output.
   */
  async chatJson<T>(
    model: string,
    messages: OllamaMessage[],
    agentRole: AgentRole | string = 'unknown',
    options?: ModelOptions,
    outputFile: string = '',
    inputFiles: string[] = []
  ): Promise<T> {
    const startTime = Date.now();
    let success = false;
    let errorMsg: string | undefined;

    try {
      const response = await this._sendChatRequest(model, messages, true, options);
      const raw = response.message?.content ?? '{}';
      const { parseJsonResponse } = await import('../utils/json');
      const parsed = parseJsonResponse<T>(raw);
      success = true;
      return parsed;
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const duration = Date.now() - startTime;
      this._writeCallLog({
        timestamp: new Date().toISOString(),
        agentRole,
        model,
        durationMs: duration,
        success,
        error: errorMsg,
        inputFiles,
        outputFile,
        usedFallback: false,
      });
      // keep_alive:0 is already set in the request body by _sendChatRequest
      // for JSON calls, so Ollama unloads the model automatically.
    }
  }

  /**
   * Try primary model, fall back to fallback model on failure.
   */
  async callWithFallback(
    primaryModel: string,
    fallbackModel: string,
    messages: OllamaMessage[],
    agentRole: AgentRole | string = 'unknown',
    options?: ModelOptions,
    outputFile: string = '',
    inputFiles: string[] = []
  ): Promise<string> {
    try {
      return await this.chat(primaryModel, messages, agentRole, options, outputFile, inputFiles);
    } catch (err) {
      if (err instanceof UserAbortError) { throw err; }
      logWarn(`Primary model "${primaryModel}" failed: ${err instanceof Error ? err.message : err}. Trying fallback "${fallbackModel}".`);
      try {
        const result = await this.chat(fallbackModel, messages, agentRole, options, outputFile, inputFiles);
        // Log fallback use
        this._writeCallLog({
          timestamp: new Date().toISOString(),
          agentRole,
          model: fallbackModel,
          durationMs: 0,
          success: true,
          inputFiles,
          outputFile,
          usedFallback: true,
        });
        return result;
      } catch (fallbackErr) {
        if (fallbackErr instanceof UserAbortError) { throw fallbackErr; }
        throw new Error(
          `Both primary model "${primaryModel}" and fallback "${fallbackModel}" failed.\n` +
          `Primary error: ${err instanceof Error ? err.message : err}\n` +
          `Fallback error: ${fallbackErr instanceof Error ? fallbackErr.message : fallbackErr}`
        );
      }
    }
  }

  /**
   * Try primary model, fall back to fallback model on failure. Returns JSON.
   */
  async callWithFallbackJson<T>(
    primaryModel: string,
    fallbackModel: string,
    messages: OllamaMessage[],
    agentRole: AgentRole | string = 'unknown',
    options?: ModelOptions,
    outputFile: string = '',
    inputFiles: string[] = []
  ): Promise<T> {
    try {
      return await this.chatJson<T>(primaryModel, messages, agentRole, options, outputFile, inputFiles);
    } catch (err) {
      if (err instanceof UserAbortError) { throw err; }
      logWarn(`Primary model "${primaryModel}" failed (JSON): ${err instanceof Error ? err.message : err}. Trying fallback "${fallbackModel}".`);
      try {
        return await this.chatJson<T>(fallbackModel, messages, agentRole, options, outputFile, inputFiles);
      } catch (fallbackErr) {
        if (fallbackErr instanceof UserAbortError) { throw fallbackErr; }
        throw new Error(
          `Both primary model "${primaryModel}" and fallback "${fallbackModel}" failed (JSON).\n` +
          `Primary error: ${err instanceof Error ? err.message : err}\n` +
          `Fallback error: ${fallbackErr instanceof Error ? fallbackErr.message : fallbackErr}`
        );
      }
    }
  }

  /**
   * Unload a model from RAM by sending a keep_alive: 0 request.
   */
  async unloadModel(model: string): Promise<void> {
    try {
      const body: OllamaChatRequest = {
        model,
        messages: [],
        stream: false,
        keep_alive: 0,
      };
      const response = await this._fetchWithTimeout(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, 10_000);
      if (!response.ok) { throw new Error(`Ollama unload returned HTTP ${response.status}`); }
      if (this.lastResidentModel && this._matchesModelName(this.lastResidentModel, model)) {
        this.lastResidentModel = null;
      }
      logInfo(`Model "${model}" unloaded from RAM.`);
    } catch (err) {
      // Cleanup must not replace the original generation error, but keep the
      // model tracked so a later switch can retry releasing its weights.
      if (err instanceof UserAbortError) { throw err; }
      logWarn(`Could not unload model "${model}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Abort any in-flight Ollama fetches. Used by the Stop command so VS Code
   * does not appear stuck while a large local model is generating.
   */
  cancelActiveRequests(): void {
    this.cancellationEpoch += 1;
    if (this.activeControllers.size === 0) { return; }
    this.cancellationRequested = true;
    for (const controller of this.activeControllers) {
      controller.abort();
    }
  }

  /**
   * Check if Ollama is running and reachable.
   */
  async checkConnection(): Promise<boolean> {
    try {
      const res = await this._fetchWithTimeout(`${this.baseUrl}/api/tags`, {}, 5_000);
      return res.ok;
    } catch (err) {
      if (err instanceof UserAbortError) { throw err; }
      return false;
    }
  }

  /**
   * Check if a specific model is available locally.
   */
  async checkModelAvailable(model: string): Promise<boolean> {
    try {
      const models = await this.listModelInventory();
      return models.some(m => this._matchesModelName(m.name, model));
    } catch (err) {
      if (err instanceof UserAbortError) { throw err; }
      return false;
    }
  }

  /**
   * List all available local models.
   */
  async listModels(): Promise<string[]> {
    return (await this.listModelInventory()).map(model => model.name);
  }

  /** Inventory metadata is read without loading any model into inference RAM. */
  async listModelInventory(): Promise<LocalModelInventoryEntry[]> {
    try {
      const res = await this._fetchWithTimeout(`${this.baseUrl}/api/tags`, {}, 5_000);
      if (!res.ok) { return []; }
      const data = await res.json() as { models?: LocalModelInventoryEntry[] };
      const models = (data.models ?? []).filter(model => typeof model.name === 'string');
      this.modelInventory.clear();
      for (const model of models) { this.modelInventory.set(this._normalizeModelName(model.name), model); }
      return models;
    } catch (err) {
      if (err instanceof UserAbortError) { throw err; }
      return [];
    }
  }

  async getModelDetails(model: string): Promise<LocalModelDetails | undefined> {
    const key = this._normalizeModelName(model);
    if (this.modelDetails.has(key)) { return this.modelDetails.get(key); }
    try {
      const res = await this._fetchWithTimeout(`${this.baseUrl}/api/show`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      }, 10_000);
      if (!res.ok) { return undefined; }
      const details = await res.json() as LocalModelDetails;
      this.modelDetails.set(key, details);
      return details;
    } catch (err) {
      if (err instanceof UserAbortError) { throw err; }
      return undefined;
    }
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private async _sendChatRequest(
    model: string,
    messages: OllamaMessage[],
    jsonFormat: boolean,
    options?: ModelOptions
  ): Promise<OllamaChatResponse> {
    // Coding tasks may be prepared concurrently, but local generation is a
    // single lane. Otherwise parallel KV caches defeat the per-model RAM
    // budget, and one fallback could unload another task's active model.
    const queuedEpoch = this.cancellationEpoch;
    const request = this.generationQueue.then(async () => {
      if (queuedEpoch !== this.cancellationEpoch) { throw new UserAbortError(); }
      return this._sendChatRequestExclusive(model, messages, jsonFormat, options);
    });
    this.generationQueue = request.then(() => undefined, () => undefined);
    return request;
  }

  private async _sendChatRequestExclusive(
    model: string,
    messages: OllamaMessage[],
    jsonFormat: boolean,
    options?: ModelOptions
  ): Promise<OllamaChatResponse> {
    const isConnected = await this.checkConnection();
    if (!isConnected) {
      throw new OllamaConnectionError(this.baseUrl);
    }

    const isAvailable = await this.checkModelAvailable(model);
    if (!isAvailable) {
      throw new ModelNotFoundError(model);
    }

    // Cross-process lock: only one process on the machine may hold a model
    // in flight (loading or generating) at a time, so two VS Code windows or
    // a benchmark script running alongside the extension can never both load
    // a large model into RAM at once. Released in `finally` below — always,
    // whether this call succeeds or fails.
    const releaseModelLoadLock = await this.modelLoadLock.acquire(model, () => this.cancellationRequested);
    try {
      // Release the previous model before loading the next one, including a
      // failed primary before its fallback. Same-model calls retain warm weights.
      if (this.lastResidentModel && !this._matchesModelName(this.lastResidentModel, model)) {
        await this.unloadModel(this.lastResidentModel);
      }
      const details = await this.getModelDetails(model);
      const inventory = this.modelInventory.get(this._normalizeModelName(model));
      const contextLimit = estimateModelContextLimit(os.totalmem(), inventory?.size ?? 0, details?.model_info);
      const requestedContext = options?.num_ctx;
      const boundedOptions: ModelOptions = {
        ...options,
        num_ctx: Math.min(requestedContext && requestedContext > 0 ? requestedContext : 8_192, contextLimit),
      };
      if (requestedContext && boundedOptions.num_ctx! < requestedContext) {
        logInfo(`Context for "${model}" limited to ${boundedOptions.num_ctx} tokens (requested ${requestedContext}) by model metadata / RAM budget.`);
      }
      const keepAliveSeconds = jsonFormat ? 0 : this.textKeepAliveSeconds;
      const body: OllamaChatRequest = {
        model,
        messages,
        stream: false,
        keep_alive: keepAliveSeconds,
        ...(jsonFormat ? { format: 'json' } : {}),
        options: boundedOptions,
      };
      // Track even failed requests: the runner may have loaded weights before
      // generation failed, and a fallback must release those weights first.
      this.lastResidentModel = model;

      logInfo(`Calling Ollama model "${model}" (${messages.length} messages${jsonFormat ? ', JSON format' : ''})`);

      const res = await this._fetchWithTimeout(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, this.requestTimeoutMs);

      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`Ollama API error ${res.status}: ${text}`);
      }

      const data = await res.json() as OllamaChatResponse;
      if (keepAliveSeconds === 0) { this.lastResidentModel = null; }
      return data;
    } finally {
      releaseModelLoadLock();
    }
  }

  private async _fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    this.activeControllers.add(controller);
    try {
      const res = await this.transport(url, { ...init, signal: controller.signal });
      // fetch resolves when headers arrive. Keep cancellation and the deadline
      // active until the non-streaming JSON body finishes as well, otherwise a
      // stalled runner can hang forever after sending HTTP 200 headers.
      const body = await res.arrayBuffer();
      return new Response([204, 205, 304].includes(res.status) ? null : body, {
        status: res.status, statusText: res.statusText, headers: res.headers,
      });
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        if (this.cancellationRequested && !timedOut) {
          throw new UserAbortError();
        }
        throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      this.activeControllers.delete(controller);
      if (this.activeControllers.size === 0) {
        this.cancellationRequested = false;
      }
    }
  }

  private _normalizeModelName(model: string): string {
    return model.trim().toLowerCase().replace(/:latest$/, '');
  }

  private _matchesModelName(installedName: string, requestedName: string): boolean {
    return this._normalizeModelName(installedName) === this._normalizeModelName(requestedName);
  }

  private _writeCallLog(entry: OllamaCallLog): void {
    if (!this.logFilePath) { return; }
    try {
      const line = JSON.stringify(entry) + '\n';
      fs.appendFileSync(this.logFilePath, line, 'utf8');
    } catch (err) {
      logError(`Failed to write Ollama call log: ${err instanceof Error ? err.message : err}`);
    }
  }
}
