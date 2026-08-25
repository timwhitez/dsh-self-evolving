import { afterEach, describe, expect, it } from 'vitest'
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { TrustedResponsesAdapter, type ProposalGatewayRoute } from '../src/index.js'

const route: ProposalGatewayRoute = {
  provider: 'deepseek',
  endpoint: 'https://provider.example/v1',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  maxTokens: 2048,
}

const originalCredential = process.env['DEEPSEEK_API_KEY']

afterEach(() => {
  if (originalCredential === undefined) delete process.env['DEEPSEEK_API_KEY']
  else process.env['DEEPSEEK_API_KEY'] = originalCredential
})

describe('trusted Responses proposal adapter', () => {
  it('locks the official Flash 1m route, retries transport failure, and emits DSH chunks', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'x'
    let wireBody: Record<string, unknown> | undefined
    let fetchCalls = 0
    const adapter = new TrustedResponsesAdapter({
      route,
      expectedResponseModel: 'deepseek-v4-flash',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      contextWindow: 1_048_576,
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
            model: 'deepseek-v4-flash',
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
      context: { contextWindow: 1_048_576 },
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
      model: 'deepseek-v4-flash',
      reasoning: { effort: 'high' },
      max_output_tokens: 2048,
      store: false,
    })
    expect(fetchCalls).toBe(2)
    expect(wireBody?.['instructions']).toBe('system policy')
    expect(String(wireBody?.['input'])).toContain('proposal input')
    expect(chunks).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, reasoningTokens: 5 },
    })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(JSON.stringify(chunks)).not.toContain('authorization')
  })

  it('honors a lower per-request output cap and rejects invalid caps', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'x'
    const wireCaps: number[] = []
    const adapter = new TrustedResponsesAdapter({
      route,
      contextWindow: 1_048_576,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      async fetchImpl(_input, init) {
        const body = JSON.parse(String(init?.body)) as { max_output_tokens: number }
        wireCaps.push(body.max_output_tokens)
        return Response.json({
          id: 'response-lower-cap',
          model: route.model,
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      },
    })

    for await (const _chunk of adapter.stream({
      provider: route.provider,
      model: route.model,
      maxTokens: 100,
      messages: [
        createUserMessage({ content: [{ type: 'text', text: 'bounded' }], source: { kind: 'user' } }),
      ],
    })) {
      // consume
    }
    expect(wireCaps).toEqual([100])

    for (const maxTokens of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, route.maxTokens + 1]) {
      const consume = async () => {
        for await (const _chunk of adapter.stream({
          provider: route.provider,
          model: route.model,
          maxTokens,
          messages: [
            createUserMessage({ content: [{ type: 'text', text: 'invalid' }], source: { kind: 'user' } }),
          ],
        })) {
          // consume
        }
      }
      await expect(consume()).rejects.toThrow(/locked route/)
    }
  })

  it('translates stateless tool calls without exposing reasoning', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'x'
    const wireBodies: Array<Record<string, unknown>> = []
    let fetchCalls = 0
    const adapter = new TrustedResponsesAdapter({
      route,
      contextWindow: 1_048_576,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      async fetchImpl(_input, init) {
        fetchCalls += 1
        wireBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return fetchCalls === 1
          ? Response.json({
              id: 'response-tool',
              model: route.model,
              status: 'completed',
              output: [
                {
                  id: 'reasoning-1',
                  type: 'reasoning',
                  status: 'completed',
                  content: [{ type: 'reasoning_text', text: 'private reasoning' }],
                },
                {
                  id: 'function-1',
                  type: 'function_call',
                  status: 'completed',
                  call_id: 'call-1',
                  name: 'read_file',
                  arguments: '{"path":"x"}',
                },
              ],
              usage: { input_tokens: 10, output_tokens: 5 },
            })
          : Response.json({
              id: 'response-final',
              model: route.model,
              status: 'completed',
              output: [
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: 'done' }],
                },
              ],
              usage: { input_tokens: 15, output_tokens: 1 },
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
    expect(JSON.stringify(firstChunks)).not.toContain('private reasoning')

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
    expect(wireBodies[0]).toMatchObject({
      model: route.model,
      store: false,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      tools: [
        {
          type: 'function',
          name: 'read_file',
          description: 'Read',
          parameters: { type: 'object' },
        },
      ],
    })
    expect(wireBodies[1]?.['input']).toEqual([
      expect.objectContaining({ id: 'reasoning-1', type: 'reasoning' }),
      expect.objectContaining({ id: 'function-1', type: 'function_call', call_id: 'call-1' }),
      { type: 'function_call_output', call_id: 'call-1', output: 'contents' },
    ])
  })

  it('rejects route overrides and missing trusted-host credentials', async () => {
    delete process.env['DEEPSEEK_API_KEY']
    const adapter = new TrustedResponsesAdapter({
      route,
      expectedResponseModel: 'deepseek-v4-flash',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
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
      for await (const _chunk of adapter.stream({ ...base, model: 'override' })) void _chunk
    }).rejects.toThrow(/locked route/)
    await expect(async () => {
      for await (const _chunk of adapter.stream(base)) void _chunk
    }).rejects.toThrow(/credential env DEEPSEEK_API_KEY is unavailable/)
  })
})
