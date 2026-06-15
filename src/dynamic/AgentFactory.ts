import type { AgentSpec, AgentTeamPlan, OllamaMessage } from '../types';
import { logWarn } from '../utils/logging';

/** Minimal slice of OllamaClient the factory needs (keeps it unit-testable). */
export interface TeamDesignerClient {
  callWithFallbackJson<T>(
    primaryModel: string,
    fallbackModel: string,
    messages: OllamaMessage[],
    agentRole?: string,
    options?: { temperature?: number; num_ctx?: number },
    outputFile?: string,
    inputFiles?: string[]
  ): Promise<T>;
}

export interface AgentFactoryOptions {
  /** Distinct local models available to staff the team. */
  roster: string[];
  /** Tool names the spawned agents may be granted. */
  toolNames: string[];
  /** Strong model used by the meta-agent to design the team. */
  designerModel: string;
  designerFallback: string;
  minAgents?: number;
  maxAgents?: number;
}

/**
 * The "agent that creates agents". Given a boss goal it asks a strong local
 * model to DESIGN a bespoke team — each member with its own specialty, system
 * prompt, bound model and allowed tools — then validates and normalizes the
 * result so it is always runnable and always satisfies the project's core rule
 * of "at least five different-model agents". If the designer model is
 * unavailable, a deterministic generic team is synthesized instead, so the
 * capability never hard-fails.
 */
export class AgentFactory {
  private readonly roster: string[];
  private readonly toolNames: string[];
  private readonly minAgents: number;
  private readonly maxAgents: number;

  constructor(
    private readonly client: TeamDesignerClient,
    private readonly opts: AgentFactoryOptions
  ) {
    this.roster = [...new Set(opts.roster.filter(Boolean))];
    this.toolNames = [...new Set(opts.toolNames.filter(Boolean))];
    this.minAgents = Math.max(5, opts.minAgents ?? 5);
    this.maxAgents = Math.max(this.minAgents, opts.maxAgents ?? Math.max(this.minAgents, 7));
  }

  /** Design a team for a goal. Never throws — falls back to a generic team. */
  async designTeam(goal: string, context = '', outputFile = ''): Promise<AgentTeamPlan> {
    const trimmedGoal = goal.trim() || 'Accomplish the boss objective with the highest possible quality.';
    try {
      const raw = await this.client.callWithFallbackJson<RawTeam>(
        this.opts.designerModel,
        this.opts.designerFallback,
        this._designMessages(trimmedGoal, context),
        'agentFactory',
        { temperature: 0.4 },
        outputFile,
        []
      );
      const plan = this._normalizeTeam(raw, trimmedGoal);
      // If the model under-staffed or produced junk, top up deterministically.
      if (plan.agents.length < this.minAgents) {
        return this._mergeWithFallback(plan, trimmedGoal);
      }
      return plan;
    } catch (err) {
      logWarn(`AgentFactory designer model failed: ${err instanceof Error ? err.message : String(err)}. Using deterministic generic team.`);
      return this._fallbackTeam(trimmedGoal);
    }
  }

  // ------------------------------------------------------------------
  // Pure, unit-testable core
  // ------------------------------------------------------------------

