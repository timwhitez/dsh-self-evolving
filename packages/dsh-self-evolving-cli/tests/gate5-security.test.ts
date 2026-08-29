import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { ProposalGatewayAdapter, type ProposalGatewayRoute } from '@dsh-self-evolving/proposer'
import { brokerPolicyForReservation } from '../../../scripts/run-gate5-real-calibration.js'
import {
  GATE5_MODEL_SOCKET_TARGET,
  assertCompleteGate5BrokerEvidence,
  assertExactGate5ReconstructedSummary,
  assertGate5TaskOverlay,
  createGate5BrokerSigningAuthority,
  gate5WorstCaseUsdMicrosPerRequest,
  prepareGate5TaskOverlay,
  sanitizeGate5HarborEnvironment,
  startGate5CredentialBroker,
  writeGate5ExecutionTerminal,
  type Gate5BrokerPolicy,
  type Gate5TrialIdentity,
} from '../src/gate5-security.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gate5-security-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const route: ProposalGatewayRoute = {
  provider: 'deepseek-official',
  endpoint: 'https://api.deepseek.com/v1',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  maxTokens: 32_768,
}

const identity: Gate5TrialIdentity = {
  runId: 'run-1',
  candidateId: `sha256:${'1'.repeat(64)}`,
  trialId: 'trial-0000',
  taskId: 'fixture-task',
  attemptIndex: 0,
}

const policy: Gate5BrokerPolicy = {
  schemaVersion: 1,
  route,
  contextWindow: 1_048_576,
  socketTarget: GATE5_MODEL_SOCKET_TARGET,
  maxTransportRetries: 0,
  reasoningContinuationMaxTurns: 0,
  trialReservationUsdMicros: 1_000_000,
  pricingUnitTokens: 1_000_000,
  cacheHitInputUsdMicrosPerUnit: 2_800,
  cacheMissInputUsdMicrosPerUnit: 140_000,
  outputUsdMicrosPerUnit: 280_000,
  maxInputTokensPerRequest: 1_048_576,
  maxRequests: 4,
  maxRequestBytes: 1024 * 1024,
  maxPayloadBytesTotal: 4 * 1024 * 1024,
  maxReservedOutputTokens: 4 * 32_768,
  maxResponseBytes: 4 * 1024 * 1024,
  maxConnections: 4,
  idleTimeoutMs: 10_000,
  requestTimeoutMs: 60_000,
}

class RecordedAdapter extends LlmAdapter {
  lastFetchAttempts = [
    {
      attemptIndex: 0,
      status: 200,
      retryable: false,
      ambiguous: false,
      discardedUsage: null,
      responseId: null,
    },
  ]

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'brokered' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'brokered' } }
    yield {
      type: 'usage',
      usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, reasoningTokens: 2 },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function writeTask(path: string, agentPolicy = ''): Promise<void> {
  await mkdir(join(path, 'environment'), { recursive: true })
  await writeFile(join(path, 'instruction.md'), 'fixture\n')
  await writeFile(join(path, 'environment', 'Dockerfile'), 'FROM scratch\n')
  await writeFile(
    join(path, 'task.toml'),
    [
      'schema_version = "1.4"',
      '',
      '[task]',
      'name = "fixture/task"',
      'version = "1.0.0"',
      '',
      '[agent]',
      'timeout_sec = 60',
      agentPolicy,
      '',
      '[environment]',
      'cpus = 1',
      '',
    ].join('\n'),
  )
}

