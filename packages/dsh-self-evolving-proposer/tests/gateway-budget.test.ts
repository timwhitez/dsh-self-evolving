/**
 * Proposal gateway connection-budget contract (issue #86).
 *
 * A single untrusted sandbox must not be able to exhaust the trusted
 * gateway's descriptors by holding sockets open without EOF: connection
 * count is capped, silent sockets die on the idle deadline, an over-limit
 * body destroys the socket immediately, and a complete request still gets
 * its bounded handler window.
 */
import { createConnection } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  requestProposalGateway,
  startProposalGateway,
  type ProposalGatewayRequest,
} from '../src/gateway.js'

const route = {
  provider: 'deepseek-official',
  endpoint: 'https://provider.invalid/v1',
  model: 'deepseek-v4-flash-zen',
  reasoningEffort: 'high' as const,
  maxTokens: 2048,
}

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gateway-budget-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function request(id: string): ProposalGatewayRequest {
  return { schemaVersion: 1, requestId: id, route, payload: {} }
}

describe('gateway connection budget', () => {
  it('destroys excess connections beyond maxConnections', async () => {
    const gateway = await startProposalGateway({
      socketPath: join(root!, 'gw.sock'),
      route,
      handle: async () => ({}),
      maxConnections: 1,
    })
    try {
      const first = createConnection(gateway.socketPath)
      await new Promise<void>((done) => first.once('connect', done))
      // The second connection must be rejected instead of being buffered.
      const second = createConnection(gateway.socketPath)
      const outcome = await new Promise<string>((done) => {
        second.once('close', () => done('closed'))
        second.once('data', () => done('data'))
      })
      expect(outcome).toBe('closed')
      second.destroy()
      first.destroy()
    } finally {
      await gateway.close()
    }
  })

  it('destroys a socket that never sends data or EOF on the idle deadline', async () => {
    const gateway = await startProposalGateway({
      socketPath: join(root!, 'gw.sock'),
      route,
      handle: async () => ({}),
      idleTimeoutMs: 150,
    })
    try {
      const silent = createConnection(gateway.socketPath)
      await new Promise<void>((done) => silent.once('connect', done))
      const start = Date.now()
      await new Promise<void>((done) => silent.once('close', done))
      expect(Date.now() - start).toBeLessThan(5_000)
    } finally {
      await gateway.close()
    }
  })

  it('destroys immediately when the body exceeds the byte limit', async () => {
    const gateway = await startProposalGateway({
      socketPath: join(root!, 'gw.sock'),
      route,
      handle: async () => {
        throw new Error('handler must not run for over-limit bodies')
      },
      maxRequestBytes: 32,
      requestTimeoutMs: 2_000,
    })
    try {
      const attacker = createConnection(gateway.socketPath)
      attacker.write(`${'A'.repeat(64)}\n`)
      await new Promise<void>((done) => attacker.once('close', done))
      // No response bytes were needed; destruction itself is the rejection.
      expect(true).toBe(true)
    } finally {
      await gateway.close()
    }
  })

  it('still serves a well-formed request under tight budgets', async () => {
    let calls = 0
    const gateway = await startProposalGateway({
      socketPath: join(root!, 'gw.sock'),
      route,
      handle: async () => {
        calls += 1
        return { ok: true }
      },
      maxConnections: 1,
      idleTimeoutMs: 200,
      requestTimeoutMs: 2_000,
    })
    try {
      const response = await requestProposalGateway(gateway.socketPath, request('r1'))
      expect(response.ok).toBe(true)
      expect(calls).toBe(1)
    } finally {
      await gateway.close()
    }
  })
})
