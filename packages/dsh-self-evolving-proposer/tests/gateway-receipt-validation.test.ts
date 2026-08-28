import { describe, expect, it } from 'vitest'
import {
  assertCompletedProposalGatewayReceipts,
  proposalGatewayRouteHash,
  type ProposalGatewayRoute,
} from '../src/index.js'

const route: ProposalGatewayRoute = {
  provider: 'deepseek',
  endpoint: 'https://api.deepseek.com/v1',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  maxTokens: 32_768,
}

function attempt(status: number | null, attemptIndex = 0) {
  const flags =
    status === null
      ? { retryable: true, ambiguous: true }
      : status === 429
        ? { retryable: true, ambiguous: false }
        : status === 408 || status >= 500
          ? { retryable: true, ambiguous: true }
          : { retryable: false, ambiguous: false }
  return {
    attemptIndex,
    status,
    ...flags,
    discardedUsage: status !== null && status >= 200 && status < 300 ? null : null,
    responseId: null,
  }
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    requestId: `llm-${'1'.repeat(64)}`,
    requestHash: `sha256:${'2'.repeat(64)}`,
    responseHash: `sha256:${'3'.repeat(64)}`,
    routeHash: proposalGatewayRouteHash(route),
    attempts: [attempt(200)],
    ...overrides,
  }
}

describe('completed proposal gateway receipt validation', () => {
  it('accepts retryable transport failures that terminate in one success', () => {
    expect(
      assertCompletedProposalGatewayReceipts(
        [receipt({ attempts: [attempt(503), attempt(200, 1)] })],
        route,
      ),
    ).toHaveLength(1)
  })

  it('accepts a retryable failed dispatch followed by a successful replay of the same request', () => {
    expect(
      assertCompletedProposalGatewayReceipts(
        [receipt({ attempts: [attempt(503)], error: 'provider failed' }), receipt()],
        route,
      ),
    ).toHaveLength(2)
  })

  it.each([
    ['a failure-only matrix', [receipt({ attempts: [attempt(503)], error: 'provider failed' })]],
    ['a success carrying an error', [receipt({ error: 'impossible' })]],
    [
      'a non-retryable attempt before success',
      [receipt({ attempts: [attempt(400), attempt(200, 1)] })],
    ],
    [
      'an attempt after success',
      [receipt({ attempts: [attempt(200), attempt(503, 1)], error: 'impossible' })],
    ],
    [
      'a non-retryable failed dispatch followed by success',
      [receipt({ attempts: [attempt(400)], error: 'bad request' }), receipt()],
    ],
    ['a malformed receipt row', [null]],
  ] as const)('rejects %s', (_label, receipts) => {
    expect(() => assertCompletedProposalGatewayReceipts(receipts, route)).toThrow(/gateway/i)
  })
})
