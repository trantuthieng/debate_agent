import type {
  AgentTeamPlan,
  DynamicAgentScore,
  DynamicTeamCheckpoint,
  DynamicTeamDecision,
  OllamaMessage,
} from '../types';
import { DynamicAgent, type DynamicToolRunner } from './DynamicAgent';
import { logWarn } from '../utils/logging';
import { UserAbortError } from '../utils/errors';
import { retryWithBackoff, type RetryPolicy } from '../utils/retry';

/** OllamaClient slice the team needs: text + JSON calls. */
export interface DynamicTeamClient {
  callWithFallback(
    primaryModel: string, fallbackModel: string, messages: OllamaMessage[],
    agentRole?: string, options?: { temperature?: number; num_ctx?: number; num_predict?: number },
    outputFile?: string, inputFiles?: string[]
  ): Promise<string>;
  callWithFallbackJson<T>(
    primaryModel: string, fallbackModel: string, messages: OllamaMessage[],
    agentRole?: string, options?: { temperature?: number; num_ctx?: number; num_predict?: number },
    outputFile?: string, inputFiles?: string[]
  ): Promise<T>;
  chatJson?<T>(
    model: string, messages: OllamaMessage[], agentRole?: string,
    options?: { temperature?: number; num_ctx?: number; num_predict?: number }
  ): Promise<T>;
}

export interface DynamicTeamEvents {
  onRound?: (round: number, label: string) => void;
  onAgent?: (round: number, agentId: string, summary: string) => void;
  /**
   * Fired after each round's section is appended, with the full transcript
   * so far. A crash/OOM kill mid-debate previously lost every completed
   * round's full text (only the in-memory string was ever written, and only
   * once, at the very end) — persisting this incrementally means at worst
   * the last (incomplete) round is lost, not the whole debate.
   */
  onTranscriptUpdate?: (partialTranscript: string) => void;
  /**
   * Fired after EVERY individual agent/judge turn (not just once per round),
   * with the full state needed to resume the debate from the very next turn
   * if the process dies here. Passing the most recent value back in as
   * `run()`'s `resume` argument skips every turn already present in it —
   * a crash loses at most the one turn in flight, never a whole round.
   */
  onCheckpoint?: (checkpoint: DynamicTeamCheckpoint) => void;
}

