/** Trusted-host DeepSeek official Responses API adapter for the fixed proposal gateway. */
import {
  CallId,
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
  reasoningContinuationMaxTurns?: number
  fetchImpl?: typeof fetch
}

interface ResponsesOutputItem {
  id?: unknown
  type?: unknown
  status?: unknown
  content?: Array<{ type?: unknown; text?: unknown }>
  call_id?: unknown
  name?: unknown
  arguments?: unknown
}

interface ResponsesBody {
  id?: unknown
  model?: unknown
  status?: unknown
  incomplete_details?: { reason?: unknown } | null
  output?: ResponsesOutputItem[]
  usage?: {
    input_tokens?: unknown
    output_tokens?: unknown
    input_tokens_details?: { cached_tokens?: unknown }
    output_tokens_details?: { reasoning_tokens?: unknown }
  }
}

interface ResponsesFunctionCall {
  item: ResponsesOutputItem
  callId: string
  name: string
  arguments: string
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

function flattenMessages(options: GenerateOptions): string {
  return options.messages
    .map((message) => {
      const text = textOf(message.content)
      return text ? `${message.role.toUpperCase()}\n${text}` : ''
    })
    .filter(Boolean)
    .join('\n\n')
}

function continuationInput(
  options: GenerateOptions,
  priorItemsByCallId: ReadonlyMap<string, ResponsesOutputItem[]>,
): Array<Record<string, unknown>> | null {
  const input: Array<Record<string, unknown>> = []
  let sawToolHistory = false
  const includedItems = new Set<string>()
  for (const message of options.messages) {
    if (message.role === 'assistant') {
      for (const call of message.content.filter((block) => block.type === 'tool-call')) {
        sawToolHistory = true
        const prior = priorItemsByCallId.get(String(call.id))
        if (prior === undefined) {
          throw new Error('responses adapter: trusted tool-call state is unavailable')
        }
        for (const item of prior) {
          const key = typeof item.id === 'string' ? item.id : JSON.stringify(item)
          if (includedItems.has(key)) continue
          includedItems.add(key)
          input.push(item as Record<string, unknown>)
        }
      }
      continue
    }
    for (const result of message.content.filter((block) => block.type === 'tool-result')) {
      sawToolHistory = true
      input.push({
        type: 'function_call_output',
        call_id: String(result.toolCallId),
        output: textOf(result.content) || '(no output)',
      })
    }
  }
  return sawToolHistory ? input : null
}

function functionCallsOf(output: ResponsesOutputItem[]): ResponsesFunctionCall[] {
  return output
    .filter((item) => item.type === 'function_call')
    .map((item) => {
      if (
        typeof item.call_id !== 'string' ||
        typeof item.name !== 'string' ||
        typeof item.arguments !== 'string'
      ) {
        throw new Error('responses adapter: malformed provider function call')
      }
      return {
        item,
        callId: item.call_id,
        name: item.name,
        arguments: item.arguments,
      }
    })
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
  private readonly priorItemsByCallId = new Map<string, ResponsesOutputItem[]>()

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
    if (
      config.reasoningContinuationMaxTurns !== undefined &&
      (!Number.isSafeInteger(config.reasoningContinuationMaxTurns) ||
        config.reasoningContinuationMaxTurns < 0 ||
        config.reasoningContinuationMaxTurns > 4)
    ) {
      throw new Error('responses adapter: reasoningContinuationMaxTurns must be from 0 through 4')
    }
    this.apiKeyEnv = config.apiKeyEnv ?? 'DEEPSEEK_API_KEY'
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
    const apiKey = process.env[this.apiKeyEnv]?.trim()
    if (!apiKey)
      throw new Error(`responses adapter: credential env ${this.apiKeyEnv} is unavailable`)
    const continued = continuationInput(options, this.priorItemsByCallId)
    let input: string | Array<Record<string, unknown>> = continued ?? flattenMessages(options)
    if ((typeof input === 'string' && !input) || (Array.isArray(input) && input.length === 0)) {
      throw new Error('responses adapter: request has no model input')
    }

    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }
    let sawReasoningUsage = false
    const responseIds: string[] = []
    let body: ResponsesBody | undefined
    let text = ''
    let functionCalls: ResponsesFunctionCall[] = []
    const maxTurns = this.config.reasoningContinuationMaxTurns ?? 1

