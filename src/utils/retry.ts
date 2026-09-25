import { UserAbortError } from './errors';

export interface RetryPolicy {
  /** Additional attempts after the first; 0 disables retrying (single attempt only). */
  retries: number;
  /** Base delay in ms between attempts; grows via exponential backoff with jitter. */
  delayMs: number;
  /** Live cancellation check, including time spent waiting between attempts. */
  shouldAbort?: () => boolean;
}

/**
 * Retry `fn` against the exact same target it already calls — no fallback or
 * model substitution — for transient infra failures (a crashed model server
 * process, a dropped connection), not for genuinely bad output. Use this where
 * silently switching to a different target on failure would be wrong (e.g. a
 * dynamic-team debate agent, whose identity as a specific distinct model is
 * part of what the debate promises).
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  onRetry?: (attempt: number, totalAttempts: number, err: unknown) => void
): Promise<T> {
  const totalAttempts = Math.max(0, policy.retries) + 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    if (policy.shouldAbort?.()) { throw new UserAbortError(); }
    try {
      return await fn();
    } catch (err) {
      if (err instanceof UserAbortError || policy.shouldAbort?.()) { throw new UserAbortError(); }
      lastError = err;
      if (attempt === totalAttempts) { break; }
      onRetry?.(attempt, totalAttempts, err);
      const jitter = Math.floor(Math.random() * policy.delayMs * 0.5);
      const backoff = policy.delayMs * Math.pow(2, attempt - 1) + jitter;
      if (backoff > 0) {
        const deadline = Date.now() + backoff;
        while (Date.now() < deadline) {
          if (policy.shouldAbort?.()) { throw new UserAbortError(); }
          await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())));
        }
      }
    }
  }
  throw lastError;
}
