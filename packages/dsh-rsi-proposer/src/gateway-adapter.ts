/** DSH LLM adapter that delegates only through the proposal Unix gateway. */
import { createHash } from 'node:crypto'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  requestProposalGateway,
  type ProposalGatewayRequest,
  type ProposalGatewayRoute,
} from './gateway.js'

export interface ProposalGatewayAdapterConfig {
  socketPath: string
  route: ProposalGatewayRoute
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
      options.reasoningEffort !== this.config.route.reasoningEffort ||
      options.maxTokens !== this.config.route.maxTokens
    ) {
      throw new Error('proposal gateway adapter: request does not match locked route')
    }
    const payload = wirePayload(options)
    const request: ProposalGatewayRequest = {
      schemaVersion: 1,
      requestId: `llm-${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`,
      route: this.config.route,
      payload,
    }
    const response = await requestProposalGateway(this.config.socketPath, request)
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
export function createProposalGatewayLlmHandler(
  adapter: LlmAdapter,
  route: ProposalGatewayRoute,
): (payload: unknown) => Promise<{ chunks: StreamChunk[] }> {
  return async (payload) => {
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
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(record as unknown as GenerateOptions)) {
      chunks.push(chunk)
    }
    return { chunks }
  }
}