    for (let turn = 0; turn <= maxTurns; turn++) {
      body = await this.fetchBody(
        {
          model: route.model,
          input,
          ...(options.system === undefined ? {} : { instructions: options.system }),
          reasoning: { effort: route.reasoningEffort },
          max_output_tokens: route.maxTokens,
          store: false,
          ...(options.tools === undefined || options.tools.length === 0
            ? {}
            : {
                tools: options.tools.map((tool) => ({
                  type: 'function',
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                })),
                tool_choice: 'auto',
                parallel_tool_calls: false,
              }),
        },
        options.signal,
      )
      if (body.model !== this.expectedResponseModel) {
        throw new Error('responses adapter: provider model mismatch')
      }
      if (typeof body.id === 'string') responseIds.push(body.id)
      const output = body.output ?? []
      text = output
        .flatMap((item) => item.content ?? [])
        .filter((content) => content.type === 'output_text' && typeof content.text === 'string')
        .map((content) => content.text as string)
        .join('')
      const hasFunctionCallOutput = output.some((item) => item.type === 'function_call')
      const inputTotal = finiteCount(body.usage?.input_tokens) ?? 0
      const cacheRead = finiteCount(body.usage?.input_tokens_details?.cached_tokens) ?? 0
      usage.inputTokens += Math.max(0, inputTotal - cacheRead)
      usage.cacheReadTokens += cacheRead
      usage.outputTokens += finiteCount(body.usage?.output_tokens) ?? 0
      const reasoningTokens = finiteCount(body.usage?.output_tokens_details?.reasoning_tokens)
      if (reasoningTokens !== undefined) {
        usage.reasoningTokens += reasoningTokens
        sawReasoningUsage = true
      }

      const responseStatus = typeof body.status === 'string' ? body.status : null
      const incompleteReason =
        typeof body.incomplete_details?.reason === 'string' ? body.incomplete_details.reason : null
      const reasoningItems = output.filter((item) => item.type === 'reasoning')
      if (responseStatus === 'incomplete') {
        if (text || hasFunctionCallOutput) {
          throw new Error(
            `responses adapter: provider returned incomplete visible output (${JSON.stringify({
              turn: turn + 1,
              incompleteReason,
              outputTypes: output.map((item) => (typeof item.type === 'string' ? item.type : null)),
            })})`,
          )
        }
        if (
          incompleteReason === 'max_output_tokens' &&
          reasoningItems.length > 0 &&
          turn < maxTurns
        ) {
          input = [
            ...(reasoningItems as Array<Record<string, unknown>>),
            {
              role: 'user',
              content:
                'Continue from the completed reasoning and emit the requested answer or tool call.',
            },
          ]
          continue
        }
        throw new Error(
          `responses adapter: provider response has no output text or function call (${JSON.stringify(
            {
              turn: turn + 1,
              status: responseStatus,
              incompleteReason,
              outputTypes: output.map((item) => (typeof item.type === 'string' ? item.type : null)),
              inputTokens: finiteCount(body.usage?.input_tokens) ?? null,
              outputTokens: finiteCount(body.usage?.output_tokens) ?? null,
              reasoningTokens:
                finiteCount(body.usage?.output_tokens_details?.reasoning_tokens) ?? null,
            },
          )})`,
        )
      }
      if (responseStatus !== 'completed') {
        throw new Error(
          `responses adapter: provider returned non-completed status ${JSON.stringify(
            responseStatus,
          )}`,
        )
      }

      functionCalls = functionCallsOf(output)
      if (text || functionCalls.length > 0) break
      throw new Error(
        `responses adapter: provider response has no output text or function call (${JSON.stringify(
          {
            turn: turn + 1,
            status: responseStatus,
            incompleteReason,
            outputTypes: output.map((item) => (typeof item.type === 'string' ? item.type : null)),
            inputTokens: finiteCount(body.usage?.input_tokens) ?? null,
            outputTokens: finiteCount(body.usage?.output_tokens) ?? null,
            reasoningTokens:
              finiteCount(body.usage?.output_tokens_details?.reasoning_tokens) ?? null,
          },
        )})`,
      )
    }

    const reasoningItems = (body?.output ?? []).filter((item) => item.type === 'reasoning')
    for (const call of functionCalls) {
      this.priorItemsByCallId.set(call.callId, [...reasoningItems, call.item])
    }
    while (this.priorItemsByCallId.size > 256) {
      const oldest = this.priorItemsByCallId.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.priorItemsByCallId.delete(oldest)
    }

    let index = 0
    if (text) {
      yield { type: 'block-start', index, blockType: 'text' }
      yield { type: 'text-delta', index, text }
      yield { type: 'block-end', index, block: { type: 'text', text } }
      index += 1
    }
    for (const call of functionCalls) {
      const id = CallId(call.callId)
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index,
        id,
        name: call.name,
        argumentsDelta: call.arguments,
      }
      yield {
        type: 'block-end',
        index,
        block: {
          type: 'tool-call',
          id,
          name: call.name,
          arguments: call.arguments,
        },
      }
      index += 1
    }
    yield {
      type: 'usage',
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(usage.cacheReadTokens > 0 ? { cacheReadTokens: usage.cacheReadTokens } : {}),
        ...(sawReasoningUsage ? { reasoningTokens: usage.reasoningTokens } : {}),
      },
    }
    yield {
      type: 'finish',
      reason: functionCalls.length > 0 ? { kind: 'tool-calls' } : { kind: 'stop' },
      replayState: {
        responseIds,
        requestedModel: route.model,
        effectiveModel: this.expectedResponseModel,
        wireApi: 'responses',
        store: false,
      },
    }
  }

  private async fetchBody(body: unknown, signal?: AbortSignal): Promise<ResponsesBody> {
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
      response = await this.fetchImpl(`${route.endpoint.replace(/\/$/, '')}/responses`, request)
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500
      if (response.ok || !retryable || attempt === maxRetries) break
      await response.body?.cancel()
      await waitForRetry(retryDelayMs(response, attempt), signal)
    }
    if (response === undefined) throw new Error('responses adapter: provider response missing')
    if (!response.ok) {
      throw new Error(`responses adapter: provider returned HTTP ${response.status}`)
    }
    return (await response.json()) as ResponsesBody
  }
}
