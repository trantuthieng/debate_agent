import type { AgentSpec, OllamaMessage } from '../types';
import { DynamicAgent } from './DynamicAgent';
import type { DynamicTeamClient } from './DynamicTeam';
import { UserAbortError } from '../utils/errors';
import type { RetryPolicy } from '../utils/retry';

export interface QaDebateEvents {
  onRound?: (round: number, label: string) => void;
  onAgent?: (round: number, agentId: string, summary: string) => void;
  onTranscriptUpdate?: (partialTranscript: string) => void;
}

export interface QaDebateResult {
  answer: string;
  transcript: string;
}

interface Position { agentId: string; agentName: string; text: string; }

/**
 * A lighter, purpose-built debate engine for answering a single question
 * (e.g. "should I buy iPhone 18?"), distinct from `DynamicTeam` (which is
 * structurally fixed at 4 stages for software-build proposals and carries
 * per-turn crash-checkpoint machinery a short chat request doesn't need):
 *
 *   Round 1: every agent proposes an initial position.
 *   Rounds 2..N (`rounds`): every agent reads every OTHER agent's latest
 *     position and revises its own — genuine back-and-forth, repeated exactly
 *     `rounds - 1` times. `rounds: 1` is a valid "quick mode" (no revision).
 *   Synthesis: one final call reads everyone's last position and produces
 *     the actual chat answer (not a "winning proposal" — a synthesis that
 *     names agreement, disagreement, and a concrete recommendation).
 */
export class QaDebate {
  constructor(
    private readonly client: DynamicTeamClient,
    private readonly modelOptions: { num_ctx?: number; num_predict?: number } = {},
    private readonly retryPolicy: RetryPolicy = { retries: 1, delayMs: 500 }
  ) {}

  async run(
    question: string,
    agentSpecs: AgentSpec[],
    rounds: number,
    sharedContext: string,
    events: QaDebateEvents = {}
  ): Promise<QaDebateResult> {
    if (agentSpecs.length < 2) {
      throw new Error(`A Q&A debate needs at least 2 agents; got ${agentSpecs.length}.`);
    }
    const boundedRounds = Math.max(1, Math.floor(rounds));
    const agents = agentSpecs.map(spec => new DynamicAgent(
      this.client, spec, undefined, 0, this.modelOptions, this.retryPolicy
    ));
    const transcript: string[] = [`# Q&A Debate\n\n**Question:** ${question}\n`];

    // ---- Round 1: initial positions ----
    events.onRound?.(1, 'Initial positions');
    let positions: Position[] = [];
    for (let i = 0; i < agents.length; i++) {
      const spec = agentSpecs[i];
      const text = await this._required(() => agents[i].respond(
        [
          `Hãy đưa ra quan điểm ban đầu về câu hỏi bên dưới từ góc nhìn của bạn (${spec.specialty}).`,
          'Bắt buộc trả lời bằng tiếng Việt.',
          'Nêu lập trường hoặc khuyến nghị rõ ràng, các lý do chính, và điều gì còn chưa chắc.',
          'Giữ dưới 350 từ.',
        ].join('\n'),
        [sharedContext ? `# Bối cảnh nghiên cứu\n${sharedContext}\n` : '', `Câu hỏi: ${question}`].filter(Boolean).join('\n')
      ), spec.id, 1);
      positions.push({ agentId: spec.id, agentName: spec.name, text });
      events.onAgent?.(1, spec.id, text);
    }
    transcript.push(this._section('Round 1 — Initial positions', positions.map(p => `### ${p.agentName}\n${p.text}`)));
    events.onTranscriptUpdate?.(transcript.join('\n\n'));

    // ---- Rounds 2..N: genuine back-and-forth ----
    for (let round = 2; round <= boundedRounds; round++) {
      events.onRound?.(round, 'Debate');
      const previous = positions;
      const next: Position[] = [];
      for (let i = 0; i < agents.length; i++) {
        const spec = agentSpecs[i];
        const others = previous.filter(p => p.agentId !== spec.id);
        const othersBlock = others.map(p => `### ${p.agentName}\n${this._clip(p.text, 900)}`).join('\n\n');
        const text = await this._required(() => agents[i].respond(
          [
            'Đọc các quan điểm mới nhất của những người tham gia khác bên dưới.',
            'Bắt buộc trả lời bằng tiếng Việt.',
            'Cập nhật lập trường CỦA BẠN: nói rõ bạn giữ điểm nào, đổi điểm nào, và vì sao; hoặc giải thích vì sao bạn vẫn giữ nguyên.',
            'Giữ dưới 300 từ.',
          ].join('\n'),
          `Câu hỏi: ${question}\n\n# Quan điểm mới nhất của các bên khác\n${othersBlock}`
        ), spec.id, round);
        next.push({ agentId: spec.id, agentName: spec.name, text });
        events.onAgent?.(round, spec.id, text);
      }
      positions = next;
      transcript.push(this._section(`Round ${round} — Debate`, positions.map(p => `### ${p.agentName}\n${p.text}`)));
      events.onTranscriptUpdate?.(transcript.join('\n\n'));
    }

    // ---- Synthesis: one final answer ----
    events.onRound?.(boundedRounds + 1, 'Synthesis');
    const answer = await this._synthesize(question, positions, sharedContext, agentSpecs);
    transcript.push(this._section('Synthesis', [answer]));
    events.onTranscriptUpdate?.(transcript.join('\n\n'));

    return { answer, transcript: transcript.join('\n\n') };
  }

