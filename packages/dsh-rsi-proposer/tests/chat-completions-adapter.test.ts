import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { TrustedChatCompletionsAdapter, type ProposalGatewayRoute } from '../src/index.js'

const route: ProposalGatewayRoute = {
  provider: 'deepseek',
  endpoint: 'https://provider.example/v1',
  model: 'deepseek-v4-flash-zen',
  reasoningEffort: 'high',
  maxTokens: 10_000,
}

const originalCredential = process.env['RSI_PROVIDER_API_KEY']

afterEach(() => {
  if (originalCredential === undefined) delete process.env['RSI_PROVIDER_API_KEY']
  else process.env['RSI_PROVIDER_API_KEY'] = originalCredential
})

describe('trusted compatible Chat Completions proposal adapter', () => {
  it('continues a high-reasoning length stop without exposing reasoning', async () => {
    process.env['RSI_PROVIDER_API_KEY'] = 'x'
    const wireBodies: Array<Record<string, unknown>> = []
    let fetchCalls = 0
    const adapter = new TrustedChatCompletionsAdapter({
      route,
      expectedResponseModel: 'deepseek-v4-flash',
      contextWindow: 1_048_576,
      requestMaxRetries: 1,
      reasoningContinuationMaxTurns: 1,
      async fetchImpl(input, init) {
        fetchCalls += 1
        expect(String(input)).toBe('https://provider.example/v1/chat/completions')
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer x')
        wireBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        if (fetchCalls === 1) {
          return new Response('', { status: 429, headers: { 'retry-after': '0' } })
        }
        if (fetchCalls === 2) {
          return Response.json({
            id: 'chat-reasoning-only',
            model: 'deepseek-v4-flash',
            choices: [
              {
                finish_reason: 'length',
                message: { content: '', reasoning_content: 'private completed reasoning' },
              },
            ],
            usage: { prompt_tokens: 110, completion_tokens: 2048 },
          })
        }
        return Response.json({
          id: 'chat-final',
          model: 'deepseek-v4-flash',
          choices: [{ finish_reason: 'stop', message: { content: '{"proposalId":"p1"}' } }],
          usage: {
            prompt_tokens: 210,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 10 },
            completion_tokens_details: { reasoning_tokens: 5 },
          },
        })
      },
    })
    await expect(adapter.resolveModel(route.provider, route.model)).resolves.toMatchObject({
      context: { contextWindow: 1_048_576 },
      defaultMaxTokens: 10_000,
    })
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
      maxTokens: route.maxTokens,
      system: 'system policy',
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: 'proposal input' }],
          source: { kind: 'user' },
        }),
      ],
    })) {
      chunks.push(chunk)
    }
    expect(fetchCalls).toBe(3)
    expect(wireBodies[0]).toMatchObject({
      model: 'deepseek-v4-flash-zen',
      reasoning_effort: 'high',
      max_tokens: 10_000,
      stream: false,
    })
    expect(wireBodies[2]?.['messages']).toEqual(
      expect.arrayContaining([
        { role: 'assistant', content: '', reasoning_content: 'private completed reasoning' },
      ]),
    )
    expect(chunks).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 310, outputTokens: 2068, cacheReadTokens: 10, reasoningTokens: 5 },
    })
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'stop' },
      replayState: { wireApi: 'chat-completions' },
    })
    expect(JSON.stringify(chunks)).not.toContain('private completed reasoning')
    expect(JSON.stringify(chunks)).not.toContain('authorization')
  })

  it('rejects route overrides, model tools, and missing credentials', async () => {
    delete process.env['RSI_PROVIDER_API_KEY']
    const adapter = new TrustedChatCompletionsAdapter({
      route,
      expectedResponseModel: 'deepseek-v4-flash',
      contextWindow: 1_048_576,
    })
    const base = {
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
      maxTokens: route.maxTokens,
      messages: [
        createUserMessage({ content: [{ type: 'text', text: 'input' }], source: { kind: 'user' } }),
      ],
    }
    await expect(async () => {
      for await (const chunk of adapter.stream({ ...base, model: 'override' })) void chunk
    }).rejects.toThrow(/locked route/)
    await expect(async () => {
      for await (const chunk of adapter.stream({
        ...base,
        tools: [{ name: 'forbidden', description: 'forbidden', parameters: {} }],
      }))
        void chunk
    }).rejects.toThrow(/does not permit model tool calls/)
    await expect(async () => {
      for await (const chunk of adapter.stream(base)) void chunk
    }).rejects.toThrow(/credential env RSI_PROVIDER_API_KEY is unavailable/)
  })
})
