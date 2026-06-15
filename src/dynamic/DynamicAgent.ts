import type { AgentSpec, OllamaMessage, ToolCallRequest, ToolCallResult } from '../types';
import { logWarn } from '../utils/logging';

/** Minimal OllamaClient slice the dynamic agent needs (keeps it testable). */
export interface DynamicAgentClient {
  callWithFallback(
    primaryModel: string,
    fallbackModel: string,
    messages: OllamaMessage[],
    agentRole?: string,
    options?: { temperature?: number; num_ctx?: number },
    outputFile?: string,
    inputFiles?: string[]
  ): Promise<string>;
}

/** Minimal tool-registry slice for granting a dynamic agent its tools. */
export interface DynamicToolRunner {
  execute(request: ToolCallRequest): Promise<ToolCallResult>;
}

/**
 * Executes a single runtime-defined agent (an {@link AgentSpec}). It applies the
 * agent's tailored system prompt, binds its model, and — when the agent was
 * granted tools — runs a bounded tool loop so the agent can read files, search,
 * research the web/GitHub, etc. before producing its answer.
 */
export class DynamicAgent {
  constructor(
    private readonly client: DynamicAgentClient,
    private readonly spec: AgentSpec,
    private readonly tools?: DynamicToolRunner,
    private readonly maxToolRounds = 3
  ) {}

  get id(): string { return this.spec.id; }
  get name(): string { return this.spec.name; }
  get model(): string { return this.spec.model; }

  /**
   * Ask the agent to respond to `task` within `sharedContext`. If the agent has
   * tools, it may emit a JSON tool request (one per turn); results are fed back
   * until it returns a final answer or the round budget is exhausted.
   */
  async respond(task: string, sharedContext = ''): Promise<string> {
    const messages: OllamaMessage[] = [
      { role: 'system', content: this._systemPrompt() },
      { role: 'user', content: this._userPrompt(task, sharedContext) },
    ];

    if (!this.tools || this.spec.tools.length === 0) {
      return (await this._call(messages)).trim();
    }

    for (let round = 0; round < this.maxToolRounds; round++) {
      const reply = await this._call(messages);
      const toolCall = this._parseToolCall(reply);
      if (!toolCall) { return this._stripToolEnvelope(reply); }

      messages.push({ role: 'assistant', content: reply });
      const result = await this._runTool(toolCall);
      messages.push({
        role: 'user',
        content: `Tool "${toolCall.name}" result:\n${result.success ? result.output : `ERROR: ${result.error}`}\n\nUse this to produce your final answer, or request another tool.`,
      });
    }

    // Budget exhausted — force a final answer without further tools.
    messages.push({ role: 'user', content: 'Stop using tools now and give your final answer in plain text.' });
    return this._stripToolEnvelope(await this._call(messages));
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private _systemPrompt(): string {
    if (this.tools && this.spec.tools.length > 0) {
      return [
        this.spec.systemPrompt,
        '',
        'TOOLS: To use a tool, reply with ONLY a JSON object on its own:',
        '{"tool":"<name>","args":{...}}',
        `Available tools: ${this.spec.tools.join(', ')}.`,
        'When you do not need a tool, reply with your final answer as plain prose (no JSON).',
      ].join('\n');
    }
    return this.spec.systemPrompt;
  }

  private _userPrompt(task: string, sharedContext: string): string {
    return [
      sharedContext ? `# Shared Context\n${sharedContext}\n` : '',
      `# Your Task\n${task}`,
    ].filter(Boolean).join('\n');
  }

  private async _call(messages: OllamaMessage[]): Promise<string> {
    return this.client.callWithFallback(
      this.spec.model,
      this.spec.fallbackModel,
      messages,
      `dynamic:${this.spec.id}`,
      { temperature: this.spec.temperature }
    );
  }

  private _parseToolCall(reply: string): { name: string; args: Record<string, unknown> } | null {
    const text = reply.trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) { return null; }
    try {
      const obj = JSON.parse(text.slice(start, end + 1)) as { tool?: unknown; args?: unknown };
      if (typeof obj.tool !== 'string') { return null; }
      const name = obj.tool;
      if (!this.spec.tools.includes(name)) { return null; }
      const args = obj.args && typeof obj.args === 'object' ? obj.args as Record<string, unknown> : {};
      return { name, args };
    } catch {
      return null;
    }
  }

  private async _runTool(call: { name: string; args: Record<string, unknown> }): Promise<ToolCallResult> {
    try {
      return await this.tools!.execute({ id: `${this.spec.id}-${call.name}`, name: call.name, args: call.args });
    } catch (err) {
      logWarn(`Dynamic agent "${this.spec.id}" tool "${call.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
      return { id: this.spec.id, name: call.name, success: false, output: '', error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Remove a leftover tool-call JSON envelope if the model emitted one anyway. */
  private _stripToolEnvelope(reply: string): string {
    const trimmed = reply.trim();
    if (/^\{[\s\S]*"tool"\s*:/.test(trimmed)) {
      return 'No final answer was produced (the agent kept requesting tools).';
    }
    return trimmed;
  }
}
