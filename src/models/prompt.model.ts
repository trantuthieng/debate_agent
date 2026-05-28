import { Timestamp } from './types';

/**
 * Represents a user input prompt for the AI agent.
 * Contains the content of the prompt and a timestamp for tracking.
 */
export interface PromptModel {
  /** The content of the user's prompt */
  content: string;
  /** The timestamp when the prompt was created */
  timestamp: Timestamp;
}
