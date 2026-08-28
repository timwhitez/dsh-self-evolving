/**
 * Gateway idempotency tests (issue #56): one durable owner/result per request
 * id across concurrent callers and process restarts.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  requestProposalGateway,
  startProposalGateway,
  type ProposalGatewayHandle,
  type ProposalGatewayRequest,
  type ProposalGatewayRoute,
} from '../src/index.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-gateway-idem-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const route: ProposalGatewayRoute = {
  provider: 'deepseek',
  endpoint: 'https://api.example.com/v1',
  model: 'test-model',
  reasoningEffort: 'high',
  maxTokens: 4096,
}

function envelope(requestId: string, payload: unknown): ProposalGatewayRequest {
  return { schemaVersion: 1, requestId, route, payload }
}

/**
 * Handler that holds the FIRST dispatch open briefly so a concurrent
 * same-id caller must join it (or conflict) instead of running the handler
 * again. Auto-releases after `holdMs`.
 */
function blockingGateway(
  stateDir: string | undefined,
  handler: (payload: unknown) => Promise<unknown>,
  holdMs = 150,
): Promise<{ gateway: ProposalGatewayHandle; calls: () => number }> {
  let calls = 0
  let release: (() => void) | undefined
  const gated = new Promise<void>((done) => {
    release = done
  })
  setTimeout(() => release?.(), holdMs)
  return startProposalGateway({
    socketPath: join(root!, 'proposal.sock'),
    route,
    ...(stateDir === undefined ? {} : { stateDir }),
    handle: async (payload) => {
      calls += 1
      if (calls === 1) await gated
      return handler(payload)
    },
  }).then((gateway) => ({ gateway, calls: () => calls }))
}

