import type {
  ModelProbeResult,
  ModelReadinessReport,
  OllamaMessage,
} from '../types';
import { UserAbortError } from '../utils/errors';
import type { LocalModelInventoryEntry, LocalModelDetails } from '../ollama/OllamaClient';

const EMBEDDING_MODEL = /(?:^|[-/])embedd?ing(?:[:/-]|$)/i;
const UNSTABLE_AUTOMATIC_MODEL = /^qwen3-coder:30b(?:-|$)/i;

/** Automatic discovery policy; an explicit configured model remains an opt-in. */
export function isAutomaticTextModelCandidate(model: string): boolean {
  return !EMBEDDING_MODEL.test(model) && !UNSTABLE_AUTOMATIC_MODEL.test(model);
}

export interface ModelReadinessClient {
  checkConnection(): Promise<boolean>;
  listModels(): Promise<string[]>;
  listModelInventory?(): Promise<LocalModelInventoryEntry[]>;
  getModelDetails?(model: string): Promise<LocalModelDetails | undefined>;
  chat(
    model: string,
    messages: OllamaMessage[],
    agentRole?: string,
    options?: { temperature?: number; num_ctx?: number; num_predict?: number }
  ): Promise<string>;
  unloadModel?(model: string): Promise<void>;
}

export type ModelReadinessProgressEvent =
  | { type: 'inventory'; installedCount: number; candidateCount: number; requiredDistinctModels: number }
  | { type: 'skip'; model: string; reason: string }
  | { type: 'probe-start'; model: string; index: number; total: number; sizeBytes?: number }
  | { type: 'probe-success'; model: string; durationMs: number }
  | { type: 'probe-failure'; model: string; durationMs: number; error: string }
  | { type: 'probe-empty'; model: string; durationMs: number }
  | { type: 'summary'; selectedModels: string[]; reserveModels: string[]; status: ModelReadinessReport['status'] };

export type ModelReadinessProgressHandler = (event: ModelReadinessProgressEvent) => void;

/**
 * Resolves configured names against Ollama's real inventory and probes models
 * one-by-one. A debate may only claim five-model diversity when five exact,
 * distinct models have successfully answered without fallback.
 */
export class ModelReadinessService {
  constructor(
    private readonly client: ModelReadinessClient,
    private readonly requiredDistinctModels = 5,
    private readonly onProgress?: ModelReadinessProgressHandler
  ) {}

