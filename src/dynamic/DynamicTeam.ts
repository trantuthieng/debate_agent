import type {
  AgentTeamPlan,
  AgentSpec,
  DynamicAgentScore,
  DynamicTeamDecision,
  OllamaMessage,
} from '../types';
import { DynamicAgent, type DynamicToolRunner } from './DynamicAgent';
import { logWarn } from '../utils/logging';

/** OllamaClient slice the team needs: text + JSON calls. */
export interface DynamicTeamClient {
  callWithFallback(
    primaryModel: string, fallbackModel: string, messages: OllamaMessage[],
    agentRole?: string, options?: { temperature?: number; num_ctx?: number },
    outputFile?: string, inputFiles?: string[]
  ): Promise<string>;
  callWithFallbackJson<T>(
    primaryModel: string, fallbackModel: string, messages: OllamaMessage[],
    agentRole?: string, options?: { temperature?: number; num_ctx?: number },
    outputFile?: string, inputFiles?: string[]
  ): Promise<T>;
}

export interface DynamicTeamEvents {
  onRound?: (round: number, label: string) => void;
  onAgent?: (round: number, agentId: string, summary: string) => void;
}

interface Proposal { agentId: string; agentName: string; proposal: string; }

/**
 * Coordinates a team of runtime-defined agents through the project's debate
 * protocol so the spawned agents genuinely argue to the best answer:
 *   R1 propose → R2 cross-critique → R3 refine → R4 score & vote.
 * Produces a {@link DynamicTeamDecision} plus a full markdown transcript.
 */
export class DynamicTeam {
  constructor(
    private readonly client: DynamicTeamClient,
    private readonly toolRunner?: DynamicToolRunner,
    private readonly maxToolRounds = 3
  ) {}

  async run(
    plan: AgentTeamPlan,
    events: DynamicTeamEvents = {}
  ): Promise<{ decision: DynamicTeamDecision; transcript: string }> {
    const goal = plan.goal;
    const agents = plan.agents.map(spec => new DynamicAgent(this.client, spec, this.toolRunner, this.maxToolRounds));
    const transcript: string[] = [`# Dynamic Team Debate\n\n**Goal:** ${goal}\n\n**Rationale:** ${plan.rationale}\n`];

    // ---- Round 1: each agent proposes its approach ----
    events.onRound?.(1, 'Proposals');
    const proposals: Proposal[] = [];
    for (let i = 0; i < agents.length; i++) {
      const spec = plan.agents[i];
      const text = await this._safe(() => agents[i].respond(
        `Propose YOUR approach to achieving the goal, from your specialty (${spec.specialty}). Be concrete and actionable.`,
        `Goal: ${goal}`
      ), `${spec.name} could not produce a proposal.`);
      proposals.push({ agentId: spec.id, agentName: spec.name, proposal: text });
      events.onAgent?.(1, spec.id, this._clip(text, 120));
    }
    transcript.push(this._section('Round 1 — Proposals', proposals.map(p => `### ${p.agentName} (${p.agentId})\n${p.proposal}`)));

    // ---- Round 2: each agent critiques the others ----
    events.onRound?.(2, 'Cross-critique');
    const critiques: Array<{ agentId: string; agentName: string; critique: string }> = [];
    for (let i = 0; i < agents.length; i++) {
      const spec = plan.agents[i];
      const others = proposals.filter(p => p.agentId !== spec.id);
      const text = await this._safe(() => agents[i].respond(
        'Critique the OTHER proposals below. For each, name concrete strengths, risks, and gaps. Be specific and fair.',
        `Goal: ${goal}\n\n${others.map(o => `## ${o.agentName}\n${o.proposal}`).join('\n\n')}`
      ), `${spec.name} could not produce a critique.`);
      critiques.push({ agentId: spec.id, agentName: spec.name, critique: text });
      events.onAgent?.(2, spec.id, this._clip(text, 120));
    }
    transcript.push(this._section('Round 2 — Cross-critique', critiques.map(c => `### ${c.agentName}\n${c.critique}`)));

    // ---- Round 3: each agent refines its proposal ----
    events.onRound?.(3, 'Refinement');
    const allCritiques = critiques.map(c => `## ${c.agentName}\n${c.critique}`).join('\n\n');
    for (let i = 0; i < agents.length; i++) {
      const spec = plan.agents[i];
      const own = proposals[i];
      const refined = await this._safe(() => agents[i].respond(
        'Refine YOUR proposal in light of the critiques. Keep what holds up, fix what was challenged, and state the final version clearly.',
        `Goal: ${goal}\n\n# Your original proposal\n${own.proposal}\n\n# Critiques of the team\n${allCritiques}`
      ), own.proposal);
      proposals[i] = { ...own, proposal: refined };
      events.onAgent?.(3, spec.id, this._clip(refined, 120));
    }
    transcript.push(this._section('Round 3 — Refined proposals', proposals.map(p => `### ${p.agentName}\n${p.proposal}`)));

    // ---- Round 4: each agent scores every refined proposal ----
    events.onRound?.(4, 'Scoring & vote');
    const scores = await this._scoreAll(plan.agents, proposals, goal);
    const decision = this._aggregate(goal, proposals, scores);
    transcript.push(this._section('Round 4 — Scores', [
      ...decision.ranked.map((r, i) => `${i + 1}. **${this._name(proposals, r.agentId)}** — ${r.score.toFixed(2)}/10`),
      '',
      `**Winner:** ${this._name(proposals, decision.winningAgentId)} (${decision.weightedScore.toFixed(2)}/10, ${decision.agreement} agreement)`,
      '',
      `**Rationale:** ${decision.rationale}`,
    ]));

    return { decision, transcript: transcript.join('\n\n') };
  }

