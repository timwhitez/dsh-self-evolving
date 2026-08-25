import { afterEach, describe, expect, it } from 'vitest'
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { TrustedChatCompletionsAdapter, type ProposalGatewayRoute } from '../src/index.js'

const route: ProposalGatewayRoute = {
  provider: 'deepseek',
  endpoint: 'https://provider.example/v1',
  model: 'deepseek-v4-flash-zen',
  reasoningEffort: 'high',
  maxTokens: 10_000,
}

const originalCredential = process.env['DSH_SELF_EVOLVING_PROVIDER_API_KEY']

afterEach(() => {
  if (originalCredential === undefined) delete process.env['DSH_SELF_EVOLVING_PROVIDER_API_KEY']
  else process.env['DSH_SELF_EVOLVING_PROVIDER_API_KEY'] = originalCredential
})

describe('trusted compatible Chat Completions proposal adapter', () => {
  it('continues a high-reasoning length stop without exposing reasoning', async () => {
    process.env['DSH_SELF_EVOLVING_PROVIDER_API_KEY'] = 'x'
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
        {
          role: 'assistant',
          content: 'Continuation requested by the trusted adapter.',
          reasoning_content: 'private completed reasoning',
        },
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

  it('honors a lower per-request output cap and rejects invalid caps', async () => {
    process.env['DSH_SELF_EVOLVING_PROVIDER_API_KEY'] = 'x'
    const wireCaps: number[] = []
    const adapter = new TrustedChatCompletionsAdapter({
      route,
      expectedResponseModel: 'deepseek-v4-flash',
      contextWindow: 1_048_576,
      async fetchImpl(_input, init) {
        const body = JSON.parse(String(init?.body)) as { max_tokens: number }
        wireCaps.push(body.max_tokens)
        return Response.json({
          id: 'chat-lower-cap',
          model: 'deepseek-v4-flash',
          choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        })
      },
    })

    for await (const _chunk of adapter.stream({
      provider: route.provider,
      model: route.model,
      maxTokens: 100,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: 'bounded' }],
          source: { kind: 'user' },
        }),
      ],
    })) {
      // consume
    }
    expect(wireCaps).toEqual([100])

    for (const maxTokens of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      route.maxTokens + 1,
    ]) {
      const consume = async () => {
        for await (const _chunk of adapter.stream({
          provider: route.provider,
          model: route.model,
          maxTokens,
          messages: [
            createUserMessage({
              content: [{ type: 'text', text: 'invalid' }],
              source: { kind: 'user' },
            }),
          ],
        })) {
          // consume
        }
      }
      await expect(consume()).rejects.toThrow(/locked route/)
    }
  })

  it('translates tool calls and replays hidden reasoning only on the trusted host', async () => {
    process.env['DSH_SELF_EVOLVING_PROVIDER_API_KEY'] = 'x'
    const wireBodies: Array<Record<string, unknown>> = []
    let fetchCalls = 0
    const adapter = new TrustedChatCompletionsAdapter({
      route,
      expectedResponseModel: 'deepseek-v4-flash',
      contextWindow: 1_048_576,
      async fetchImpl(_input, init) {
        fetchCalls += 1
        wireBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return fetchCalls === 1
          ? Response.json({
              id: 'tool-turn',
              model: 'deepseek-v4-flash',
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    content: '',
                    reasoning_content: 'trusted private reasoning',
                    tool_calls: [
                      {
                        id: 'call-1',
                        type: 'function',
                        function: { name: 'read_file', arguments: '{"path":"x"}' },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            })
          : Response.json({
              id: 'final-turn',
              model: 'deepseek-v4-flash',
              choices: [{ finish_reason: 'stop', message: { content: 'done' } }],
              usage: { prompt_tokens: 15, completion_tokens: 1 },
            })
      },
    })
    const tools = [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }]
    const firstChunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
      maxTokens: route.maxTokens,
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: 'inspect' }],
          source: { kind: 'user' },
        }),
      ],
      tools,
    })) {
      firstChunks.push(chunk)
    }
    expect(firstChunks).toContainEqual({
      type: 'block-end',
      index: 0,
      block: {
        type: 'tool-call',
        id: CallId('call-1'),
        name: 'read_file',
        arguments: '{"path":"x"}',
      },
    })
    expect(firstChunks.at(-1)).toMatchObject({ reason: { kind: 'tool-calls' } })
    expect(JSON.stringify(firstChunks)).not.toContain('trusted private reasoning')

    const assistant = createAssistantMessage({
      content: [
        {
          type: 'tool-call',
          id: CallId('call-1'),
          name: 'read_file',
          arguments: '{"path":"x"}',
        },
      ],
      source: { provider: route.provider, model: route.model },
    })
    const result = createToolResultMessage({
      callId: CallId('call-1'),
      content: [{ type: 'text', text: 'contents' }],
      isError: false,
    })
    for await (const _chunk of adapter.stream({
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
      maxTokens: route.maxTokens,
      messages: [assistant, result],
      tools,
    })) {
      // Drain the trusted continuation.
    }
    expect(wireBodies[0]?.['tools']).toEqual([
      {
        type: 'function',
        function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } },
      },
    ])
    expect(wireBodies[1]?.['messages']).toEqual([
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'trusted private reasoning',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"x"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'contents' },
    ])
  })

  it('rejects route overrides and missing credentials', async () => {
    delete process.env['DSH_SELF_EVOLVING_PROVIDER_API_KEY']
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
      for await (const chunk of adapter.stream(base)) void chunk
    }).rejects.toThrow(/credential env DSH_SELF_EVOLVING_PROVIDER_API_KEY is unavailable/)
  })
})