  async assess(configuredModels: string[]): Promise<ModelReadinessReport> {
    const configured = this._unique(configuredModels);
    const guidance: string[] = [];
    if (!(await this.client.checkConnection())) {
      return this._report('blocked', configured, [], [], [], configured, [], [
        'Start Ollama and verify that its /api/tags endpoint is reachable.',
      ]);
    }

    const inventory = this.client.listModelInventory ? await this.client.listModelInventory() : [];
    const installed = this._unique(inventory.length > 0 ? inventory.map(model => model.name) : await this.client.listModels());
    const inventoryByName = new Map(inventory.map(model => [this._normalize(model.name), model]));
    const installedByName = new Map(installed.map(model => [this._normalize(model), model]));
    const configuredResolved = configured
      .map(model => installedByName.get(this._normalize(model)))
      .filter((model): model is string => Boolean(model));
    const missingConfigured = configured.filter(model => !installedByName.has(this._normalize(model)));
    const configuredNames = new Set(configuredResolved.map(model => this._normalize(model)));
    const candidates = this._sortCandidatesByCost(this._unique([
      ...configuredResolved,
      ...installed.filter(model => !configuredNames.has(this._normalize(model))),
    ]), inventoryByName, configuredNames);
    this.onProgress?.({
      type: 'inventory',
      installedCount: installed.length,
      candidateCount: candidates.length,
      requiredDistinctModels: this.requiredDistinctModels,
    });

    const probes: ModelProbeResult[] = [];
    const responsiveModels: string[] = [];
    const responsiveDigests = new Set<string>();
    let probeIndex = 0;
    for (const model of candidates) {
      // Probe one extra exact model when available so close votes can use an
      // independent model that did not participate in normal scoring.
      if (responsiveModels.length >= this.requiredDistinctModels + 1) { break; }
      // Do not rediscover the known repeated SIGBUS default as a reserve.
      // Users can still explicitly opt into it in model_config.json.
      if (UNSTABLE_AUTOMATIC_MODEL.test(model) && !configuredNames.has(this._normalize(model))) {
        const reason = 'repeated local SIGBUS history; explicit configuration is required';
        guidance.push(`Skipped automatic selection of ${model}: ${reason}.`);
        this.onProgress?.({ type: 'skip', model, reason });
        continue;
      }
      const digest = inventoryByName.get(this._normalize(model))?.digest;
      if (digest && responsiveDigests.has(digest)) {
        const reason = 'its model digest matches an already selected model';
        guidance.push(`Skipped ${model}: ${reason}.`);
        this.onProgress?.({ type: 'skip', model, reason });
        continue;
      }
      const startedAt = Date.now();
      let responsive = false;
      let error: string | undefined;
      let probed = false;
      try {
        const details = await this.client.getModelDetails?.(model);
        if ((details?.capabilities && !details.capabilities.includes('completion')) || EMBEDDING_MODEL.test(model)) {
          const reason = 'not a text-completion model';
          guidance.push(`Skipped ${model}: ${reason}.`);
          this.onProgress?.({ type: 'skip', model, reason });
          continue;
        }
        probed = true;
        probeIndex += 1;
        this.onProgress?.({
          type: 'probe-start',
          model,
          index: probeIndex,
          total: candidates.length,
          sizeBytes: inventoryByName.get(this._normalize(model))?.size,
        });
        const answer = await this.client.chat(
          model,
          [
            { role: 'system', content: 'You are a runtime readiness probe.' },
            { role: 'user', content: 'Reply with exactly READY.' },
          ],
          'model-readiness',
          { temperature: 0, num_ctx: 1024, num_predict: 8 }
        );
        responsive = answer.trim().length > 0;
        if (!responsive) { error = 'Model returned an empty response.'; }
      } catch (err) {
        if (err instanceof UserAbortError) { throw err; }
        error = err instanceof Error ? err.message : String(err);
      } finally {
        if (probed && this.client.unloadModel) {
          try { await this.client.unloadModel(model); }
          catch (err) {
            if (err instanceof UserAbortError) { throw err; }
            // Non-cancellation cleanup failures do not invalidate a response.
          }
        }
      }
      probes.push({
        model,
        configured: configuredNames.has(this._normalize(model)),
        installed: true,
        responsive,
        durationMs: Date.now() - startedAt,
        ...(error ? { error } : {}),
      });
      if (responsive) {
        this.onProgress?.({ type: 'probe-success', model, durationMs: Date.now() - startedAt });
        responsiveModels.push(model);
        if (digest) { responsiveDigests.add(digest); }
      } else if (error) {
        this.onProgress?.({ type: 'probe-failure', model, durationMs: Date.now() - startedAt, error });
      } else {
        this.onProgress?.({ type: 'probe-empty', model, durationMs: Date.now() - startedAt });
      }
    }
    const selected = responsiveModels.slice(0, this.requiredDistinctModels);
    const reserves = responsiveModels.slice(this.requiredDistinctModels);

    if (missingConfigured.length > 0) {
      guidance.push(`Configured models not installed: ${missingConfigured.join(', ')}.`);
      guidance.push(`Install a missing model with: ollama pull <model>.`);
    }
    const failed = probes.filter(probe => !probe.responsive).map(probe => probe.model);
    if (failed.length > 0) {
      guidance.push(`Installed models that failed the readiness call: ${failed.join(', ')}.`);
    }
    if (selected.length < this.requiredDistinctModels) {
      guidance.push(
        `Install and validate at least ${this.requiredDistinctModels} distinct local models; only ${selected.length} responded successfully.`
      );
    }

    const status = selected.length < this.requiredDistinctModels
      ? 'blocked'
      : missingConfigured.length > 0 || probes.some(probe => !probe.responsive)
        ? 'degraded'
        : 'strict-5-model';
    this.onProgress?.({ type: 'summary', selectedModels: selected, reserveModels: reserves, status });
    return this._report(status, configured, installed, selected, reserves, missingConfigured, probes, guidance);
  }

  private _report(
    status: ModelReadinessReport['status'],
    configuredModels: string[],
    installedModels: string[],
    selectedModels: string[],
    reserveModels: string[],
    missingConfiguredModels: string[],
    probes: ModelProbeResult[],
    guidance: string[]
  ): ModelReadinessReport {
    return {
      generatedAt: new Date().toISOString(),
      status,
      requiredDistinctModels: this.requiredDistinctModels,
      configuredModels,
      installedModels,
      selectedModels,
      reserveModels,
      missingConfiguredModels,
      probes,
      guidance,
    };
  }

  private _unique(models: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of models) {
      const model = String(raw ?? '').trim();
      const normalized = this._normalize(model);
      if (!model || seen.has(normalized)) { continue; }
      seen.add(normalized);
      result.push(model);
    }
    return result;
  }

  private _normalize(model: string): string {
    return model.trim().toLowerCase().replace(/:latest$/, '');
  }

  private _sortCandidatesByCost(
    candidates: string[],
    inventoryByName: Map<string, LocalModelInventoryEntry>,
    configuredNames: Set<string>
  ): string[] {
    return candidates
      .map((model, index) => ({
        model,
        index,
        configured: configuredNames.has(this._normalize(model)),
        size: inventoryByName.get(this._normalize(model))?.size ?? Number.POSITIVE_INFINITY,
      }))
      .sort((a, b) => {
        if (a.configured !== b.configured) { return a.configured ? -1 : 1; }
        if (a.size !== b.size) { return a.size - b.size; }
        return a.index - b.index;
      })
      .map(entry => entry.model);
  }
}
