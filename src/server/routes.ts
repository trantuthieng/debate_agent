import type { OllamaClient } from '../ollama/OllamaClient';
import { ChatConfigStore, type ChatConfig } from './chatConfig';
import { MIN_QA_AGENTS, MAX_QA_AGENTS } from '../prompts/qaPersonas';
import { MAX_ROUNDS } from './chatConfig';

export interface RouteContext {
  configStore: ChatConfigStore;
  ollama: OllamaClient;
}

export interface RouteResult {
  status: number;
  body: unknown;
}

export function handleGetConfig(ctx: RouteContext): RouteResult {
  return { status: 200, body: { ...ctx.configStore.read(), minAgents: MIN_QA_AGENTS, maxAgents: MAX_QA_AGENTS, maxRounds: MAX_ROUNDS } };
}

export function handlePostConfig(ctx: RouteContext, body: unknown): RouteResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { error: 'Expected a JSON object with rounds/agentCount/webSearchEnabled.' } };
  }
  const updated = ctx.configStore.write(body as Partial<ChatConfig>);
  return { status: 200, body: { ...updated, minAgents: MIN_QA_AGENTS, maxAgents: MAX_QA_AGENTS, maxRounds: MAX_ROUNDS } };
}

export async function handleGetModels(ctx: RouteContext): Promise<RouteResult> {
  try {
    const models = await ctx.ollama.listModels();
    return { status: 200, body: { models, minAgents: MIN_QA_AGENTS, maxAgents: MAX_QA_AGENTS } };
  } catch (err) {
    return { status: 502, body: { error: `Could not reach Ollama: ${err instanceof Error ? err.message : String(err)}` } };
  }
}
