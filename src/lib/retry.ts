import { logger } from './logger';

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('429') || msg.includes('rate_limit_error');
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { attempts?: number; label?: string } = {}
): Promise<T> {
  const { attempts = 3, label = 'operation' } = options;
  // Rate limit errors need a full minute to clear; other errors use short backoff
  const standardDelays = [2000, 4000, 8000];
  // 65s gaps — each wait exceeds the 60s token-per-minute window so the
  // next attempt always starts with a fully cleared rate limit budget.
  const rateLimitDelays = [65000, 65000, 65000, 65000];

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts - 1) throw err;
      const delays = isRateLimitError(err) ? rateLimitDelays : standardDelays;
      const delay = delays[i] ?? delays[delays.length - 1];
      logger.warn(`${label} failed, retrying in ${delay / 1000}s`, {
        attempt: i + 1,
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts`);
}
