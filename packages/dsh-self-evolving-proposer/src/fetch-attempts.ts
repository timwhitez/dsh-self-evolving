/**
 * Transport-retry attempt accounting (issue #123).
 *
 * A logical model request may be retried at the HTTP layer on 408/429/5xx.
 * For 429 the provider provably did not execute the request; for 408/5xx the
 * generation may already have run and been billed before the error reached
 * the client ("ambiguous"). Every attempt — and any usage visible on a
 * discarded attempt body — must therefore survive into evidence/budget
 * instead of vanishing with the discarded response.
 */
export interface AdapterDiscardedUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  reasoningTokens: number
}

export interface AdapterFetchAttempt {
  /**
   * Monotonic sequence within one stream() call — continues across
   * reasoning-continuation turns so every transport attempt stays distinct.
   */
  attemptIndex: number
  /** HTTP status, or null when the attempt failed before a status was read. */
  status: number | null
  retryable: boolean
  /** True when the provider may already have executed/billed the attempt. */
  ambiguous: boolean
  /**
   * Usage found on the discarded attempt body, when parseable. NOTE:
   * `inputTokens` here is the provider-raw GROSS value (cached portion
   * included); adapters net it against `cacheReadTokens` when summing into
   * the final usage chunk.
   */
  discardedUsage: AdapterDiscardedUsage | null
  responseId: string | null
}

/** Contract the trusted adapters expose for per-call attempt inspection. */
export interface TrustedAdapterAttemptSource {
  /** Attempts recorded by the most recent stream() call (fresh per call). */
  readonly lastFetchAttempts: readonly AdapterFetchAttempt[]
}

/**
 * Per-invocation attempt log: each stream() call gets an isolated collector,
 * so concurrent in-flight requests on one adapter instance cannot reset or
 * cross-contaminate each other's records (issue #206).
 */
export class AttemptCollector {
  readonly attempts: AdapterFetchAttempt[] = []
}

export function classifyStatus(status: number): { retryable: boolean; ambiguous: boolean } {
  if (status === 429) return { retryable: true, ambiguous: false }
  if (status === 408 || status >= 500) return { retryable: true, ambiguous: true }
  return { retryable: false, ambiguous: false }
}
