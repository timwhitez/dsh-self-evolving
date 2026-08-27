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

  describe('discarded-cache accounting (review blocker)', () => {
    it('does not double-count discarded cached tokens into inputTokens', async () => {
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
            ? new Response(
                JSON.stringify({
                  id: 'resp-cache-500',
                  usage: {
                    input_tokens: 1000,
                    output_tokens: 200,
                    input_tokens_details: { cached_tokens: 900 },
                  },
                }),
                { status: 500, headers: { 'content-type': 'application/json' } },
              )
            : new Response(
                JSON.stringify(
                  okResponsesBody('ok', {
                    input_tokens: 1000,
                    output_tokens: 50,
                    input_tokens_details: { cached_tokens: 900 },
                    output_tokens_details: { reasoning_tokens: 0 },
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
        messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      })) {
        chunks.push(chunk as unknown as Record<string, unknown>)
      }
      const usage = chunks.find((chunk) => chunk['type'] === 'usage')?.['usage'] as Record<
        string,
        number
      >
      // Both attempts bill 100 net input (1000 gross - 900 cached) each.
      expect(usage['inputTokens']).toBe(200)
      expect(usage['cacheReadTokens']).toBe(1800)
      expect(usage['outputTokens']).toBe(250)
    })

    it('salvages usage from the final failed attempt when retries are exhausted', async () => {
      process.env['DEEPSEEK_API_KEY'] = 'x'
      const adapter = new TrustedResponsesAdapter({
        route,
        contextWindow: 1_048_576,
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        requestMaxRetries: 1,
        async fetchImpl() {
          return new Response(
            JSON.stringify({
              id: 'resp-final-fail',
              usage: { input_tokens: 77, output_tokens: 3 },
            }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          )
        },
      })
      await expect(async () => {
        for await (const _chunk of adapter.stream({
          provider: route.provider,
          model: route.model,
          reasoningEffort: route.reasoningEffort,
          maxTokens: route.maxTokens,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
        })) {
          void _chunk
        }
      }).rejects.toThrow(/HTTP 500/)
      const attempts = adapter.lastFetchAttempts
      expect(attempts).toHaveLength(2)
      expect(attempts[1]!.discardedUsage).toMatchObject({ inputTokens: 77, outputTokens: 3 })
      expect(attempts[1]!.responseId).toBe('resp-final-fail')
    })
  })

  describe('failure receipts carry attempt logs (issue #193)', () => {
    it('records a failure receipt with every billed attempt when all retries fail', async () => {
      const root = await mkdtemp(join(tmpdir(), 'gw-fail-'))
      process.env['DEEPSEEK_API_KEY'] = 'x'
      const adapter = new TrustedResponsesAdapter({
        route,
        contextWindow: 1_048_576,
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        requestMaxRetries: 1,
        async fetchImpl() {
          return new Response(JSON.stringify({ id: 'resp-fail', usage: { input_tokens: 25 } }), {
            status: 503,
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
          requestId: 'fail-1',
          route,
          payload: {
            provider: route.provider,
            model: route.model,
            reasoningEffort: route.reasoningEffort,
            maxTokens: route.maxTokens,
            messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
          },
        })
        expect(response.ok).toBe(false)
        const receipt = gateway.receipts().find((row) => row.requestId === 'fail-1')
        expect(receipt).toBeDefined()
        expect(receipt!.error).toMatch(/503|HTTP/)
        expect(receipt!.attempts).toHaveLength(2)
        expect(receipt!.attempts!.every((row) => row.ambiguous)).toBe(true)
        expect(receipt!.attempts![0]!.discardedUsage).toMatchObject({ inputTokens: 25 })
      } finally {
        await gateway.close()
        await rm(root, { recursive: true, force: true })
      }
    })
  })

  describe('per-invocation attempt isolation (issue #206)', () => {
    it('concurrent streams keep isolated collectors and the final log reflects one invocation', async () => {
      process.env['DEEPSEEK_API_KEY'] = 'x'
      let calls = 0
      const adapter = new TrustedResponsesAdapter({
        route,
        contextWindow: 1_048_576,
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        requestMaxRetries: 1,
        async fetchImpl() {
          calls += 1
          const mine = calls
          // First two wire calls (each stream's first attempt) fail with a
          // delay so both streams are in flight concurrently; later calls 200.
          if (mine <= 2) {
            await new Promise((done) => setTimeout(done, 30))
            return new Response(
              JSON.stringify({ id: `r-fail-${mine}`, usage: { input_tokens: mine } }),
              { status: 500, headers: { 'content-type': 'application/json' } },
            )
          }
          return new Response(JSON.stringify(okResponsesBody('ok', { input_tokens: mine })), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        },
      })
      const run = async (): Promise<{ inputTokens: number }> => {
        let usage: { inputTokens: number } | undefined
        for await (const chunk of adapter.stream({
          provider: route.provider,
          model: route.model,
          reasoningEffort: route.reasoningEffort,
          maxTokens: route.maxTokens,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
        })) {
          if ((chunk as { type?: string }).type === 'usage') {
            usage = (chunk as { usage: { inputTokens: number } }).usage
          }
        }
        return usage!
      }
      const [usageA, usageB] = await Promise.all([run(), run()])
      // Each invocation's usage counted ONLY its own discarded attempt + its
      // own success: with mine<=2 failing (inputs 1 and 2) and successes
      // carrying inputs 3 and 4, no cross-accumulation means each usage is
      // (its fail input + its success input), totalling 1+2+3+4 = 10 across
      // both.
      expect(usageA.inputTokens + usageB.inputTokens).toBe(10)
      // The shared read slot reflects exactly ONE invocation's two attempts —
      // not a 4-row interleave.
      expect(adapter.lastFetchAttempts).toHaveLength(2)
      expect(calls).toBe(4)
    })
  })
})