  /** Coerce, validate, de-duplicate and diversify a raw designed team. */
  _normalizeTeam(raw: RawTeam | null | undefined, goal: string): AgentTeamPlan {
    const rawAgents = Array.isArray(raw?.agents) ? raw!.agents : [];
    const usedIds = new Set<string>();
    const usedModels = new Set<string>();
    const agents: AgentSpec[] = [];

    for (const candidate of rawAgents) {
      if (agents.length >= this.maxAgents) { break; }
      const spec = this._normalizeSpec(candidate, usedIds, usedModels);
      if (spec) {
        agents.push(spec);
        usedIds.add(spec.id);
        usedModels.add(spec.model);
      }
    }

    return {
      goal,
      rationale: typeof raw?.rationale === 'string' && raw.rationale.trim()
        ? raw.rationale.trim()
        : 'Team composed to cover the goal across complementary specialties.',
      agents,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Normalize a single agent spec, assigning a distinct model where possible. */
  private _normalizeSpec(
    candidate: Partial<AgentSpec> | undefined,
    usedIds: Set<string>,
    usedModels: Set<string>
  ): AgentSpec | null {
    if (!candidate || typeof candidate !== 'object') { return null; }
    const name = String(candidate.name ?? '').trim();
    const specialty = String(candidate.specialty ?? '').trim();
    if (!name && !specialty) { return null; }

    const baseId = this._slug(String(candidate.id ?? name ?? specialty));
    const id = this._uniqueId(baseId || 'agent', usedIds);

    // Bind a model: prefer the requested one if it is in the roster and unused,
    // otherwise the next free roster model, otherwise any roster model.
    const requested = String(candidate.model ?? '').trim();
    const model = this._pickModel(requested, usedModels);
    const fallbackModel = this._pickFallback(model);

    const tools = Array.isArray(candidate.tools)
      ? [...new Set(candidate.tools.map(t => String(t).trim()).filter(t => this.toolNames.includes(t)))]
      : [];

    const temperature = this._clampTemp(candidate.temperature);

    const mission = String(candidate.mission ?? (specialty || name)).trim();
    const systemPrompt = String(candidate.systemPrompt ?? '').trim()
      || this._defaultSystemPrompt(name || specialty, specialty || name, mission, tools);

    return {
      id,
      name: name || specialty,
      specialty: specialty || name,
      mission,
      systemPrompt,
      model,
      fallbackModel,
      tools,
      temperature,
    };
  }

  /** A deterministic, always-diverse generic team covering any goal. */
  _fallbackTeam(goal: string): AgentTeamPlan {
    const blueprint: Array<{ name: string; specialty: string; mission: string; tools: string[] }> = [
      { name: 'Researcher', specialty: 'domain & market research', mission: 'Gather current, cited facts and prior art relevant to the goal.', tools: this._toolsIfAvailable(['web_search', 'find_code_examples', 'read_repo_file', 'fetch_url', 'search']) },
      { name: 'Strategist', specialty: 'planning & decomposition', mission: 'Turn the goal into a sequenced, risk-aware plan with clear milestones.', tools: this._toolsIfAvailable(['search', 'read_file']) },
      { name: 'Architect', specialty: 'solution & system design', mission: 'Design the concrete approach, structure and key decisions.', tools: this._toolsIfAvailable(['read_file', 'search', 'find_code_examples']) },
      { name: 'Builder', specialty: 'execution & implementation', mission: 'Produce the actual deliverable (code, content, configuration).', tools: this._toolsIfAvailable(['read_file', 'search', 'apply_patch', 'run_command']) },
      { name: 'Critic', specialty: 'risk, quality & red-teaming', mission: 'Attack the plan and output for flaws, risks and gaps before commit.', tools: this._toolsIfAvailable(['read_file', 'search']) },
      { name: 'Integrator', specialty: 'synthesis & verification', mission: 'Reconcile the team, verify the result and prepare the final answer.', tools: this._toolsIfAvailable(['read_file', 'run_command', 'search']) },
    ];

    const usedIds = new Set<string>();
    const usedModels = new Set<string>();
    const agents: AgentSpec[] = [];
    for (const b of blueprint) {
      if (agents.length >= this.maxAgents) { break; }
      const id = this._uniqueId(this._slug(b.name), usedIds);
      const model = this._pickModel('', usedModels);
      usedIds.add(id);
      usedModels.add(model);
      agents.push({
        id,
        name: b.name,
        specialty: b.specialty,
        mission: b.mission,
        systemPrompt: this._defaultSystemPrompt(b.name, b.specialty, b.mission, b.tools),
        model,
        fallbackModel: this._pickFallback(model),
        tools: b.tools,
        temperature: b.name === 'Critic' ? 0.2 : 0.4,
      });
    }

    return {
      goal,
      rationale: 'Deterministic generic team (research → strategy → architecture → build → critique → integrate) used because no bespoke design was available.',
      agents,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Top up a thin designed team with distinct fallback members. */
  private _mergeWithFallback(plan: AgentTeamPlan, goal: string): AgentTeamPlan {
    const fallback = this._fallbackTeam(goal);
    const usedIds = new Set(plan.agents.map(a => a.id));
    const usedModels = new Set(plan.agents.map(a => a.model));
    const agents = [...plan.agents];
    for (const extra of fallback.agents) {
      if (agents.length >= this.minAgents) { break; }
      if (usedIds.has(extra.id)) { continue; }
      const model = this._pickModel(extra.model, usedModels);
      usedModels.add(model);
      usedIds.add(extra.id);
      agents.push({ ...extra, model, fallbackModel: this._pickFallback(model) });
    }
    return { ...plan, agents };
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private _designMessages(goal: string, context: string): OllamaMessage[] {
    const system = [
      'You are the META-AGENT: an agent that DESIGNS other agents.',
      'Given a boss goal, design a small team of specialist agents that, debating and collaborating, can achieve it with the highest possible quality.',
      'The team must be GENERIC to the goal — invent whatever specialties the goal needs (research, strategy, design, engineering, content, operations, finance, legal, QA, …). Do NOT assume it is a coding task unless the goal is.',
      `Design between ${this.minAgents} and ${this.maxAgents} agents, each with a DISTINCT specialty.`,
      `Bind each agent to ONE model from this roster (use different models across the team where possible): ${this.roster.join(', ') || '(none)'}.`,
      `Each agent may be granted any subset of these tools: ${this.toolNames.join(', ') || '(none)'}.`,
      'Write a focused, high-quality systemPrompt for each agent describing its mindset, responsibilities, and how it should collaborate and challenge others.',
      'Respond with ONLY valid JSON.',
    ].join('\n');

    const user = [
      `# Boss Goal\n${goal}`,
      context ? `\n# Context\n${context}` : '',
      '',
      'Return exactly this JSON shape:',
      '{',
      '  "rationale": "why this team composition fits the goal",',
      '  "agents": [',
      '    {',
      '      "id": "kebab-case-id",',
      '      "name": "Human Name",',
      '      "specialty": "one-line specialty",',
      '      "mission": "what this agent is accountable for",',
      '      "systemPrompt": "full system prompt for this agent",',
      `      "model": "one of: ${this.roster.join(' | ') || 'any'}",`,
      `      "tools": [${this.toolNames.map(t => `"${t}"`).join(', ')}],`,
      '      "temperature": 0.4',
      '    }',
      '  ]',
      '}',
    ].join('\n');

    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
  }

  private _defaultSystemPrompt(name: string, specialty: string, mission: string, tools: string[]): string {
    return [
      `You are ${name}, a specialist agent focused on ${specialty}.`,
      `Mission: ${mission}`,
      'You are part of a multi-agent team that debates to reach the highest-quality outcome.',
      'Argue from your specialty, propose concrete and actionable ideas, and challenge weak reasoning from others with specifics.',
      tools.length ? `You may use these tools when helpful: ${tools.join(', ')}.` : 'You work from reasoning and the shared context.',
      'Be precise, honest about uncertainty, and always optimize for the final quality of the result.',
    ].join('\n');
  }

  private _toolsIfAvailable(preferred: string[]): string[] {
    return preferred.filter(t => this.toolNames.includes(t));
  }

  private _pickModel(requested: string, usedModels: Set<string>): string {
    if (this.roster.length === 0) { return requested || 'unknown'; }
    if (requested && this.roster.includes(requested) && !usedModels.has(requested)) { return requested; }
    const free = this.roster.find(m => !usedModels.has(m));
    if (free) { return free; }
    // Roster exhausted — reuse, preferring the requested if valid.
    if (requested && this.roster.includes(requested)) { return requested; }
    return this.roster[usedModels.size % this.roster.length];
  }

  private _pickFallback(model: string): string {
    const other = this.roster.find(m => m !== model);
    return other ?? model;
  }

  private _clampTemp(value: unknown): number {
    const n = Number(value);
    if (!Number.isFinite(n)) { return 0.4; }
    return Math.max(0, Math.min(1, n));
  }

  private _slug(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
  }

  private _uniqueId(base: string, used: Set<string>): string {
    let id = base;
    let n = 2;
    while (used.has(id)) { id = `${base}-${n++}`; }
    return id;
  }
}

/** Loosely-typed model output before normalization. */
export interface RawTeam {
  rationale?: unknown;
  agents?: Array<Partial<AgentSpec>>;
}