interface Proposal { agentId: string; agentName: string; proposal: string; }
interface DebateHistory {
  originals: Proposal[];
  critiques: Array<{ agentId: string; agentName: string; critique: string }>;
}

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
    private readonly maxToolRounds = 3,
    private readonly tieBreakerModels: string[] = [],
    private readonly modelOptions: { num_ctx?: number; num_predict?: number } = {},
    /**
     * Retries a failed call against the SAME model only — never a different
     * participant's model — so a transient infra crash (e.g. a crashed
     * llama-server process) doesn't blow away an entire debate that was
     * otherwise succeeding. Defaults to a single attempt.
     */
    private readonly retryPolicy: RetryPolicy = { retries: 0, delayMs: 0 }
  ) {}

  async run(
    plan: AgentTeamPlan,
    events: DynamicTeamEvents = {},
    resume?: DynamicTeamCheckpoint
  ): Promise<{ decision: DynamicTeamDecision; transcript: string }> {
    const goal = plan.goal;
    const distinctModels = new Set(plan.agents.map(agent => this._normalizeModel(agent.model)));
    if (distinctModels.size < 5) {
      throw new Error(`Dynamic debate requires five distinct models; the plan contains ${distinctModels.size}.`);
    }
    const agents = plan.agents.map(spec => new DynamicAgent(
      this.client,
      spec,
      this.toolRunner,
      this.maxToolRounds,
      this.modelOptions,
      this.retryPolicy
    ));

    // A resume checkpoint only applies to THIS goal — a stale/foreign one is
    // treated exactly like starting fresh rather than silently misapplied.
    const valid = resume && resume.goal === goal;
    const startRound: 1 | 2 | 3 | 4 = valid ? resume!.round : 1;

    const transcript: string[] = valid && resume!.transcript
      ? [resume!.transcript]
      : [`# Dynamic Team Debate\n\n**Goal:** ${goal}\n\n**Rationale:** ${plan.rationale}\n`];
    const proposals: Proposal[] = valid ? resume!.proposals.map(p => ({ ...p })) : [];
    let originals: Proposal[] = valid ? resume!.originals.map(p => ({ ...p })) : [];
    const critiques: Array<{ agentId: string; agentName: string; critique: string }> =
      valid ? resume!.critiques.map(c => ({ ...c })) : [];
    const scores: DynamicAgentScore[] = valid ? resume!.scores.map(s => ({ ...s })) : [];
    let tieBreakerModel: string | undefined = valid ? resume!.tieBreakerModel : undefined;

    // Every field here is a live array still being mutated by the round loops
    // below — clone each one so an earlier checkpoint object can never be
    // silently rewritten in place by a later turn's push/assignment.
    const snapshot = (round: 1 | 2 | 3 | 4, completedAgentIds: string[]): DynamicTeamCheckpoint => ({
      goal, round,
      originals: originals.map(p => ({ ...p })),
      proposals: proposals.map(p => ({ ...p })),
      critiques: critiques.map(c => ({ ...c })),
      scores: scores.map(s => ({ ...s })),
      completedAgentIds: [...completedAgentIds],
      tieBreakerModel, transcript: transcript.join('\n\n'), updatedAt: new Date().toISOString(),
    });

    // ---- Round 1: each agent proposes its approach ----
    if (startRound <= 1) {
      events.onRound?.(1, 'Proposals');
      const completed1: string[] = valid && resume!.round === 1 ? [...resume!.completedAgentIds] : [];
      for (let i = completed1.length; i < agents.length; i++) {
        const spec = plan.agents[i];
        const text = await this._required(() => agents[i].respond(
          [
            `Propose YOUR approach to achieving the goal, from your specialty (${spec.specialty}).`,
            'Use explicit sections: Assumptions, Proposed approach, Risks and mitigations, Tools/capabilities required, Completion criteria, and Test plan.',
            'Be concrete, resource-aware, safe, and independently testable.',
            'Stay below 600 tokens.',
          ].join('\n'),
          `Goal: ${goal}`
        ), spec.id, 1);
        proposals.push({ agentId: spec.id, agentName: spec.name, proposal: text });
        completed1.push(spec.id);
        events.onAgent?.(1, spec.id, this._clip(text, 120));
        events.onCheckpoint?.(snapshot(1, completed1));
      }
      originals = proposals.map(p => ({ ...p }));
      transcript.push(this._section('Round 1 — Proposals', proposals.map(p => `### ${p.agentName} (${p.agentId})\n${p.proposal}`)));
      events.onTranscriptUpdate?.(transcript.join('\n\n'));
      events.onCheckpoint?.(snapshot(2, []));
    }

    // ---- Round 2: each agent critiques the others ----
    if (startRound <= 2) {
      events.onRound?.(2, 'Cross-critique');
      const completed2: string[] = valid && resume!.round === 2 ? [...resume!.completedAgentIds] : [];
      for (let i = completed2.length; i < agents.length; i++) {
        const spec = plan.agents[i];
        const others = proposals.filter(p => p.agentId !== spec.id);
        const otherProposalContext = this._boundedBlocks(
          others.map(other => ({ title: other.agentName, content: other.proposal })),
          0.72
        );
        const text = await this._required(() => agents[i].respond(
          'Critique the OTHER proposals below. For each, name concrete strengths, risks, and gaps. Be specific, fair, and stay below 600 tokens.',
          `Goal: ${goal}\n\n${otherProposalContext}`
        ), spec.id, 2);
        critiques.push({ agentId: spec.id, agentName: spec.name, critique: text });
        completed2.push(spec.id);
        events.onAgent?.(2, spec.id, this._clip(text, 120));
        events.onCheckpoint?.(snapshot(2, completed2));
      }
      transcript.push(this._section('Round 2 — Cross-critique', critiques.map(c => `### ${c.agentName}\n${c.critique}`)));
      events.onTranscriptUpdate?.(transcript.join('\n\n'));
      events.onCheckpoint?.(snapshot(3, []));
    }

    // ---- Round 3: each agent refines its proposal ----
    if (startRound <= 3) {
      events.onRound?.(3, 'Refinement');
      const allCritiques = this._boundedBlocks(
        critiques.map(critique => ({ title: critique.agentName, content: critique.critique })),
        0.6
      );
      const completed3: string[] = valid && resume!.round === 3 ? [...resume!.completedAgentIds] : [];
      for (let i = completed3.length; i < agents.length; i++) {
        const spec = plan.agents[i];
        const own = proposals[i];
        const ownProposal = this._clip(own.proposal, Math.floor(this._contextCharBudget() * 0.18));
        const refined = await this._required(() => agents[i].respond(
          'Refine YOUR proposal after reading every critique below. Explicitly list which criticisms you accepted or rejected and why, then provide the revised final approach with assumptions, risks, tools, completion criteria, and tests. Stay below 600 tokens.',
          `Goal: ${goal}\n\n# Your original proposal\n${ownProposal}\n\n# Critiques of the team\n${allCritiques}`
        ), spec.id, 3);
        proposals[i] = { ...own, proposal: refined };
        completed3.push(spec.id);
        events.onAgent?.(3, spec.id, this._clip(refined, 120));
        events.onCheckpoint?.(snapshot(3, completed3));
      }
      transcript.push(this._section('Round 3 — Refined proposals', proposals.map(p => `### ${p.agentName}\n${p.proposal}`)));
      events.onTranscriptUpdate?.(transcript.join('\n\n'));
      events.onCheckpoint?.(snapshot(4, []));
    }

    // ---- Round 4: each agent scores every refined proposal ----
    events.onRound?.(4, 'Scoring & vote');
    const history: DebateHistory = { originals, critiques };
    const completed4: string[] = valid && resume!.round === 4 ? [...resume!.completedAgentIds] : [];
    const mainJudgesDone = completed4.filter(id => id !== 'tie-breaker').length;
    for (let idx = mainJudgesDone; idx < plan.agents.length; idx++) {
      const spec = plan.agents[idx];
      const judgeScores = await this._scoreWithModel(spec.model, proposals, goal, spec.id, spec.name, spec.fallbackModel, history);
      scores.push(...judgeScores);
      completed4.push(spec.id);
      events.onCheckpoint?.(snapshot(4, completed4));
    }
    const successfulJudges = new Set(scores.map(score => score.judgeId));
    const successfulModels = new Set(
      plan.agents
        .filter(agent => successfulJudges.has(agent.id))
        .map(agent => this._normalizeModel(agent.model))
    );
    if (successfulModels.size < 5) {
      throw new Error(`Debate scoring blocked: only ${successfulModels.size} distinct models returned valid scorecards.`);
    }
    let decision = this._aggregate(goal, proposals, scores);
    const margin = decision.ranked.length >= 2
      ? decision.ranked[0].score - decision.ranked[1].score
      : Number.POSITIVE_INFINITY;
    const tieBreakAlreadyRan = scores.some(score => score.judgeId === 'tie-breaker');
    if (tieBreakAlreadyRan && tieBreakerModel) {
      decision = { ...decision, tieBreakerModel };
    } else if (margin <= 0.25 && !tieBreakAlreadyRan) {
      const usedModels = new Set(plan.agents.map(agent => this._normalizeModel(agent.model)));
      const candidateTieBreaker = this.tieBreakerModels.find(model => !usedModels.has(this._normalizeModel(model)));
      if (candidateTieBreaker) {
        const tieScores = await this._scoreWithModel(candidateTieBreaker, proposals, goal, 'tie-breaker', undefined, candidateTieBreaker, history);
        if (tieScores.length === proposals.length) {
          scores.push(...tieScores);
          tieBreakerModel = candidateTieBreaker;
          completed4.push('tie-breaker');
          events.onCheckpoint?.(snapshot(4, completed4));
          decision = { ...this._aggregate(goal, proposals, scores), tieBreakerModel };
          const remainingMargin = decision.ranked.length >= 2 ? decision.ranked[0].score - decision.ranked[1].score : 0;
          if (remainingMargin > 0.25) {
            events.onAgent?.(4, 'tie-breaker', `${candidateTieBreaker} widened the margin from ${margin.toFixed(2)} to ${remainingMargin.toFixed(2)} points.`);
          } else {
            const note = `Independent scorecard from ${candidateTieBreaker} left the top proposals tied/near-tied (${remainingMargin.toFixed(2)} points); the ranking remains provisional.`;
            decision.rationale += ` ${note}`;
            events.onAgent?.(4, 'tie-breaker', note);
          }
        } else {
          const note = `${candidateTieBreaker} returned no valid complete scorecard; the tie remains unresolved.`;
          decision.rationale += ` ${note}`;
          events.onAgent?.(4, 'tie-breaker', note);
        }
      } else {
        decision.rationale += ' The top scores were tied/near-tied, but no responsive model outside the judging panel was available for an independent tie-break.';
      }
    }
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

  private async _scoreWithModel(
    model: string,
    proposals: Proposal[],
    goal: string,
    judgeId: string,
    judgeName = 'Independent tie-breaker',
    fallbackModel = model,
    history?: DebateHistory
  ): Promise<DynamicAgentScore[]> {
    // Allocate separate bounded shares so every participant in every round
    // stays visible, and earlier history cannot crowd out refined proposals.
    const originalsBlock = history ? this._boundedBlocks(
      history.originals.map(proposal => ({ title: proposal.agentName, content: proposal.proposal })), 0.18
    ) : '';
    const critiquesBlock = history ? this._boundedBlocks(
      history.critiques.map(critique => ({ title: critique.agentName, content: critique.critique })), 0.24
    ) : '';
    const proposalsBlock = this._boundedBlocks(
      proposals.map(proposal => ({ title: `id: ${proposal.agentId}`, content: proposal.proposal })),
      history ? 0.4 : 0.72,
      '###'
    );
    const messages: OllamaMessage[] = [
      { role: 'system', content: `You are ${judgeName}, independently judging the team's proposals. Consider the original ideas, cross-critiques and revisions, then score every refined proposal. Score every criterion honestly from 0-10. Respond with ONLY valid JSON.` },
      { role: 'user', content: [
        `# Goal\n${goal}`,
        originalsBlock ? `\n# Round 1 — Original proposals\n${originalsBlock}` : '',
        critiquesBlock ? `\n# Round 2 — Cross-critique\n${critiquesBlock}` : '',
        `\n# Round 3 — Refined proposals\n${proposalsBlock}`,
        '\nWeights: feasibility 25%, completeness 25%, safety 20%, resourceCost 10% (10 means resource-efficient), testability 20%.',
        `Return exactly one score entry for each proposal ID: ${proposals.map(proposal => proposal.agentId).join(', ')}. No duplicates or omissions. All five criteria must be JSON numbers from 0 through 10.`,
        '\nReturn exactly: {"scores":[{"proposalId":"<id>","criteria":{"feasibility":0,"completeness":0,"safety":0,"resourceCost":0,"testability":0},"reason":"max 20 words"}]}',
      ].filter(Boolean).join('\n') },
    ];
    const judgeOptions = {
      ...this.modelOptions,
      num_predict: Math.max(this.modelOptions.num_predict ?? 768, 1_024),
      temperature: 0.1,
    };
    try {
      return await retryWithBackoff(async () => {
        try {
          const raw = this.client.chatJson
            ? await this.client.chatJson<unknown>(model, messages, `dynamic-judge:${judgeId}`, judgeOptions)
            : await this.client.callWithFallbackJson<unknown>(model, fallbackModel, messages, `dynamic-judge:${judgeId}`, judgeOptions);
          return this._validateScorecard(raw, proposals, judgeId);
        } catch (err) {
          if (err instanceof UserAbortError) { throw err; }
          // Keep one bounded correction instead of accumulating failed outputs.
          messages[2] = { role: 'user', content: `Your previous scorecard attempt failed: ${String(err instanceof Error ? err.message : err).slice(0, 800)}. Return the complete corrected JSON scorecard using the schema and proposal IDs above. Do not replace missing scores with guessed defaults.` };
          throw err;
        }
      }, this.retryPolicy, (attempt, totalAttempts, err) => logWarn(
        `Dynamic judge "${judgeId}" (${model}) scorecard failed (attempt ${attempt}/${totalAttempts}): ` +
        `${err instanceof Error ? err.message : String(err)}. Retrying the same model...`
      ));
    } catch (err) {
      if (err instanceof UserAbortError) { throw err; }
      logWarn(`Dynamic judge "${judgeId}" failed to provide a complete scorecard: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** A judge either supplies one complete valid card or contributes no votes. */
  private _validateScorecard(raw: unknown, proposals: Proposal[], judgeId: string): DynamicAgentScore[] {
    if (!raw || typeof raw !== 'object' || !('scores' in raw) || !Array.isArray(raw.scores)) {
      throw new Error('Scorecard must contain a scores array.');
    }
    const expected = new Set(proposals.map(proposal => proposal.agentId));
    const seen = new Set<string>();
    const scores: DynamicAgentScore[] = [];
    const criterionNames = ['feasibility', 'completeness', 'safety', 'resourceCost', 'testability'] as const;
    for (const item of raw.scores) {
      if (!item || typeof item !== 'object') { throw new Error('Each score entry must be an object.'); }
      const proposalId = typeof item.proposalId === 'string' ? item.proposalId : '';
      if (!expected.has(proposalId)) { throw new Error(`Unknown proposal ID: ${proposalId || '(missing)'}.`); }
      if (seen.has(proposalId)) { throw new Error(`Duplicate score for proposal ${proposalId}.`); }
      seen.add(proposalId);
      const criteria = item.criteria as Record<string, unknown> | undefined;
      if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) {
        throw new Error(`Proposal ${proposalId} needs all five numeric criteria.`);
      }
      for (const name of criterionNames) {
        const value = criteria[name];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10) {
          throw new Error(`Proposal ${proposalId}: ${name} must be an explicit finite JSON number from 0 to 10.`);
        }
      }
      const checked = criteria as NonNullable<DynamicAgentScore['criteria']>;
      const weighted = checked.feasibility * 0.25 + checked.completeness * 0.25 + checked.safety * 0.2
        + checked.resourceCost * 0.1 + checked.testability * 0.2;
      scores.push({ judgeId, proposalId, score: Math.round(weighted * 100) / 100, criteria: checked, reason: String(item.reason ?? '').slice(0, 300) });
    }
    const missing = [...expected].filter(id => !seen.has(id));
    if (missing.length > 0) { throw new Error(`Missing scores for proposals: ${missing.join(', ')}.`); }
    return scores;
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
      if (err instanceof UserAbortError) { throw err; }
      logWarn(`Dynamic team step failed: ${err instanceof Error ? err.message : String(err)}`);
      return fallback;
    }
  }

  private async _required(fn: () => Promise<string>, agentId: string, round: number): Promise<string> {
    try {
      const output = (await fn()).trim();
      if (!output) { throw new Error('empty response'); }
      return output;
    } catch (err) {
      if (err instanceof UserAbortError) { throw err; }
      throw new Error(
        `Dynamic debate blocked: model for agent "${agentId}" failed in round ${round}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private _normalizeModel(model: string): string {
    return model.toLowerCase().replace(/:latest$/, '');
  }

  private _name(proposals: Proposal[], agentId: string): string {
    return proposals.find(p => p.agentId === agentId)?.agentName ?? agentId;
  }

  private _section(title: string, parts: string[]): string {
    return `## ${title}\n\n${parts.join('\n\n')}`;
  }

  /**
   * Keep aggregate debate context inside the configured model window. Every
   * participant remains represented, but verbose responses are clipped evenly
   * so later rounds cannot fail merely because earlier agents wrote too much.
   */
  _boundedBlocks(
    blocks: Array<{ title: string; content: string }>,
    budgetFraction = 0.72,
    heading = '##'
  ): string {
    if (blocks.length === 0) { return ''; }
    const budget = Math.floor(this._contextCharBudget() * budgetFraction);
    const headingCost = blocks.reduce((sum, block) => sum + block.title.length + heading.length + 3, 0);
    const contentBudget = Math.max(1_200, budget - headingCost);
    const perBlock = Math.max(400, Math.floor(contentBudget / blocks.length));
    return blocks
      .map(block => `${heading} ${block.title}\n${this._clip(block.content, perBlock)}`)
      .join('\n\n');
  }

  private _contextCharBudget(): number {
    const contextTokens = this.modelOptions.num_ctx ?? 8_192;
    // Conservative estimate for mixed prose/code and room for system/task text.
    return Math.max(8_000, Math.min(24_000, Math.floor(contextTokens * 2.5)));
  }

  private _clip(text: string, max: number): string {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max)}…` : t;
  }
}
