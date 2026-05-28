// Custom error types for the Local Multi-Agent Coder extension

export class OllamaConnectionError extends Error {
  constructor(public readonly url: string) {
    super(
      `Cannot connect to Ollama at ${url}. Please start Ollama and try again.\n` +
      `  Install: https://ollama.com\n` +
      `  Then run: ollama serve`
    );
    this.name = 'OllamaConnectionError';
  }
}

export class ModelNotFoundError extends Error {
  constructor(public readonly model: string) {
    super(
      `Model "${model}" is not installed in Ollama.\n` +
      `  Run: ollama pull ${model}`
    );
    this.name = 'ModelNotFoundError';
  }
}

export class WorkflowError extends Error {
  constructor(message: string, public readonly phase?: string) {
    super(message);
    this.name = 'WorkflowError';
  }
}

export class UserAbortError extends Error {
  constructor() {
    super('Workflow stopped by user.');
    this.name = 'UserAbortError';
  }
}

export class SafeModeBlockedError extends Error {
  constructor(public readonly action: string, public readonly reason: string) {
    super(`Safe mode blocked: ${action}. Reason: ${reason}`);
    this.name = 'SafeModeBlockedError';
  }
}

export class JsonParseError extends Error {
  constructor(raw: string, cause?: unknown) {
    super(`Failed to parse JSON from model response. Raw: ${raw.substring(0, 200)}`);
    this.name = 'JsonParseError';
    if (cause instanceof Error) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

export class DangerousCommandError extends Error {
  constructor(public readonly command: string) {
    super(`Dangerous command detected: "${command}". Requires explicit user approval before execution.`);
    this.name = 'DangerousCommandError';
  }
}

export class WorkspaceNotFoundError extends Error {
  constructor() {
    super('No workspace folder is open. Please open a folder before starting the agent workflow.');
    this.name = 'WorkspaceNotFoundError';
  }
}

export class FileWriteError extends Error {
  constructor(public readonly filePath: string, cause?: unknown) {
    super(`Failed to write file: ${filePath}`);
    this.name = 'FileWriteError';
    if (cause instanceof Error) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

export class MaxRetriesExceededError extends Error {
  constructor(public readonly taskId: string, public readonly maxRetries: number) {
    super(`Max fix retries (${maxRetries}) exceeded for task "${taskId}".`);
    this.name = 'MaxRetriesExceededError';
  }
}

export function isUserAbort(err: unknown): boolean {
  return err instanceof UserAbortError;
}

export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