describe('proposal gateway idempotency (issue #56)', () => {
  it('dispatches exactly once for concurrent same-id callers and replays one response', async () => {
    const { gateway, calls } = await blockingGateway(undefined, async () => ({
      value: 'result',
    }))
    try {
      const [first, second] = await Promise.all([
        gateway.request(envelope('req-1', { a: 1 })),
        gateway.request(envelope('req-1', { a: 1 })),
      ])
      expect(first).toEqual(second)
      expect(first.ok).toBe(true)
      expect(calls()).toBe(1)
    } finally {
      await gateway.close()
    }
  })

  it('rejects a concurrent same-id caller with a different payload', async () => {
    const { gateway, calls } = await blockingGateway(undefined, async () => ({
      value: 'result',
    }))
    try {
      const [first, second] = await Promise.all([
        gateway.request(envelope('req-2', { a: 1 })),
        gateway.request(envelope('req-2', { a: 2 })),
      ])
      expect(first.ok).toBe(true)
      expect(second.ok).toBe(false)
      if (!second.ok) {
        expect(second.error).toBe('conflicting idempotency replay')
      }
      expect(calls()).toBe(1)
    } finally {
      await gateway.close()
    }
  })

  it('replays a completed request across a gateway restart via the durable store', async () => {
    const stateDir = join(root!, 'gateway-state')
    const first = await startProposalGateway({
      socketPath: join(root!, 'proposal.sock'),
      route,
      stateDir,
      handle: async () => ({ value: 'once' }),
    })
    const original = await first.request(envelope('req-3', { a: 1 }))
    await first.close()
    expect(original.ok).toBe(true)

    const second = await startProposalGateway({
      socketPath: join(root!, 'proposal.sock'),
      route,
      stateDir,
      handle: async () => {
        throw new Error('must not be called after restart')
      },
    })
    try {
      const replayed = await second.request(envelope('req-3', { a: 1 }))
      expect(replayed).toEqual(original)
    } finally {
      await second.close()
    }
  })

  it('fails closed when the durable record is corrupt instead of replaying it', async () => {
    const stateDir = join(root!, 'gateway-state')
    const first = await startProposalGateway({
      socketPath: join(root!, 'proposal.sock'),
      route,
      stateDir,
      handle: async () => ({ value: 'once' }),
    })
    await first.request(envelope('req-4', { a: 1 }))
    await first.close()
    // Corrupt the one record in the store: the file name is the request-id
    // hash, so there is exactly one to clobber.
    const files = await readdir(stateDir)
    expect(files.length).toBe(1)
    await writeFile(join(stateDir, files[0]!), '{not json')

    const second = await startProposalGateway({
      socketPath: join(root!, 'proposal.sock'),
      route,
      stateDir,
      handle: async () => {
        throw new Error('must not be called for a corrupt record')
      },
    })
    try {
      const response = await second.request(envelope('req-4', { a: 1 }))
      expect(response.ok).toBe(false)
      if (!response.ok) {
        expect(response.error).toBe('durable request record is corrupt')
      }
    } finally {
      await second.close()
    }
  })

  it('keeps a pending marker fail-closed across restart and never re-dispatches', async () => {
    const stateDir = join(root!, 'gateway-state')
    let calls = 0
    // A promise that is never resolved: the abandoned dispatch stays pending
    // forever, exactly like a crashed process.
    const gated = new Promise<void>(() => {})
    const first = await startProposalGateway({
      socketPath: join(root!, 'proposal.sock'),
      route,
      stateDir,
      handle: async () => {
        calls += 1
        await gated
        return { value: 'slow' }
      },
    })
    const inFlight = first.request(envelope('req-6', { a: 1 }))
    // Wait until the reservation is durable, then "crash": close the server
    // without releasing the handler and abandon the in-flight request.
    await new Promise((done) => setTimeout(done, 50))
    // "Crash": close the server and ABANDON the in-flight dispatch without
    // ever resolving it, so no completion is written.
    await first.close()

    const second = await startProposalGateway({
      socketPath: join(root!, 'proposal.sock'),
      route,
      stateDir,
      handle: async () => {
        calls += 1
        return { value: 'second' }
      },
    })
    try {
      const response = await second.request(envelope('req-6', { a: 1 }))
      expect(response.ok).toBe(false)
      if (!response.ok) {
        expect(response.error).toBe('durable request pending from an interrupted dispatch')
      }
      expect(calls).toBe(1)
      void inFlight.catch(() => {})
    } finally {
      await second.close()
    }
  })

  it('syncs the reservation file and directory before any paid handler dispatch', async () => {
    const checkpoints: string[] = []
    let calls = 0
    const gateway = await startProposalGateway({
      socketPath: join(root!, 'proposal.sock'),
      route,
      stateDir: join(root!, 'gateway-state'),
      onDurabilityCheckpoint(checkpoint) {
        checkpoints.push(checkpoint)
      },
      handle: async () => {
        calls += 1
        expect(checkpoints.at(-1)).toBe('reservation-directory-synced')
        return { value: 'durable' }
      },
    })
    try {
      const response = await gateway.request(envelope('req-durable-order', { a: 1 }))
      expect(response.ok).toBe(true)
      expect(calls).toBe(1)
      expect(checkpoints).toEqual([
        'reservation-file-synced',
        'reservation-directory-synced',
        'completion-file-synced',
        'completion-renamed',
        'completion-directory-synced',
      ])
    } finally {
      await gateway.close()
    }
  })

  it.each(['reservation-file-synced', 'reservation-directory-synced'] as const)(
    'never dispatches after a crash injected at %s',
    async (injectedCheckpoint) => {
      const stateDir = join(root!, 'gateway-state')
      let calls = 0
      const first = await startProposalGateway({
        socketPath: join(root!, 'proposal.sock'),
        route,
        stateDir,
        onDurabilityCheckpoint(checkpoint) {
          if (checkpoint === injectedCheckpoint) {
            throw new Error(`injected host crash at ${checkpoint}`)
          }
        },
        handle: async () => {
          calls += 1
          return { value: 'must-not-run' }
        },
      })
      await expect(first.request(envelope(`req-${injectedCheckpoint}`, { a: 1 }))).rejects.toThrow(
        /injected host crash/,
      )
      await first.close()
      expect(calls).toBe(0)

      const restarted = await startProposalGateway({
        socketPath: join(root!, 'proposal.sock'),
        route,
        stateDir,
        handle: async () => {
          calls += 1
          return { value: 'duplicate' }
        },
      })
      try {
        const response = await restarted.request(envelope(`req-${injectedCheckpoint}`, { a: 1 }))
        expect(response.ok).toBe(false)
        if (!response.ok) {
          expect(response.error).toBe('durable request pending from an interrupted dispatch')
        }
        expect(calls).toBe(0)
      } finally {
        await restarted.close()
      }
    },
  )

  it.each([
    ['completion-file-synced', false],
    ['completion-renamed', true],
    ['completion-directory-synced', true],
  ] as const)(
    'never repeats a paid call after caller loss at %s',
    async (injectedCheckpoint, expectReplay) => {
      const stateDir = join(root!, 'gateway-state')
      let calls = 0
      const first = await startProposalGateway({
        socketPath: join(root!, 'proposal.sock'),
        route,
        stateDir,
        onDurabilityCheckpoint(checkpoint) {
          if (checkpoint === injectedCheckpoint) {
            throw new Error(`injected caller loss at ${checkpoint}`)
          }
        },
        handle: async () => {
          calls += 1
          return { value: 'paid-once' }
        },
      })
      const firstResponse = await first.request(envelope(`req-${injectedCheckpoint}`, { a: 1 }))
      expect(firstResponse).toMatchObject({ ok: false, error: 'durable completion write failed' })
      await first.close()
      expect(calls).toBe(1)

      const restarted = await startProposalGateway({
        socketPath: join(root!, 'proposal.sock'),
        route,
        stateDir,
        handle: async () => {
          calls += 1
          return { value: 'duplicate' }
        },
      })
      try {
        const replayed = await restarted.request(envelope(`req-${injectedCheckpoint}`, { a: 1 }))
        expect(replayed.ok).toBe(expectReplay)
        expect(calls).toBe(1)
      } finally {
        await restarted.close()
      }
    },
  )

  it('allows an in-place retry after a failed dispatch and records the success durably', async () => {
    const stateDir = join(root!, 'gateway-state')
    let calls = 0
    const gateway = await startProposalGateway({
      socketPath: join(root!, 'proposal.sock'),
      route,
      stateDir,
      handle: async () => {
        calls += 1
        if (calls === 1) throw new Error('transient provider failure')
        return { value: 'ok' }
      },
    })
    try {
      const failed = await gateway.request(envelope('req-7', { a: 1 }))
      expect(failed.ok).toBe(false)
      const retried = await gateway.request(envelope('req-7', { a: 1 }))
      expect(retried.ok).toBe(true)
      expect(calls).toBe(2)
    } finally {
      await gateway.close()
    }

    const restarted = await startProposalGateway({
      socketPath: join(root!, 'proposal.sock'),
      route,
      stateDir,
      handle: async () => {
        throw new Error('must not be called after restart')
      },
    })
    try {
      const replayed = await restarted.request(envelope('req-7', { a: 1 }))
      expect(replayed.ok).toBe(true)
    } finally {
      await restarted.close()
    }
  })

  it('rejects a same-id restart replay whose payload changed', async () => {
    const stateDir = join(root!, 'gateway-state')
    const first = await startProposalGateway({
      socketPath: join(root!, 'proposal.sock'),
      route,
      stateDir,
      handle: async () => ({ value: 'once' }),
    })
    await first.request(envelope('req-8', { a: 1 }))
    await first.close()

    const second = await startProposalGateway({
      socketPath: join(root!, 'proposal.sock'),
      route,
      stateDir,
      handle: async () => ({ value: 'different' }),
    })
    try {
      const response = await second.request(envelope('req-8', { a: 999 }))
      expect(response.ok).toBe(false)
      if (!response.ok) expect(response.error).toBe('conflicting idempotency replay')
    } finally {
      await second.close()
    }
  })

  it('never replays a poisoned success whose stored response body was corrupted', async () => {
    const stateDir = join(root!, 'gateway-state')
    const first = await startProposalGateway({
      socketPath: join(root!, 'proposal.sock'),
      route,
      stateDir,
      handle: async () => ({ value: 'real' }),
    })
    const original = await first.request(envelope('req-10', { a: 1 }))
    await first.close()
    expect(original.ok).toBe(true)

    // Rewrite the record with a well-formed envelope whose result/hash were
    // poisoned: replay must refuse it, not serve the forgery.
    const files = await readdir(stateDir)
    expect(files.length).toBe(1)
    const path = join(stateDir, files[0]!)
    const record = JSON.parse(await readFile(path, 'utf8')) as {
      response: { result: unknown; responseHash: string }
    }
    record.response.result = { value: 'POISONED' }
    record.response.responseHash = 'sha256:deadbeef'
    await writeFile(path, `${JSON.stringify(record)}\n`)

    const second = await startProposalGateway({
      socketPath: join(root!, 'proposal.sock'),
      route,
      stateDir,
      handle: async () => {
        throw new Error('must not re-dispatch a poisoned record')
      },
    })
    try {
      const response = await second.request(envelope('req-10', { a: 1 }))
      expect(response.ok).toBe(false)
      if (!response.ok) {
        expect(response.error).toBe('durable request record is corrupt')
      }
    } finally {
      await second.close()
    }
  })

  it('rebinds over a stale socket file left by a crashed owner and still refuses a live one', async () => {
    const stateDir = join(root!, 'gateway-state')
    const live = await startProposalGateway({
      socketPath: join(root!, 'proposal.sock'),
      route,
      stateDir,
      handle: async () => ({ value: 'live' }),
    })
    // A second gateway on the LIVE socket must still be refused.
    await expect(
      startProposalGateway({
        socketPath: join(root!, 'proposal.sock'),
        route,
        stateDir,
        handle: async () => ({ value: 'other' }),
      }),
    ).rejects.toThrow(/socket path already exists/)
    await live.close()

    // Hard-crash simulation: a leftover socket FILE with no listener behind
    // it (graceful close removes the file; a SIGKILL does not).
    const stalePath = join(root!, 'stale.sock')
    await writeFile(stalePath, '')
    const rebinder = await startProposalGateway({
      socketPath: stalePath,
      route,
      stateDir,
      handle: async () => ({ value: 'rebound' }),
    })
    try {
      const response = await rebinder.request(envelope('req-11', { a: 1 }))
      expect(response.ok).toBe(true)
    } finally {
      await rebinder.close()
    }
  })

  it('serves concurrent same-id callers through the socket transport with one dispatch', async () => {
    const { gateway, calls } = await blockingGateway(join(root!, 'gateway-state'), async () => ({
      value: 'socket',
    }))
    try {
      const [first, second] = await Promise.all([
        requestProposalGateway(gateway.socketPath, envelope('req-9', { a: 1 })),
        requestProposalGateway(gateway.socketPath, envelope('req-9', { a: 1 })),
      ])
      expect(first).toEqual(second)
      expect(first.ok).toBe(true)
      expect(calls()).toBe(1)
    } finally {
      await gateway.close()
    }
  })
})
