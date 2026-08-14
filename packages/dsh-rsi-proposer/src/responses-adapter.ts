/** Trusted-host Responses API adapter for the fixed proposal gateway. */
import {
  LlmAdapter,
  attributionHeaders,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { ProposalGatewayRoute } from './gateway.js'

export interface TrustedResponsesAdapterConfig {
  route: ProposalGatewayRoute
  expectedResponseModel?: string
  apiKeyEnv?: string
  contextWindow: number
  requestMaxRetries?: number
  fetchImpl?: typeof fetch
}

interface ResponsesBody {
  id?: unknown
  model?: unknown
  status?: unknown
  incomplete_details?: { reason?: unknown } | null
  output?: Array<{
    type?: unknown
    content?: Array<{ type?: unknown; text?: unknown }>
  }>
  usage?: {
    input_tokens?: unknown
    output_tokens?: unknown
    input_tokens_details?: { cached_tokens?: unknown }
    output_tokens_details?: { reasoning_tokens?: unknown }
  }
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((block) => {
      if (block === null || typeof block !== 'object') return ''
      const record = block as Record<string, unknown>
      if (record['type'] === 'text' && typeof record['text'] === 'string') return record['text']
      if (record['type'] === 'tool-result') return JSON.stringify(record)
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function flattenInput(options: GenerateOptions): string {
  const parts: string[] = []
  if (options.system) parts.push(`SYSTEM\n${options.system}`)
  for (const message of options.messages) {
    const text = textOf(message.content)
    if (text) parts.push(`${message.role.toUpperCase()}\n${text}`)
  }
  return parts.join('\n\n')
}

function finiteCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter !== null) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1000)
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) return Math.min(30_000, Math.max(0, date - Date.now()))
  }
  return Math.min(10_000, 500 * 2 ** attempt)
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class TrustedResponsesAdapter extends LlmAdapter {
  private readonly apiKeyEnv: string
  private readonly expectedResponseModel: string
  private readonly fetchImpl: typeof fetch

  constructor(private readonly config: TrustedResponsesAdapterConfig) {
    super()
    if (!Number.isSafeInteger(config.contextWindow) || config.contextWindow <= 0) {
      throw new Error('responses adapter: context window must be a positive integer')
    }
    if (
      config.requestMaxRetries !== undefined &&
      (!Number.isSafeInteger(config.requestMaxRetries) ||
        config.requestMaxRetries < 0 ||
        config.requestMaxRetries > 12)
    ) {
      throw new Error('responses adapter: requestMaxRetries must be an integer from 0 through 12')
    }
    this.apiKeyEnv = config.apiKeyEnv ?? 'RSI_PROVIDER_API_KEY'
    this.expectedResponseModel = config.expectedResponseModel ?? config.route.model
    if (!this.expectedResponseModel) {
      throw new Error('responses adapter: expected response model must be non-empty')
    }
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (provider !== this.config.route.provider || model !== this.config.route.model) {
      return Promise.reject(
        new Error('responses adapter: model lookup does not match locked route'),
      )
    }
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.config.contextWindow },
      defaultMaxTokens: this.config.route.maxTokens,
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const route = this.config.route
    if (
      options.provider !== route.provider ||
      options.model !== route.model ||
      (options.reasoningEffort !== undefined &&
        options.reasoningEffort !== route.reasoningEffort) ||
      (options.maxTokens !== undefined && options.maxTokens > route.maxTokens)
    ) {
      throw new Error('responses adapter: request does not match locked route')
    }
    if (options.tools !== undefined && options.tools.length > 0) {
      throw new Error('responses adapter: proposal route does not permit model tool calls')
    }
    const apiKey = process.env[this.apiKeyEnv]?.trim()
    if (!apiKey)
      throw new Error(`responses adapter: credential env ${this.apiKeyEnv} is unavailable`)
    const input = flattenInput(options)
    if (!input) throw new Error('responses adapter: request has no model input')
    const request: RequestInit = {
      method: 'POST',
      headers: {
        ...attributionHeaders(),
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: route.model,
        input,
        reasoning: { effort: route.reasoningEffort },
        max_output_tokens: route.maxTokens,
      }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }
    const fetchResponse = async (): Promise<Response> => {
      const maxRetries = this.config.requestMaxRetries ?? 0
      let response: Response | undefined
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        response = await this.fetchImpl(`${route.endpoint.replace(/\/$/, '')}/responses`, request)
        const retryable =
          response.status === 408 || response.status === 429 || response.status >= 500
        if (response.ok || !retryable || attempt === maxRetries) break
        await response.body?.cancel()
        await waitForRetry(retryDelayMs(response, attempt), options.signal)
      }
      if (response === undefined) throw new Error('responses adapter: provider response missing')
      if (!response.ok) {
        throw new Error(`responses adapter: provider returned HTTP ${response.status}`)
      }
      return response
    }
    const body = (await (await fetchResponse()).json()) as ResponsesBody
    if (body.model !== this.expectedResponseModel) {
      throw new Error('responses adapter: provider model mismatch')
    }
    const text = (body.output ?? [])
      .flatMap((item) => item.content ?? [])
      .filter((content) => content.type === 'output_text' && typeof content.text === 'string')
      .map((content) => content.text as string)
      .join('')
    if (!text) {
      throw new Error(
        `responses adapter: provider response has no output text (${JSON.stringify({
          status: typeof body.status === 'string' ? body.status : null,
          incompleteReason:
            typeof body.incomplete_details?.reason === 'string'
              ? body.incomplete_details.reason
              : null,
          outputTypes: (body.output ?? []).map((item) =>
            typeof item.type === 'string' ? item.type : null,
          ),
          inputTokens: finiteCount(body.usage?.input_tokens) ?? null,
          outputTokens: finiteCount(body.usage?.output_tokens) ?? null,
          reasoningTokens: finiteCount(body.usage?.output_tokens_details?.reasoning_tokens) ?? null,
        })})`,
      )
    }

    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    const inputTotal = finiteCount(body.usage?.input_tokens)
    const outputTokens = finiteCount(body.usage?.output_tokens)
    if (inputTotal !== undefined && outputTokens !== undefined) {
      const cacheReadTokens = finiteCount(body.usage?.input_tokens_details?.cached_tokens) ?? 0
      const reasoningTokens = finiteCount(body.usage?.output_tokens_details?.reasoning_tokens)
      yield {
        type: 'usage',
        usage: {
          inputTokens: Math.max(0, inputTotal - cacheReadTokens),
          outputTokens,
          ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
          ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
        },
      }
    }
    yield {
      type: 'finish',
      reason:
        body.status === 'incomplete' && body.incomplete_details?.reason === 'max_output_tokens'
          ? { kind: 'max-tokens' }
          : { kind: 'stop' },
      replayState: {
        responseId: typeof body.id === 'string' ? body.id : null,
        requestedModel: route.model,
        effectiveModel: this.expectedResponseModel,
      },
    }
  }
}