  // ------------------------------------------------------------------
  // Scoring + pure aggregation
  // ------------------------------------------------------------------

  private async _scoreAll(specs: AgentSpec[], proposals: Proposal[], goal: string): Promise<DynamicAgentScore[]> {
    const all: DynamicAgentScore[] = [];
    const proposalsBlock = proposals.map(p => `### id: ${p.agentId}\n${p.proposal}`).join('\n\n');
    for (const spec of specs) {
      const messages: OllamaMessage[] = [
        { role: 'system', content: `You are ${spec.name}, judging the team's proposals on how well they achieve the goal. Score honestly 0-10. Respond with ONLY valid JSON.` },
        { role: 'user', content: [
          `# Goal\n${goal}`,
          `\n# Proposals\n${proposalsBlock}`,
          '\nReturn exactly: {"scores":[{"proposalId":"<id>","score":0,"reason":"why"}]}',
        ].join('\n') },
      ];
      try {
        const raw = await this.client.callWithFallbackJson<{ scores?: Array<{ proposalId?: unknown; score?: unknown; reason?: unknown }> }>(
          spec.model, spec.fallbackModel, messages, `dynamic-judge:${spec.id}`, { temperature: 0.1 }
        );
        for (const s of raw.scores ?? []) {
          const proposalId = String(s.proposalId ?? '');
          if (!proposals.some(p => p.agentId === proposalId)) { continue; }
          all.push({
            judgeId: spec.id,
            proposalId,
            score: this._clampScore(s.score),
            reason: String(s.reason ?? '').slice(0, 300),
          });
        }
      } catch (err) {
        logWarn(`Dynamic judge "${spec.id}" failed to score: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return all;
  }

  /**
   * Pure aggregation: mean score per proposal across all judges, ranked; the
   * highest mean wins; agreement is derived from how tightly the judges scored
   * the winner. Exposed for unit testing (no model calls).
   */
  _aggregate(goal: string, proposals: Proposal[], scores: DynamicAgentScore[]): DynamicTeamDecision {
    const byProposal = new Map<string, number[]>();
    for (const p of proposals) { byProposal.set(p.agentId, []); }
    for (const s of scores) { byProposal.get(s.proposalId)?.push(s.score); }

    const ranked = proposals
      .map(p => {
        const list = byProposal.get(p.agentId) ?? [];
        const mean = list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0;
        return { agentId: p.agentId, proposal: p.proposal, score: mean };
      })
      .sort((a, b) => b.score - a.score);

    if (ranked.length === 0) {
      return {
        goal, winningAgentId: '', winningProposal: '', weightedScore: 0,
        agreement: 'low', ranked: [], rationale: 'No proposals were produced.',
        generatedAt: new Date().toISOString(),
      };
    }

    const winner = ranked[0];
    const winnerScores = byProposal.get(winner.agentId) ?? [];
    const agreement = this._agreement(winnerScores);

    return {
      goal,
      winningAgentId: winner.agentId,
      winningProposal: winner.proposal,
      weightedScore: Math.round(winner.score * 100) / 100,
      agreement,
      ranked: ranked.map(r => ({ agentId: r.agentId, proposal: r.proposal, score: Math.round(r.score * 100) / 100 })),
      rationale: `Selected the proposal with the highest mean score (${winner.score.toFixed(2)}/10) across ${scores.length} judge votes.`,
      generatedAt: new Date().toISOString(),
    };
  }

  private _agreement(scores: number[]): 'high' | 'medium' | 'low' {
    if (scores.length < 2) { return 'low'; }
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
    const std = Math.sqrt(variance);
    if (std <= 1.0) { return 'high'; }
    if (std <= 2.0) { return 'medium'; }
    return 'low';
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private async _safe(fn: () => Promise<string>, fallback: string): Promise<string> {
    try {
      const out = (await fn()).trim();
      return out || fallback;
    } catch (err) {
      logWarn(`Dynamic team step failed: ${err instanceof Error ? err.message : String(err)}`);
      return fallback;
    }
  }

  private _clampScore(value: unknown): number {
    const n = Number(value);
    if (!Number.isFinite(n)) { return 5; }
    return Math.max(0, Math.min(10, n));
  }

  private _name(proposals: Proposal[], agentId: string): string {
    return proposals.find(p => p.agentId === agentId)?.agentName ?? agentId;
  }

  private _section(title: string, parts: string[]): string {
    return `## ${title}\n\n${parts.join('\n\n')}`;
  }

  private _clip(text: string, max: number): string {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max)}…` : t;
  }
}