  private async _synthesize(question: string, positions: Position[], sharedContext: string, agentSpecs: AgentSpec[]): Promise<string> {
    const positionsBlock = positions.map(p => `### ${p.agentName}\n${this._clip(p.text, 1200)}`).join('\n\n');
    const messages: OllamaMessage[] = [
      {
        role: 'system',
        content: [
          'Bạn là Synthesizer. Một hội đồng cố vấn độc lập vừa tranh luận về câu hỏi bên dưới.',
          'Bắt buộc trả lời bằng tiếng Việt tự nhiên, rõ ràng. Chỉ giữ nguyên tên riêng, thuật ngữ kỹ thuật, tên sản phẩm hoặc trích dẫn nguồn khi cần.',
          'Đọc quan điểm cuối của từng cố vấn và tạo MỘT câu trả lời trực tiếp, rõ ràng cho người hỏi; không liệt kê rời rạc ý kiến của từng người.',
          'Cấu trúc: khuyến nghị/câu trả lời trực tiếp trước, sau đó là lý do chính, điểm đồng thuận/bất đồng nổi bật trong hội đồng, rồi mức độ tự tin.',
          sharedContext ? 'Khi phù hợp, nêu các dữ kiện cụ thể từ bối cảnh nghiên cứu.' : '',
          'Viết ngắn gọn, dễ đọc; đây là câu trả lời chat, không phải báo cáo.',
        ].filter(Boolean).join('\n'),
      },
      {
        role: 'user',
        content: [
          `Câu hỏi: ${question}`,
          sharedContext ? `\n# Bối cảnh nghiên cứu\n${this._clip(sharedContext, 2000)}` : '',
          `\n# Quan điểm cuối của hội đồng (sau khi ${positions.length} cố vấn tranh luận)\n${positionsBlock}`,
        ].filter(Boolean).join('\n'),
      },
    ];
    const primary = agentSpecs[0]?.model;
    const fallback = agentSpecs[1]?.model ?? primary;
    if (!primary) { throw new Error('No model available for synthesis.'); }
    const text = (await this.client.callWithFallback(
      primary, fallback, messages, 'qa-synthesizer',
      { ...this.modelOptions, temperature: 0.3, num_predict: Math.max(this.modelOptions.num_predict ?? 1024, 1024) }
    )).trim();
    if (!text) { throw new Error('Synthesis produced an empty answer.'); }
    return text;
  }

  private async _required(fn: () => Promise<string>, agentId: string, round: number): Promise<string> {
    try {
      const output = (await fn()).trim();
      if (!output) { throw new Error('empty response'); }
      return output;
    } catch (err) {
      if (err instanceof UserAbortError) { throw err; }
      throw new Error(`Q&A debate blocked: agent "${agentId}" failed in round ${round}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private _section(title: string, parts: string[]): string {
    return `## ${title}\n\n${parts.join('\n\n')}`;
  }

  private _clip(text: string, max: number): string {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max)}…` : t;
  }
}
