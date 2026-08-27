/** DSH LLM adapter that delegates only through the proposal Unix gateway. */
import { createHash } from 'node:crypto'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  ProposalGatewayHandlerFailure,
  requestProposalGateway,
  type ProposalGatewayRequest,
  type ProposalGatewayRoute,
} from './gateway.js'
import type { AdapterFetchAttempt, TrustedAdapterAttemptSource } from './fetch-attempts.js'

export interface ProposalGatewayAdapterConfig {
  socketPath: string
  route: ProposalGatewayRoute
  /**
   * Default per-request wire budget sent as the envelope deadline so the
   * trusted host aborts its provider fetch even if this sandbox client dies
   * silently (issue #190). Effective deadline is min(this, caller signal).
   */
  defaultDeadlineMs?: number
}

function wirePayload(options: GenerateOptions): Record<string, unknown> {
  return {
    provider: options.provider,
    model: options.model,
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    messages: options.messages,
    ...(options.system === undefined ? {} : { system: options.system }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.stop === undefined ? {} : { stop: options.stop }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
  }
}

export class ProposalGatewayAdapter extends LlmAdapter {
  constructor(private readonly config: ProposalGatewayAdapterConfig) {
    super()
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (
      options.provider !== this.config.route.provider ||
      options.model !== this.config.route.model ||
      (options.reasoningEffort !== undefined &&
        options.reasoningEffort !== this.config.route.reasoningEffort) ||
      (options.maxTokens !== undefined && options.maxTokens > this.config.route.maxTokens)
    ) {
      throw new Error('proposal gateway adapter: request does not match locked route')
    }
    const payload = wirePayload(options)
    payload['reasoningEffort'] = this.config.route.reasoningEffort
    payload['maxTokens'] = this.config.route.maxTokens
    const request: ProposalGatewayRequest = {
      schemaVersion: 1,
      requestId: `llm-${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`,
      route: this.config.route,
      payload,
    }
    const deadlineMs = this.config.defaultDeadlineMs
    const response = await requestProposalGateway(
      this.config.socketPath,
      request,
      options.signal === undefined
        ? deadlineMs === undefined
          ? {}
          : { deadlineMs }
        : deadlineMs === undefined
          ? { signal: options.signal }
          : { signal: options.signal, deadlineMs },
    )
    if (!response.ok) throw new Error(`proposal gateway adapter: ${response.error}`)
    const result = response.result as { chunks?: unknown }
    if (!Array.isArray(result?.chunks)) {
      throw new Error('proposal gateway adapter: response has no chunk array')
    }
    for (const chunk of result.chunks) {
      if (chunk === null || typeof chunk !== 'object' || typeof chunk.type !== 'string') {
        throw new Error('proposal gateway adapter: malformed stream chunk')
      }
      yield chunk as StreamChunk
    }
  }
}

/** Build the trusted-host handler that owns the real provider adapter/key. */
/**
 * Serialize handler calls: the trusted adapter's attempt-log slot is
 * evidence-faithful single-flight, so concurrent gateway requests over one
 * adapter instance must not interleave (issue #206).
 */
function serialized<T>(fn: () => Promise<T>, gate: { tail: Promise<unknown> }): Promise<T> {
  const run = gate.tail.then(fn)
  gate.tail = run.catch(() => undefined)
  return run
}

export function createProposalGatewayLlmHandler(
  adapter: LlmAdapter,
  route: ProposalGatewayRoute,
): (
  payload: unknown,
  context?: { signal: AbortSignal },
) => Promise<{ chunks: StreamChunk[]; attempts?: AdapterFetchAttempt[] }> {
  const gate = { tail: Promise.resolve() }
  return (payload, context) => serialized(() => body(payload, context), gate)

  async function body(
    payload: unknown,
    context?: { signal: AbortSignal },
  ): Promise<{ chunks: StreamChunk[]; attempts?: AdapterFetchAttempt[] }> {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('proposal gateway handler: invalid payload')
    }
    const record = payload as Record<string, unknown>
    const allowed = new Set([
      'provider',
      'model',
      'reasoningEffort',
      'messages',
      'system',
      'tools',
      'temperature',
      'maxTokens',
      'stop',
      'sessionId',
      'purpose',
    ])
    if (Object.keys(record).some((key) => !allowed.has(key))) {
      throw new Error('proposal gateway handler: payload contains a forbidden field')
    }
    if (
      record['provider'] !== route.provider ||
      record['model'] !== route.model ||
      record['reasoningEffort'] !== route.reasoningEffort ||
      record['maxTokens'] !== route.maxTokens ||
      !Array.isArray(record['messages'])
    ) {
      throw new Error('proposal gateway handler: payload does not match locked route')
    }
    // The cancellation signal is host-side state, never wire data: it aborts
    // the trusted provider fetch on gateway teardown, request-window close or
    // an envelope deadline (issue #57). Direct in-process calls may omit the
    // context; default to never-abort.
    const options = {
      ...(record as unknown as GenerateOptions),
      ...(context === undefined ? {} : { signal: context.signal }),
    }
    try {
      const chunks: StreamChunk[] = []
      for await (const chunk of adapter.stream(options)) {
        chunks.push(chunk)
      }
      // Surface the trusted adapter's transport-retry attempt log on the
      // handler result so the gateway receipt records every possibly-billed
      // attempt (issue #123). Non-attempt adapters simply omit it.
      const attemptSource = adapter as Partial<TrustedAdapterAttemptSource>
      const attempts = attemptSource.lastFetchAttempts
      return attempts === undefined ? { chunks } : { chunks, attempts: [...attempts] }
    } catch (error) {
      // Surface the attempt log through the failure so the gateway records
      // billed attempts even when the handler dies (issue #193).
      const failureSource = adapter as Partial<TrustedAdapterAttemptSource>
      const failureAttempts = failureSource.lastFetchAttempts
      if (failureAttempts !== undefined && failureAttempts.length > 0) {
        throw new ProposalGatewayHandlerFailure(
          error instanceof Error ? error.message : String(error),
          [...failureAttempts],
        )
      }
      throw error
    }
  }
}
