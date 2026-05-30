import * as fs from 'fs';
import * as path from 'path';
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

// Default request timeout in milliseconds
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

export class OllamaClient {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private logFilePath: string | null = null;
  private readonly activeControllers = new Set<AbortController>();
  private cancellationRequested = false;

  constructor(baseUrl: string, logFilePath?: string, requestTimeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.logFilePath = logFilePath ?? null;
    this.requestTimeoutMs = Math.max(30_000, requestTimeoutMs);
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
   * Model is kept warm in VRAM for 60 s after the response so rapid
   * consecutive calls (e.g. brainstorm → critic) avoid reload overhead.
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
    let aborted = false;

    try {
      const response = await this._sendChatRequest(model, messages, false, options);
      content = response.message?.content ?? '';
      success = true;
      return content;
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      aborted = err instanceof UserAbortError;
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
      // keep_alive:60 in the request body lets Ollama evict the model
      // automatically after 60 s of inactivity. No explicit unload needed.
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
    let aborted = false;

    try {
      const response = await this._sendChatRequest(model, messages, true, options);
      const raw = response.message?.content ?? '{}';
      const { parseJsonResponse } = await import('../utils/json');
      const parsed = parseJsonResponse<T>(raw);
      success = true;
      return parsed;
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      aborted = err instanceof UserAbortError;
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
        messages: [{ role: 'user', content: '' }],
        stream: false,
        keep_alive: 0,
      };
      await this._fetchWithTimeout(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, 10_000);
      logInfo(`Model "${model}" unloaded from RAM.`);
    } catch {
      // Unload failures are non-fatal
    }
  }

  /**
   * Abort any in-flight Ollama fetches. Used by the Stop command so VS Code
   * does not appear stuck while a large local model is generating.
   */
  cancelActiveRequests(): void {
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
      const res = await this._fetchWithTimeout(`${this.baseUrl}/api/tags`, {}, 5_000);
      if (!res.ok) { return false; }
      const data = await res.json() as { models?: Array<{ name: string }> };
      const models = data.models ?? [];
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
    try {
      const res = await this._fetchWithTimeout(`${this.baseUrl}/api/tags`, {}, 5_000);
      if (!res.ok) { return []; }
      const data = await res.json() as { models?: Array<{ name: string }> };
      return (data.models ?? []).map(m => m.name);
    } catch (err) {
      if (err instanceof UserAbortError) { throw err; }
      return [];
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
    const isConnected = await this.checkConnection();
    if (!isConnected) {
      throw new OllamaConnectionError(this.baseUrl);
    }

    const isAvailable = await this.checkModelAvailable(model);
    if (!isAvailable) {
      throw new ModelNotFoundError(model);
    }

    // Keep the model warm in VRAM for 60 s when it is expected to be called
    // again soon (all non-JSON text calls, e.g. brainstorm → critic → brief).
    // JSON calls unload immediately because they are typically one-shot per task.
    const keepAliveSeconds = jsonFormat ? 0 : 60;
    const body: OllamaChatRequest = {
      model,
      messages,
      stream: false,
      keep_alive: keepAliveSeconds,
      ...(jsonFormat ? { format: 'json' } : {}),
      options: options ?? {},
    };

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
    return data;
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
      const res = await fetch(url, { ...init, signal: controller.signal });
      return res;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
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

  private _matchesModelName(installedName: string, requestedName: string): boolean {
    if (installedName === requestedName) { return true; }
    if (!requestedName.includes(':') && installedName === `${requestedName}:latest`) { return true; }
    return false;
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
