import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
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

function options(): GenerateOptions {
  return {
    provider: route.provider,
    model: route.model,
    reasoningEffort: route.reasoningEffort,
    maxTokens: route.maxTokens,
    messages: [
      createUserMessage({
        content: [{ type: 'text', text: 'produce a proposal' }],
        source: { kind: 'user' },
      }),
    ],
    tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }],
  }
}

async function drain(adapter: TrustedResponsesAdapter): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options())) chunks.push(chunk)
  return chunks
}

function adapterFor(body: Record<string, unknown>): TrustedResponsesAdapter {
  return new TrustedResponsesAdapter({
    route,
    contextWindow: 1_048_576,
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    async fetchImpl() {
      return Response.json(body)
    },
  })
}

describe('Responses completion status', () => {
  it('rejects incomplete output text instead of emitting a partial stop response', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'x'
    const adapter = adapterFor({
      id: 'response-partial-text',
      model: route.model,
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: '{"proposalId":"partial' }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 20 },
    })

    await expect(drain(adapter)).rejects.toThrow(/incomplete visible output/)
  })

  it('rejects incomplete function calls before they can be dispatched', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'x'
    const adapter = adapterFor({
      id: 'response-partial-call',
      model: route.model,
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [
        {
          type: 'function_call',
          call_id: 'call-partial',
          name: 'read_file',
          arguments: '{"path":"unterminated',
        },
      ],
      usage: { input_tokens: 10, output_tokens: 20 },
    })

    await expect(drain(adapter)).rejects.toThrow(/incomplete visible output/)
  })

  it('continues a reasoning-only max-token response and accepts the later completed output', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'x'
    const wireBodies: Array<Record<string, unknown>> = []
    let calls = 0
    const adapter = new TrustedResponsesAdapter({
      route,
      contextWindow: 1_048_576,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      reasoningContinuationMaxTurns: 1,
      async fetchImpl(_input, init) {
        wireBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        calls += 1
        if (calls === 1) {
          return Response.json({
            id: 'response-reasoning',
            model: route.model,
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output: [{ id: 'reasoning-1', type: 'reasoning', status: 'completed' }],
            usage: {
              input_tokens: 10,
              output_tokens: 8,
              output_tokens_details: { reasoning_tokens: 8 },
            },
          })
        }
        return Response.json({
          id: 'response-complete',
          model: route.model,
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'complete proposal' }],
            },
          ],
          usage: { input_tokens: 4, output_tokens: 2 },
        })
      },
    })

    const chunks = await drain(adapter)

    expect(calls).toBe(2)
    expect(wireBodies[1]?.['input']).toEqual([
      expect.objectContaining({ id: 'reasoning-1', type: 'reasoning' }),
      expect.objectContaining({ role: 'user' }),
    ])
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'complete proposal' })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('accepts visible output only when the provider reports completed', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'x'
    const chunks = await drain(
      adapterFor({
        id: 'response-complete',
        model: route.model,
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'done' }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    )

    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'done' })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })
})
