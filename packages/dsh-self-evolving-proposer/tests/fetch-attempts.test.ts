/**
 * Transport-retry attempt accounting (issue #123).
 *
 * A discarded 408/5xx response may already have been billed by the provider:
 * its salvageable usage must flow into the SAME usage chunk as the surviving
 * response, every attempt must be recorded with an ambiguity classification,
 * and the gateway receipt must carry the full attempt log into evidence.
 */
import { describe, expect, it } from 'vitest'
import { TrustedResponsesAdapter } from '../src/responses-adapter.js'
import { TrustedChatCompletionsAdapter } from '../src/chat-completions-adapter.js'
import {
  startProposalGateway,
  createProposalGatewayLlmHandler,
  type ProposalGatewayRoute,
} from '../src/index.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const route: ProposalGatewayRoute = {
  provider: 'deepseek',
  endpoint: 'https://provider.example/v1',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  maxTokens: 2048,
}

const okResponsesBody = (text: string, usage: Record<string, number>) => ({
  id: 'response-ok',
  model: route.model,
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
  usage,
})

const okChatBody = (text: string, usage: Record<string, number>) => ({
  id: 'chat-ok',
  model: route.model,
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage,
})

describe('responses adapter retry accounting', () => {
  it('sums discarded-attempt usage into the final usage chunk and records attempts', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'x'
    let calls = 0
    const adapter = new TrustedResponsesAdapter({
      route,
      contextWindow: 1_048_576,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      requestMaxRetries: 1,
      async fetchImpl() {
        calls += 1
        if (calls === 1) {
          return new Response(
            JSON.stringify({
              id: 'response-billed-but-500',
              usage: { input_tokens: 50, output_tokens: 10 },
            }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(
          JSON.stringify(
            okResponsesBody('{"proposalId":"p1"}', {
              input_tokens: 110,
              output_tokens: 20,
              input_tokens_details: { cached_tokens: 10 },
              output_tokens_details: { reasoning_tokens: 5 },
            }),
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      },
    })
    const chunks: Array<Record<string, unknown>> = []
    for await (const chunk of adapter.stream({
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
      maxTokens: route.maxTokens,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'proposal input' }] }],
    })) {
      chunks.push(chunk as unknown as Record<string, unknown>)
    }
    const usage = chunks.find((chunk) => chunk['type'] === 'usage')?.['usage'] as Record<
      string,
      number
    >
    // Discarded 500 attempt usage (50 in / 10 out) plus the final response.
    expect(usage['inputTokens']).toBe(50 + 100)
    expect(usage['outputTokens']).toBe(10 + 20)
    expect(usage['cacheReadTokens']).toBe(10)

    const attempts = adapter.lastFetchAttempts
    expect(attempts).toHaveLength(2)
    expect(attempts[0]!.status).toBe(500)
    expect(attempts[0]!.ambiguous).toBe(true)
    expect(attempts[0]!.retryable).toBe(true)
    expect(attempts[0]!.discardedUsage).toMatchObject({ inputTokens: 50, outputTokens: 10 })
    expect(attempts[0]!.responseId).toBe('response-billed-but-500')
    expect(attempts[1]!.status).toBe(200)
    expect(attempts[1]!.ambiguous).toBe(false)
  })

  it('classifies 429 as retryable but not ambiguous', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'x'
    let calls = 0
    const adapter = new TrustedResponsesAdapter({
      route,
      contextWindow: 1_048_576,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      requestMaxRetries: 1,
      async fetchImpl() {
        calls += 1
        return calls === 1
          ? new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } })
          : new Response(JSON.stringify(okResponsesBody('ok', { input_tokens: 5 })), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
      },
    })
    for await (const _chunk of adapter.stream({
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
      maxTokens: route.maxTokens,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    })) {
      void _chunk
    }
    expect(adapter.lastFetchAttempts[0]!.status).toBe(429)
    expect(adapter.lastFetchAttempts[0]!.ambiguous).toBe(false)
    expect(adapter.lastFetchAttempts[0]!.retryable).toBe(true)
  })
})

describe('chat adapter retry accounting', () => {
  it('sums discarded-attempt usage and records ambiguous attempts', async () => {
    process.env['DEEPSEEK_API_KEY'] = 'x'
    let calls = 0
    const adapter = new TrustedChatCompletionsAdapter({
      route,
      contextWindow: 1_048_576,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      requestMaxRetries: 1,
      async fetchImpl() {
        calls += 1
        return calls === 1
          ? new Response(
              JSON.stringify({
                id: 'chat-billed-but-504',
                usage: { prompt_tokens: 40, completion_tokens: 8 },
              }),
              { status: 504, headers: { 'content-type': 'application/json' } },
            )
          : new Response(
              JSON.stringify(okChatBody('done', { prompt_tokens: 60, completion_tokens: 4 })),
              { status: 200, headers: { 'content-type': 'application/json' } },
            )
      },
    })
    const chunks: Array<Record<string, unknown>> = []
    for await (const chunk of adapter.stream({
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
      maxTokens: route.maxTokens,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    })) {
      chunks.push(chunk as unknown as Record<string, unknown>)
    }
    const usage = chunks.find((chunk) => chunk['type'] === 'usage')?.['usage'] as Record<
      string,
      number
    >
    expect(usage['inputTokens']).toBe(40 + 60)
    expect(usage['outputTokens']).toBe(8 + 4)
    expect(adapter.lastFetchAttempts[0]!.status).toBe(504)
    expect(adapter.lastFetchAttempts[0]!.ambiguous).toBe(true)
    expect(adapter.lastFetchAttempts[0]!.discardedUsage).toMatchObject({
      inputTokens: 40,
      outputTokens: 8,
    })
  })
})

describe('gateway receipts carry attempt logs', () => {
  it('includes adapter attempts in the signed request receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gw-attempts-'))
    process.env['DEEPSEEK_API_KEY'] = 'x'
    let calls = 0
    const adapter = new TrustedResponsesAdapter({
      route,
      contextWindow: 1_048_576,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      requestMaxRetries: 1,
      async fetchImpl() {
        calls += 1
        return calls === 1
          ? new Response(JSON.stringify({ id: 'resp-billed', usage: { input_tokens: 30 } }), {
              status: 500,
              headers: { 'content-type': 'application/json' },
            })
          : new Response(JSON.stringify(okResponsesBody('ok', { input_tokens: 5 })), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
      },
    })
    const gateway = await startProposalGateway({
      socketPath: join(root, 'gw.sock'),
      route,
      handle: createProposalGatewayLlmHandler(adapter, route) as never,
    })
    try {
      const response = await gateway.request({
        schemaVersion: 1,
        requestId: 'attempts-1',
        route,
        payload: {
          provider: route.provider,
          model: route.model,
          reasoningEffort: route.reasoningEffort,
          maxTokens: route.maxTokens,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
        },
      })
      expect(response.ok).toBe(true)
      const receipt = gateway.receipts().find((row) => row.requestId === 'attempts-1')
      expect(receipt).toBeDefined()
      expect(receipt!.attempts).toHaveLength(2)
      expect(receipt!.attempts![0]!.ambiguous).toBe(true)
      expect(receipt!.attempts![0]!.discardedUsage).toMatchObject({ inputTokens: 30 })
      await rm(root, { recursive: true, force: true })
    } finally {
      await gateway.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