describe('Gate 5 credential isolation contracts', () => {
  it('caps the default stable trial at two worst-case calls within 333333 micro-USD', () => {
    const production = brokerPolicyForReservation(333_333)
    const perRequest = gate5WorstCaseUsdMicrosPerRequest(production)
    expect(perRequest).toBe(155_976)
    expect(production.maxRequests).toBe(2)
    expect(production.maxRequests * perRequest).toBeLessThanOrEqual(
      production.trialReservationUsdMicros,
    )
    expect(production.maxReservedOutputTokens).toBe(2 * 32_768)
  })

  it('rejects status, reward, or cost changes against reconstructed raw evidence', () => {
    const reconstructed = {
      schemaVersion: 2,
      normalized: [{ status: 'pass', reward: 1, costUsd: 0.01 }],
    }
    expect(() => assertExactGate5ReconstructedSummary(reconstructed, reconstructed)).not.toThrow()
    for (const row of [
      { status: 'fail', reward: 1, costUsd: 0.01 },
      { status: 'pass', reward: 0, costUsd: 0.01 },
      { status: 'pass', reward: 1, costUsd: 0 },
    ]) {
      expect(() =>
        assertExactGate5ReconstructedSummary(
          { schemaVersion: 2, normalized: [row] },
          reconstructed,
        ),
      ).toThrow(/reconstructed raw evidence/i)
    }
  })

  it('copies and hashes a task overlay while forcing only the agent phase offline', async () => {
    const source = join(root, 'source')
    const overlay = join(root, 'overlay')
    await writeTask(source)

    const receipt = await prepareGate5TaskOverlay({ sourceDir: source, destinationDir: overlay })

    expect(receipt.originalSha256).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(receipt.overlaySha256).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(receipt.overlaySha256).not.toBe(receipt.originalSha256)
    expect(await readFile(join(source, 'task.toml'), 'utf8')).not.toContain('network_mode')
    expect(await readFile(join(overlay, 'task.toml'), 'utf8')).toContain(
      'network_mode = "no-network"',
    )
  })

  it('rejects a task that explicitly grants the candidate network access', async () => {
    const source = join(root, 'source-public')
    await writeTask(source, 'network_mode = "public"')
    await expect(
      prepareGate5TaskOverlay({ sourceDir: source, destinationDir: join(root, 'overlay-public') }),
    ).rejects.toThrow(/agent network policy/i)
  })

  it('rejects an overlay that changes after its pre-launch receipt', async () => {
    const source = join(root, 'source-drift')
    const overlay = join(root, 'overlay-drift')
    await writeTask(source)
    const receipt = await prepareGate5TaskOverlay({ sourceDir: source, destinationDir: overlay })
    await writeFile(join(overlay, 'instruction.md'), 'tampered\n')

    await expect(
      assertGate5TaskOverlay({ sourceDir: source, destinationDir: overlay, receipt }),
    ).rejects.toThrow(/overlay digest changed/i)
  })

  it('removes every credential-shaped variable before Harbor is launched', () => {
    expect(
      sanitizeGate5HarborEnvironment({
        PATH: '/usr/bin',
        LANG: 'C.UTF-8',
        DEEPSEEK_API_KEY: 'provider-secret',
        OPENAI_API_KEY: 'other-secret',
        SERVICE_AUTH_TOKEN: 'bearer',
      }),
    ).toEqual({ PATH: '/usr/bin', LANG: 'C.UTF-8' })
  })

  it('signs fixed-identity receipts and rejects any evidence tampering', async () => {
    const authority = createGate5BrokerSigningAuthority()
    const broker = await startGate5CredentialBroker({
      socketPath: join(root, 'broker.sock'),
      stateDir: join(root, 'requests'),
      identity,
      policy,
      adapter: new RecordedAdapter(),
      authority,
    })
    const client = new ProposalGatewayAdapter({
      socketPath: broker.socketPath,
      route,
      contextWindow: policy.contextWindow,
    })
    const chunks: StreamChunk[] = []
    for await (const chunk of client.stream({
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
      maxTokens: route.maxTokens,
      messages: [{ role: 'user', content: 'fixture' }],
    })) {
      chunks.push(chunk)
    }
    expect(chunks.some((chunk) => chunk.type === 'usage')).toBe(true)

    const evidence = await broker.complete()
    expect(
      assertCompleteGate5BrokerEvidence(evidence, {
        identity,
        policy,
        publicKeySpki: authority.publicKeySpki,
      }).usage,
    ).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
      reasoningTokens: 2,
      events: 1,
    })
    const terminalPath = join(root, 'usage-mismatch-terminal.json')
    await expect(
      writeGate5ExecutionTerminal({
        path: terminalPath,
        value: { schemaVersion: 1 },
        trials: [
          {
            evidence,
            identity,
            policy,
            publicKeySpki: authority.publicKeySpki,
            sessionUsage: { ...evidence.usage, outputTokens: evidence.usage.outputTokens + 1 },
          },
        ],
      }),
    ).rejects.toThrow(/broker\/session usage mismatch/i)
    expect(await stat(terminalPath).catch(() => null)).toBeNull()
    const missingUsageTerminalPath = join(root, 'missing-usage-terminal.json')
    await expect(
      writeGate5ExecutionTerminal({
        path: missingUsageTerminalPath,
        value: { schemaVersion: 1 },
        trials: [
          {
            evidence,
            identity,
            policy,
            publicKeySpki: authority.publicKeySpki,
            sessionUsage: undefined,
          },
        ],
      }),
    ).rejects.toThrow(/usage is invalid/i)
    expect(await stat(missingUsageTerminalPath).catch(() => null)).toBeNull()
    expect(() =>
      assertCompleteGate5BrokerEvidence(
        { ...evidence, identity: { ...evidence.identity, taskId: 'tampered' } },
        { identity, policy, publicKeySpki: authority.publicKeySpki },
      ),
    ).toThrow(/signature|identity/i)
  })

  it('refuses a broker socket that local host users could reach', async () => {
    const publicDirectory = join(root, 'public-sockets')
    await mkdir(publicDirectory, { mode: 0o755 })
    await chmod(publicDirectory, 0o755)
    await expect(
      startGate5CredentialBroker({
        socketPath: join(publicDirectory, 'model.sock'),
        stateDir: join(root, 'public-socket-state'),
        identity,
        policy,
        adapter: new RecordedAdapter(),
        authority: createGate5BrokerSigningAuthority(),
      }),
    ).rejects.toThrow(/socket parent must be a private real directory/i)
  })

  it('rejects a policy whose worst-case provider spend exceeds the durable trial reservation', async () => {
    const perRequest = gate5WorstCaseUsdMicrosPerRequest(policy)
    const oversold = {
      ...policy,
      trialReservationUsdMicros: perRequest * policy.maxRequests - 1,
    }
    await expect(
      startGate5CredentialBroker({
        socketPath: join(root, 'oversold.sock'),
        stateDir: join(root, 'oversold-state'),
        identity,
        policy: oversold,
        adapter: new RecordedAdapter(),
        authority: createGate5BrokerSigningAuthority(),
      }),
    ).rejects.toThrow(/exceeds the durable USD reservation/i)
  })

  it('records a policy violation when the candidate exceeds its output reservation', async () => {
    const authority = createGate5BrokerSigningAuthority()
    const oneRequest = { ...policy, maxReservedOutputTokens: 32_768 }
    const broker = await startGate5CredentialBroker({
      socketPath: join(root, 'limited.sock'),
      stateDir: join(root, 'limited-requests'),
      identity,
      policy: oneRequest,
      adapter: new RecordedAdapter(),
      authority,
    })
    const client = new ProposalGatewayAdapter({
      socketPath: broker.socketPath,
      route,
      contextWindow: policy.contextWindow,
    })
    const call = async (text: string) => {
      for await (const _chunk of client.stream({
        provider: route.provider,
        model: route.model,
        messages: [{ role: 'user', content: text }],
      })) {
        void _chunk
      }
    }
    await call('first')
    await expect(call('second')).rejects.toThrow(/trusted provider handler failed/)
    const evidence = await broker.complete()
    expect(evidence.status).toBe('policy-violation')
    expect(evidence.violations).toContain('reserved-output-tokens-exceeded')
    expect(() =>
      assertCompleteGate5BrokerEvidence(evidence, {
        identity,
        policy: oneRequest,
        publicKeySpki: authority.publicKeySpki,
      }),
    ).toThrow(/not complete/i)
    const terminalPath = join(root, 'policy-violation-terminal.json')
    await expect(
      writeGate5ExecutionTerminal({
        path: terminalPath,
        value: { schemaVersion: 1 },
        trials: [
          {
            evidence,
            identity,
            policy: oneRequest,
            publicKeySpki: authority.publicKeySpki,
            sessionUsage: evidence.usage,
          },
        ],
      }),
    ).rejects.toThrow(/not complete/i)
    expect(await stat(terminalPath).catch(() => null)).toBeNull()
  })
})
