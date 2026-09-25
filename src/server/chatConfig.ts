import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from '../utils/atomicFile';
import { MIN_QA_AGENTS, MAX_QA_AGENTS } from '../prompts/qaPersonas';

export interface ChatConfig {
  /** Rounds 2..N of critique/revision; total agent calls = rounds + a synthesis call. */
  rounds: number;
  /** Number of distinct-model debate participants. */
  agentCount: number;
  webSearchEnabled: boolean;
}

export const DEFAULT_CHAT_CONFIG: ChatConfig = { rounds: 2, agentCount: 5, webSearchEnabled: true };
export const MAX_ROUNDS = 6;

export function clampChatConfig(partial: Partial<ChatConfig>): ChatConfig {
  const rounds = Number(partial.rounds);
  const agentCount = Number(partial.agentCount);
  return {
    rounds: Number.isFinite(rounds) ? Math.max(1, Math.min(MAX_ROUNDS, Math.floor(rounds))) : DEFAULT_CHAT_CONFIG.rounds,
    agentCount: Number.isFinite(agentCount)
      ? Math.max(MIN_QA_AGENTS, Math.min(MAX_QA_AGENTS, Math.floor(agentCount)))
      : DEFAULT_CHAT_CONFIG.agentCount,
    webSearchEnabled: partial.webSearchEnabled === undefined ? DEFAULT_CHAT_CONFIG.webSearchEnabled : Boolean(partial.webSearchEnabled),
  };
}

/** Persists chat settings via the same atomic-write helper used for the extension's checkpoints. */
export class ChatConfigStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'chat_config.json');
  }

  read(): ChatConfig {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      return clampChatConfig(JSON.parse(raw) as Partial<ChatConfig>);
    } catch {
      return { ...DEFAULT_CHAT_CONFIG };
    }
  }

  write(partial: Partial<ChatConfig>): ChatConfig {
    const merged = clampChatConfig({ ...this.read(), ...partial });
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileAtomic(this.filePath, JSON.stringify(merged, null, 2));
    return merged;
  }
}
