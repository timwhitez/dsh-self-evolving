/** Trusted-host OpenAI-compatible Chat Completions adapter for the Zen route. */
import {
  LlmAdapter,
  attributionHeaders,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { ProposalGatewayRoute } from './gateway.js'

export interface TrustedChatCompletionsAdapterConfig {
  route: ProposalGatewayRoute
  expectedResponseModel?: string
  apiKeyEnv?: string
  contextWindow: number
  requestMaxRetries?: number
  reasoningContinuationMaxTurns?: number
  fetchImpl?: typeof fetch
}

interface ChatMessage {
  role: string
  content: string
  reasoning_content?: string
}

interface ChatCompletionsBody {
  id?: unknown
  model?: unknown
  choices?: Array<{
    finish_reason?: unknown
    message?: { content?: unknown; reasoning_content?: unknown }
  }>
  usage?: {
    prompt_tokens?: unknown
    completion_tokens?: unknown
    prompt_tokens_details?: { cached_tokens?: unknown }
    completion_tokens_details?: { reasoning_tokens?: unknown }
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

function messagesOf(options: GenerateOptions): ChatMessage[] {
  const messages: ChatMessage[] = []
  if (options.system) messages.push({ role: 'system', content: options.system })
  for (const message of options.messages) {
    const content = textOf(message.content)
    if (content) messages.push({ role: message.role, content })
  }
  return messages
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

export class TrustedChatCompletionsAdapter extends LlmAdapter {
  private readonly apiKeyEnv: string
  private readonly expectedResponseModel: string
  private readonly fetchImpl: typeof fetch

  constructor(private readonly config: TrustedChatCompletionsAdapterConfig) {
    super()
    if (!Number.isSafeInteger(config.contextWindow) || config.contextWindow <= 0) {
      throw new Error('chat adapter: context window must be a positive integer')
    }
    if (
      config.requestMaxRetries !== undefined &&
      (!Number.isSafeInteger(config.requestMaxRetries) ||
        config.requestMaxRetries < 0 ||
        config.requestMaxRetries > 12)
    ) {
      throw new Error('chat adapter: requestMaxRetries must be an integer from 0 through 12')
    }
    if (
      config.reasoningContinuationMaxTurns !== undefined &&
      (!Number.isSafeInteger(config.reasoningContinuationMaxTurns) ||
        config.reasoningContinuationMaxTurns < 0 ||
        config.reasoningContinuationMaxTurns > 4)
    ) {
      throw new Error('chat adapter: reasoningContinuationMaxTurns must be from 0 through 4')
    }
    this.apiKeyEnv = config.apiKeyEnv ?? 'RSI_PROVIDER_API_KEY'
    this.expectedResponseModel = config.expectedResponseModel ?? config.route.model
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (provider !== this.config.route.provider || model !== this.config.route.model) {
      return Promise.reject(new Error('chat adapter: model lookup does not match locked route'))
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
      throw new Error('chat adapter: request does not match locked route')
    }
    if (options.tools !== undefined && options.tools.length > 0) {
      throw new Error('chat adapter: proposal route does not permit model tool calls')
    }
    const apiKey = process.env[this.apiKeyEnv]?.trim()
    if (!apiKey) throw new Error(`chat adapter: credential env ${this.apiKeyEnv} is unavailable`)
    const messages = messagesOf(options)
    if (messages.length === 0) throw new Error('chat adapter: request has no model input')

    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }
    let sawReasoningUsage = false
    const responseIds: string[] = []
    let body: ChatCompletionsBody | undefined
    let text = ''
    const maxTurns = this.config.reasoningContinuationMaxTurns ?? 0

    for (let turn = 0; turn <= maxTurns; turn++) {
      body = await this.fetchBody(
        {
          model: route.model,
          messages,
          reasoning_effort: route.reasoningEffort,
          max_tokens: route.maxTokens,
          stream: false,
        },
        options.signal,
      )
      if (body.model !== this.expectedResponseModel) {
        throw new Error('chat adapter: provider model mismatch')
      }
      if (typeof body.id === 'string') responseIds.push(body.id)
      const choice = body.choices?.[0]
      const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null
      text = typeof choice?.message?.content === 'string' ? choice.message.content : ''
      const reasoning =
        typeof choice?.message?.reasoning_content === 'string'
          ? choice.message.reasoning_content
          : ''
      usage.inputTokens += finiteCount(body.usage?.prompt_tokens) ?? 0
      usage.outputTokens += finiteCount(body.usage?.completion_tokens) ?? 0
      usage.cacheReadTokens += finiteCount(body.usage?.prompt_tokens_details?.cached_tokens) ?? 0
      const reasoningTokens = finiteCount(body.usage?.completion_tokens_details?.reasoning_tokens)
      if (reasoningTokens !== undefined) {
        usage.reasoningTokens += reasoningTokens
        sawReasoningUsage = true
      }
      if (text && finishReason !== 'length') break
      if (text && finishReason === 'length') {
        throw new Error('chat adapter: provider truncated visible output')
      }
      if (finishReason !== 'length' || !reasoning) {
        throw new Error(
          `chat adapter: provider response has no output text (${JSON.stringify({
            turn: turn + 1,
            finishReason,
            inputTokens: finiteCount(body.usage?.prompt_tokens) ?? null,
            outputTokens: finiteCount(body.usage?.completion_tokens) ?? null,
            reasoningPresent: Boolean(reasoning),
          })})`,
        )
      }
      if (turn === maxTurns) {
        throw new Error('chat adapter: reasoning continuation budget exhausted')
      }
      messages.push({ role: 'assistant', content: '', reasoning_content: reasoning })
      messages.push({
        role: 'user',
        content:
          'Continue from the completed reasoning. Emit only the required final JSON object now.',
      })
    }
    if (!body || !text) throw new Error('chat adapter: provider body missing final text')

    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield {
      type: 'usage',
      usage: {
        inputTokens: Math.max(0, usage.inputTokens - usage.cacheReadTokens),
        outputTokens: usage.outputTokens,
        ...(usage.cacheReadTokens > 0 ? { cacheReadTokens: usage.cacheReadTokens } : {}),
        ...(sawReasoningUsage ? { reasoningTokens: usage.reasoningTokens } : {}),
      },
    }
    yield {
      type: 'finish',
      reason: { kind: 'stop' },
      replayState: {
        responseIds,
        requestedModel: route.model,
        effectiveModel: this.expectedResponseModel,
        wireApi: 'chat-completions',
      },
    }
  }

  private async fetchBody(body: unknown, signal?: AbortSignal): Promise<ChatCompletionsBody> {
    const route = this.config.route
    const request: RequestInit = {
      method: 'POST',
      headers: {
        ...attributionHeaders(),
        authorization: `Bearer ${process.env[this.apiKeyEnv]?.trim() ?? ''}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    }
    const maxRetries = this.config.requestMaxRetries ?? 0
    let response: Response | undefined
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      response = await this.fetchImpl(
        `${route.endpoint.replace(/\/$/, '')}/chat/completions`,
        request,
      )
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500
      if (response.ok || !retryable || attempt === maxRetries) break
      await response.body?.cancel()
      await waitForRetry(retryDelayMs(response, attempt), signal)
    }
    if (!response) throw new Error('chat adapter: provider response missing')
    if (!response.ok) throw new Error(`chat adapter: provider returned HTTP ${response.status}`)
    return (await response.json()) as ChatCompletionsBody
  }
}
