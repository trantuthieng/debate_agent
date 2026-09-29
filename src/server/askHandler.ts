import type { OllamaClient } from '../ollama/OllamaClient';
import { ModelReadinessService, type ModelReadinessProgressEvent } from '../services/modelReadinessService';
import { ResearchService } from '../services/researchService';
import { QaDebate, type QaDebateEvents } from '../dynamic/QaDebate';
import { buildQaAgentSpecs, MIN_QA_AGENTS } from '../prompts/qaPersonas';
import type { ChatConfig } from './chatConfig';
import { logWarn } from '../utils/logging';

export type AskEvent =
  | { type: 'status'; message: string }
  | { type: 'round'; round: number; label: string }
  | { type: 'agent'; round: number; agentId: string; summary: string }
  | { type: 'transcript'; transcript: string }
  | { type: 'answer'; answer: string; transcript: string }
  | { type: 'error'; message: string };

/**
 * Wires readiness → (optional) web research → QaDebate for one chat
 * question, streaming progress via `onEvent`. Never throws — every failure
 * path (not enough ready models, research failure, a debate agent crashing)
 * is reported as an `{type:'error'}` event instead, since the caller (the
 * WebSocket handler) has no other channel to receive a thrown exception on.
 *
 * `client` accepts a real `OllamaClient` or anything satisfying the same
 * shape — tests construct a real `OllamaClient` with a fake injectable
 * `transport` (the pattern already used by `test/unit/ollama*.test.js`)
 * rather than a bespoke duck-typed stub, since `OllamaClient` already
 * implements every interface this function's dependencies need
 * (`ModelReadinessClient`, `DynamicTeamClient`).
 */
export async function answerQuestion(
  client: OllamaClient,
  question: string,
  config: ChatConfig,
  onEvent: (event: AskEvent) => void,
  researchServiceFactory: (cfg: ChatConfig) => Pick<ResearchService, 'webResearch'> = defaultResearchServiceFactory
): Promise<void> {
  try {
    onEvent({ type: 'status', message: 'Checking which configured models are ready...' });
    const installed = await client.listModels();
    const readiness = await new ModelReadinessService(client, config.agentCount, event => {
      onEvent({ type: 'status', message: formatReadinessProgress(event) });
    }).assess(installed);

    if (readiness.selectedModels.length < MIN_QA_AGENTS) {
      onEvent({
        type: 'error',
        message: `Only ${readiness.selectedModels.length} distinct model(s) are installed and responsive; need at least ${MIN_QA_AGENTS} for a debate. ${readiness.guidance.join(' ')}`.trim(),
      });
      return;
    }

    const effectiveAgentCount = Math.min(config.agentCount, readiness.selectedModels.length);
    if (effectiveAgentCount < config.agentCount) {
      onEvent({
        type: 'status',
        message: `Only ${effectiveAgentCount} of your configured ${config.agentCount} agents have a ready model right now; continuing with ${effectiveAgentCount}.`,
      });
    }

    let sharedContext = '';
    if (config.webSearchEnabled) {
      onEvent({ type: 'status', message: 'Researching the web for current information...' });
      try {
        const research = researchServiceFactory(config);
        const outcome = await research.webResearch(question);
        sharedContext = ResearchService.format(outcome);
      } catch (err) {
        logWarn(`Q&A web research failed, continuing without it: ${err instanceof Error ? err.message : String(err)}`);
        onEvent({ type: 'status', message: 'Web research failed; continuing without it.' });
      }
    }

    const agentSpecs = buildQaAgentSpecs(effectiveAgentCount, readiness.selectedModels);
    const debate = new QaDebate(client);
    const events: QaDebateEvents = {
      onRound: (round, label) => onEvent({ type: 'round', round, label }),
      onAgent: (round, agentId, summary) => onEvent({ type: 'agent', round, agentId, summary }),
      onTranscriptUpdate: transcript => onEvent({ type: 'transcript', transcript }),
    };
    const { answer, transcript } = await debate.run(question, agentSpecs, config.rounds, sharedContext, events);
    onEvent({ type: 'answer', answer, transcript });
  } catch (err) {
    onEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

function defaultResearchServiceFactory(): ResearchService {
  return new ResearchService({ webSearch: { enabled: true, maxResults: 5, officialDocsOnly: false, allowedDomains: [] } });
}

function formatReadinessProgress(event: ModelReadinessProgressEvent): string {
  switch (event.type) {
    case 'inventory':
      return `Found ${event.installedCount} installed model(s); probing up to ${event.requiredDistinctModels} ready model(s) from ${event.candidateCount} candidate(s).`;
    case 'skip':
      return `Skipping ${event.model}: ${event.reason}.`;
    case 'probe-start':
      return `Probing model ${event.index}/${event.total}: ${event.model}${event.sizeBytes ? ` (${formatBytes(event.sizeBytes)})` : ''}...`;
    case 'probe-success':
      return `Model ready: ${event.model} (${formatDuration(event.durationMs)}).`;
    case 'probe-failure':
      return `Model failed: ${event.model} (${formatDuration(event.durationMs)}): ${event.error}`;
    case 'probe-empty':
      return `Model returned empty response: ${event.model} (${formatDuration(event.durationMs)}).`;
    case 'summary':
      return `Readiness ${event.status}: selected ${event.selectedModels.join(', ') || 'none'}${event.reserveModels.length ? `; reserve ${event.reserveModels.join(', ')}` : ''}.`;
    default:
      return 'Readiness progress updated.';
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) { return `${ms}ms`; }
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function formatBytes(bytes: number): string {
  const gib = bytes / (1024 ** 3);
  if (gib >= 1) { return `${gib.toFixed(1)} GiB`; }
  const mib = bytes / (1024 ** 2);
  return `${mib.toFixed(0)} MiB`;
}
