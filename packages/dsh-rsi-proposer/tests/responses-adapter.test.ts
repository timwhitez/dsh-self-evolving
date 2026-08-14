import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { TrustedResponsesAdapter, type ProposalGatewayRoute } from '../src/index.js'

const route: ProposalGatewayRoute = {
  provider: 'deepseek',
  endpoint: 'https://provider.example/v1',
  model: 'deepseek-v4-flash-free',
  reasoningEffort: 'high',
  maxTokens: 2048,
}

const originalCredential = process.env['RSI_PROVIDER_API_KEY']

afterEach(() => {
  if (originalCredential === undefined) delete process.env['RSI_PROVIDER_API_KEY']
  else process.env['RSI_PROVIDER_API_KEY'] = originalCredential
})

describe('trusted Responses proposal adapter', () => {
  it('locks the 200k model route and converts a Responses result to DSH chunks', async () => {
    process.env['RSI_PROVIDER_API_KEY'] = 'x'
    let wireBody: Record<string, unknown> | undefined
    let fetchCalls = 0
    const adapter = new TrustedResponsesAdapter({
      route,
      contextWindow: 200_000,
      requestMaxRetries: 1,
      async fetchImpl(input, init) {
        fetchCalls += 1
        expect(String(input)).toBe('https://provider.example/v1/responses')
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer x')
        wireBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        if (fetchCalls === 1) {
          return new Response('', { status: 429, headers: { 'retry-after': '0' } })
        }
        return new Response(
          JSON.stringify({
            id: 'response-1',
            model: route.model,
            status: 'completed',
            output: [
              { type: 'message', content: [{ type: 'output_text', text: '{"proposalId":"p1"}' }] },
            ],
            usage: {
              input_tokens: 110,
              output_tokens: 20,
              input_tokens_details: { cached_tokens: 10 },
              output_tokens_details: { reasoning_tokens: 5 },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      },
    })
    await expect(adapter.resolveModel(route.provider, route.model)).resolves.toMatchObject({
      context: { contextWindow: 200_000 },
      defaultMaxTokens: 2048,
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
    expect(wireBody).toMatchObject({
      model: 'deepseek-v4-flash-free',
      reasoning: { effort: 'high' },
      max_output_tokens: 2048,
    })
    expect(fetchCalls).toBe(2)
    expect(String(wireBody?.['input'])).toContain('system policy')
    expect(String(wireBody?.['input'])).toContain('proposal input')
    expect(chunks).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, reasoningTokens: 5 },
    })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(JSON.stringify(chunks)).not.toContain('authorization')
  })

  it('rejects route overrides, model tools, and missing trusted-host credentials', async () => {
    delete process.env['RSI_PROVIDER_API_KEY']
    const adapter = new TrustedResponsesAdapter({ route, contextWindow: 200_000 })
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
      for await (const _chunk of adapter.stream({ ...base, model: 'override' })) void _chunk
    }).rejects.toThrow(/locked route/)
    await expect(async () => {
      for await (const _chunk of adapter.stream({
        ...base,
        tools: [{ name: 'forbidden', description: 'forbidden', parameters: {} }],
      }))
        void _chunk
    }).rejects.toThrow(/does not permit model tool calls/)
    await expect(async () => {
      for await (const _chunk of adapter.stream(base)) void _chunk
    }).rejects.toThrow(/credential env RSI_PROVIDER_API_KEY is unavailable/)
  })
})
