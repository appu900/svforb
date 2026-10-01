/** A finished row must never take another fan-out or send-batch. */
export const TERMINAL_NOTIFICATION_STATUSES = new Set([
  'sent',
  'failed',
  'partially_sent',
]);

/** First send is generation 0. Two extra waves = 3 FCM attempts per token. */
export const MAX_TOKEN_RETRY_GENERATIONS = 2;

/** Hard stop so one token cannot increment failureCount forever. */
export const MAX_RECORDED_FAILURES_BEFORE_STOP = 5;

export function notificationIsTerminal(status: string | null | undefined): boolean {
  return !!status && TERMINAL_NOTIFICATION_STATUSES.has(status);
}

/**
 * Transient FCM / network errors get a few delayed retries.
 * They must not open an unbounded new-job loop (prod notification 79: 1 token, 56 jobs).
 */
export function shouldRequeueRetryableTokens(input: {
  retryGeneration?: number;
  failureCount?: number;
} = {}): boolean {
  const generation = input.retryGeneration ?? 0;
  const failureCount = input.failureCount ?? 0;
  if (generation >= MAX_TOKEN_RETRY_GENERATIONS) return false;
  if (failureCount >= MAX_RECORDED_FAILURES_BEFORE_STOP) return false;
  return true;
}

export function retryDelayMs(retryGeneration: number): number {
  return 15_000 * (retryGeneration + 1);
}
