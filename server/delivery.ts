import { TelegramError, TelegramNetworkError, pause } from "./telegram.ts";

export const RETRY_DELAYS_MS = [2000, 6000, 15000];

/** Whether the error proves the request was not processed by Telegram. */
export function definitelyNotSent(error: unknown): boolean {
  return (
    (error instanceof TelegramNetworkError && error.delivery === "unreachable") ||
    (error instanceof TelegramError && (error.code === 429 || error.code >= 500))
  );
}

/** Retries a final-reply step with backoff. A step that may already have been
 * processed (timeout or reset on a new message) is only retried when it is
 * idempotent, such as editing the progress message; otherwise a retry could
 * post the same text twice. */
export async function withRetry<T>(
  operation: () => Promise<T>,
  idempotent: () => boolean,
  signal: AbortSignal,
  wait: typeof pause = pause,
  delays: number[] = RETRY_DELAYS_MS,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const transient =
        error instanceof TelegramNetworkError ||
        (error instanceof TelegramError &&
          (error.code === 429 || error.code >= 500));
      if (
        signal.aborted ||
        !transient ||
        attempt >= delays.length ||
        !(definitelyNotSent(error) || idempotent())
      )
        throw error;
      await wait(delays[attempt], signal);
    }
  }
}
