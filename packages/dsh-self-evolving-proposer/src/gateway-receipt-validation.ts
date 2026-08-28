/** Fail-closed validation of completed-proposal gateway evidence. */
import type { AdapterFetchAttempt, AdapterDiscardedUsage } from './fetch-attempts.js'
import {
  proposalGatewayRouteHash,
  type ProposalGatewayReceipt,
  type ProposalGatewayRoute,
} from './gateway.js'

const HASH = /^sha256:[0-9a-f]{64}$/
const REQUEST_ID = /^llm-[0-9a-f]{64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validDiscardedUsage(value: unknown): value is AdapterDiscardedUsage {
  if (!isRecord(value)) return false
  if (!exactKeys(value, ['cacheReadTokens', 'inputTokens', 'outputTokens', 'reasoningTokens'])) {
    return false
  }
  const input = value['inputTokens']
  const output = value['outputTokens']
  const cache = value['cacheReadTokens']
  const reasoning = value['reasoningTokens']
  return (
    nonNegativeSafeInteger(input) &&
    nonNegativeSafeInteger(output) &&
    nonNegativeSafeInteger(cache) &&
    nonNegativeSafeInteger(reasoning) &&
    cache <= input &&
    reasoning <= output
  )
}

function expectedFlags(status: number | null): { retryable: boolean; ambiguous: boolean } {
  if (status === null) return { retryable: true, ambiguous: true }
  if (status === 429) return { retryable: true, ambiguous: false }
  if (status === 408 || status >= 500) return { retryable: true, ambiguous: true }
  return { retryable: false, ambiguous: false }
}

function validAttempt(value: unknown, index: number): value is AdapterFetchAttempt {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'ambiguous',
      'attemptIndex',
      'discardedUsage',
      'responseId',
      'retryable',
      'status',
    ]) ||
    value['attemptIndex'] !== index ||
    typeof value['retryable'] !== 'boolean' ||
    typeof value['ambiguous'] !== 'boolean' ||
    !(
      value['status'] === null ||
      (Number.isSafeInteger(value['status']) &&
        (value['status'] as number) >= 100 &&
        (value['status'] as number) <= 599)
    ) ||
    !(value['discardedUsage'] === null || validDiscardedUsage(value['discardedUsage'])) ||
    !(
      value['responseId'] === null ||
      (typeof value['responseId'] === 'string' && value['responseId'].length > 0)
    )
  ) {
    return false
  }
  const status = value['status'] as number | null
  const flags = expectedFlags(status)
  if (value['retryable'] !== flags.retryable || value['ambiguous'] !== flags.ambiguous) {
    return false
  }
  if (status !== null && status >= 200 && status < 300) {
    return value['discardedUsage'] === null && value['responseId'] === null
  }
  return true
}

interface ValidatedReceipt {
  receipt: ProposalGatewayReceipt
  finalAttempt: AdapterFetchAttempt
  success: boolean
}

function validateReceipt(
  value: unknown,
  expectedRouteHash: string,
  label: string,
  receiptIndex: number,
): ValidatedReceipt {
  const where = `${label}: gateway receipt ${receiptIndex}`
  if (!isRecord(value)) throw new Error(`${where} is not an object`)
  const required = ['attempts', 'requestHash', 'requestId', 'responseHash', 'routeHash']
  const expected = Object.prototype.hasOwnProperty.call(value, 'error')
    ? [...required, 'error']
    : required
  if (!exactKeys(value, expected)) throw new Error(`${where} schema mismatch`)
  if (typeof value['requestId'] !== 'string' || !REQUEST_ID.test(value['requestId'])) {
    throw new Error(`${where} request identity is invalid`)
  }
  if (
    typeof value['requestHash'] !== 'string' ||
    !HASH.test(value['requestHash']) ||
    typeof value['responseHash'] !== 'string' ||
    !HASH.test(value['responseHash']) ||
    value['routeHash'] !== expectedRouteHash
  ) {
    throw new Error(`${where} hash binding is invalid`)
  }
  if (!Array.isArray(value['attempts']) || value['attempts'].length === 0) {
    throw new Error(`${where} attempt matrix is empty or malformed`)
  }
  const attempts: AdapterFetchAttempt[] = []
  for (const [index, attempt] of value['attempts'].entries()) {
    if (!validAttempt(attempt, index)) throw new Error(`${where} attempt ${index} is invalid`)
    attempts.push(attempt)
  }
  for (const attempt of attempts.slice(0, -1)) {
    const status = attempt.status
    if ((status !== null && status >= 200 && status < 300) || !attempt.retryable) {
      throw new Error(`${where} has an attempt after a terminal row`)
    }
  }
  const finalAttempt = attempts.at(-1)!
  const success =
    finalAttempt.status !== null && finalAttempt.status >= 200 && finalAttempt.status < 300
  const hasError = Object.prototype.hasOwnProperty.call(value, 'error')
  if (
    (success && hasError) ||
    (!success && (!hasError || typeof value['error'] !== 'string' || value['error'].length === 0))
  ) {
    throw new Error(`${where} success/error terminal state is incoherent`)
  }
  return {
    receipt: value as unknown as ProposalGatewayReceipt,
    finalAttempt,
    success,
  }
}

/**
 * Assert the complete gateway matrix for a proposal that reached
 * `proposal.completed`. Every logical request id must finish successfully;
 * retryable failure receipts may precede that success, but a success or a
 * non-retryable failure is terminal and can never be followed by another
 * dispatch for the same id.
 */
export function assertCompletedProposalGatewayReceipts(
  value: unknown,
  route: ProposalGatewayRoute,
  label = 'completed proposal gateway evidence',
): ProposalGatewayReceipt[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label}: gateway receipt matrix is empty or malformed`)
  }
  const routeHash = proposalGatewayRouteHash(route)
  const receipts: ProposalGatewayReceipt[] = []
  const requests = new Map<string, { requestHash: string; mayRetry: boolean; succeeded: boolean }>()
  for (const [index, raw] of value.entries()) {
    const validated = validateReceipt(raw, routeHash, label, index)
    const receipt = validated.receipt
    const prior = requests.get(receipt.requestId)
    if (prior !== undefined) {
      if (prior.requestHash !== receipt.requestHash) {
        throw new Error(`${label}: gateway request id is rebound to different bytes`)
      }
      if (prior.succeeded || !prior.mayRetry) {
        throw new Error(`${label}: gateway request continues after a terminal receipt`)
      }
    }
    requests.set(receipt.requestId, {
      requestHash: receipt.requestHash,
      mayRetry: !validated.success && validated.finalAttempt.retryable,
      succeeded: validated.success,
    })
    receipts.push(receipt)
  }
  for (const state of requests.values()) {
    if (!state.succeeded) {
      throw new Error(`${label}: gateway request has no successful terminal receipt`)
    }
  }
  return receipts
}
