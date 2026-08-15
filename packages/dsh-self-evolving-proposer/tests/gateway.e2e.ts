/** Gate 4: a no-network proposal sandbox reaches only the trusted Unix gateway. */
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProposalSandbox, type ProposalSandboxMounts } from '@dsh-self-evolving/core'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  ProposalGatewayAdapter,
  createProposalGatewayLlmHandler,
  startProposalGateway,
  type ProposalGatewayRoute,
} from '../src/index.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-proposal-gateway-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const route: ProposalGatewayRoute = {
  provider: 'deepseek-official',
  endpoint: 'https://provider.invalid/v1',
  model: 'deepseek-v4-flash-zen',
  reasoningEffort: 'high',
  maxTokens: 2048,
}

async function makeMounts(): Promise<ProposalSandboxMounts> {
  const mounts = {
    parent: join(root!, 'parent'),
    archive: join(root!, 'archive'),
    evidence: join(root!, 'evidence'),
    contracts: join(root!, 'contracts'),
    childrenRoot: join(root!, 'children'),
  }
  await Promise.all(Object.values(mounts).map((path) => mkdir(path, { recursive: true })))
  return mounts
}

describe('Gate 4 — brokered proposal model gateway', () => {
  it('serves one locked, idempotent route into a networkless sandbox without credentials', async () => {
    const socketPath = join(root!, 'gateway', 'proposal.sock')
    let handlerCalls = 0
    const gateway = await startProposalGateway({
      socketPath,
      route,
      async handle(payload) {
        handlerCalls += 1
        expect(payload).toEqual({ prompt: 'dev-only proposal request' })
        return { assistantText: '{"proposalId":"p1"}', usage: { inputTokens: 10, outputTokens: 5 } }
      },
    })
    try {
      const mounts = await makeMounts()
      const request = {
        schemaVersion: 1,
        requestId: 'request-1',
        route,
        payload: { prompt: 'dev-only proposal request' },
      }
      await writeFile(
        join(mounts.contracts, 'gateway-client.mjs'),
        [
          "import { connect } from 'node:net'",
          "import { writeFile } from 'node:fs/promises'",
          `const request = ${JSON.stringify(request)}`,
          'async function call() {',
          '  return new Promise((resolve, reject) => {',
          "    const socket = connect('/run/proposer-gateway.sock')",
          "    let data = ''",
          "    socket.setEncoding('utf8')",
          "    socket.on('connect', () => socket.end(JSON.stringify(request) + '\\n'))",
          "    socket.on('data', (chunk) => { data += chunk })",
          "    socket.on('end', () => resolve(JSON.parse(data)))",
          "    socket.on('error', reject)",
          '  })',
          '}',
          'const first = await call()',
          'const replay = await call()',
          'if (process.env.DEEPSEEK_API_KEY || JSON.stringify(first) !== JSON.stringify(replay)) process.exit(42)',
          "await writeFile('/work/children/gateway-result.json', JSON.stringify(first))",
          '',
        ].join('\n'),
      )
      const result = await runProposalSandbox({
        mounts,
        command: process.execPath,
        args: ['/input/contracts/gateway-client.mjs'],
        timeoutMs: 10_000,
        gatewaySocket: socketPath,
      })
      expect(result.exitCode, result.stderr).toBe(0)
      expect(handlerCalls).toBe(1)
      const response = JSON.parse(
        await readFile(join(mounts.childrenRoot, 'gateway-result.json'), 'utf8'),
      ) as { ok: boolean; result: { assistantText: string } }
      expect(response.ok).toBe(true)
      expect(response.result.assistantText).toContain('proposalId')
      expect(gateway.receipts()).toHaveLength(1)
    } finally {
      await gateway.close()
    }
    await expect(stat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects route override before calling the trusted handler', async () => {
    const socketPath = join(root!, 'gateway-override', 'proposal.sock')
    let handlerCalls = 0
    const gateway = await startProposalGateway({
      socketPath,
      route,
      async handle() {
        handlerCalls += 1
        return {}
      },
    })
    try {
      const response = await gateway.request({
        schemaVersion: 1,
        requestId: 'bad-route',
        route: { ...route, model: 'gpt-override' },
        payload: {},
      })
      expect(response.ok).toBe(false)
      expect(response.error).toMatch(/route/)
      expect(handlerCalls).toBe(0)
    } finally {
      await gateway.close()
    }
  })

  it('streams DSH chunks through the fixed adapter without exposing a credential', async () => {
    const socketPath = join(root!, 'gateway-adapter', 'proposal.sock')
    let handlerCalls = 0
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'brokered' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'brokered' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const gateway = await startProposalGateway({
      socketPath,
      route,
      async handle() {
        handlerCalls += 1
        return { chunks }
      },
    })
    try {
      const adapter = new ProposalGatewayAdapter({ socketPath, route })
      const options = {
        provider: route.provider,
        model: route.model,
        reasoningEffort: route.reasoningEffort,
        maxTokens: route.maxTokens,
        messages: [],
      }
      const first = []
      for await (const chunk of adapter.stream(options)) first.push(chunk)
      const replay = []
      for await (const chunk of adapter.stream(options)) replay.push(chunk)
      expect(first).toEqual(chunks)
      expect(replay).toEqual(chunks)
      expect(handlerCalls).toBe(1)
      await expect(async () => {
        for await (const _chunk of adapter.stream({ ...options, model: 'gpt-override' })) {
          void _chunk
        }
      }).rejects.toThrow(/locked route/)
    } finally {
      await gateway.close()
    }
  })

  it('the trusted handler rejects extra transport fields before the provider adapter', async () => {
    let adapterCalls = 0
    class MockProvider extends LlmAdapter {
      override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        adapterCalls += 1
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const handler = createProposalGatewayLlmHandler(new MockProvider(), route)
    const valid = {
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
      maxTokens: route.maxTokens,
      messages: [],
    }
    await expect(handler(valid)).resolves.toEqual({
      chunks: [{ type: 'finish', reason: { kind: 'stop' } }],
    })
    await expect(handler({ ...valid, headers: { Authorization: 'forbidden' } })).rejects.toThrow(
      /forbidden field/,
    )
    expect(adapterCalls).toBe(1)
  })
})
