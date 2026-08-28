import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROPOSAL_RESOURCE_POLICY_V1, PROPOSAL_WRITABLE_MOUNTS_V1 } from '@dsh-self-evolving/core'
import { resourcePolicyDigest, type ResourceDomainReceipt } from '@dsh-self-evolving/candidate-sdk'
import { proposalGatewayRouteHash } from '@dsh-self-evolving/proposer'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifyStableProposalPublications } from '../src/audit.js'
import { publishBundle } from '../src/publish.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'stable-proposal-audit-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const proposal = {
  proposalId: 'proposal-1-1',
  parentCandidateId: `sha256:${'1'.repeat(64)}`,
  hypothesis: 'bounded change',
  sourceDiff: '@@ change',
  evidenceRefs: [`object:sha256:${'2'.repeat(64)}`],
  artifactDigest: `sha256:${'3'.repeat(64)}`,
}

const route = {
  provider: 'deepseek',
  endpoint: 'https://api.deepseek.com/v1',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  maxTokens: 32_768,
}

function routeHash(): string {
  return proposalGatewayRouteHash(route)
}

function gatewayAttempt(status: number, attemptIndex = 0) {
  return {
    attemptIndex,
    status,
    retryable: status === 408 || status === 429 || status >= 500,
    ambiguous: status === 408 || status >= 500,
    discardedUsage: null,
    responseId: null,
  }
}

function gatewayReceipt(): Record<string, unknown> {
  return {
    requestId: `llm-${'7'.repeat(64)}`,
    requestHash: `sha256:${'4'.repeat(64)}`,
    responseHash: `sha256:${'5'.repeat(64)}`,
    routeHash: routeHash(),
    attempts: [gatewayAttempt(200)],
  }
}

function resource(): ResourceDomainReceipt {
  return {
    schemaVersion: 1,
    policyDigest: resourcePolicyDigest(PROPOSAL_RESOURCE_POLICY_V1),
    policy: PROPOSAL_RESOURCE_POLICY_V1,
    enforcement: {
      cgroup: 'v2-delegated',
      rlimits: true,
      ioDevices: ['259:0'],
      writableStorage: 'tmpfs-size-inode-hard-limit',
      writableStoragePeakSamplingMs: 10,
      writableMounts: PROPOSAL_WRITABLE_MOUNTS_V1.map(({ path, maxBytes, maxFiles }) => ({
        path,
        maxBytes,
        maxFiles,
      })),
      sandbox: {
        filesystemRoot: 'read-only',
        writablePaths: 'bounded-tmpfs-only',
        nestedUserNamespaces: 'disabled',
        targetPidNamespace: 'private-descendant',
        targetCapabilities: 'none',
        noNewPrivileges: true,
      },
    },
    usage: {
      memoryPeakBytes: 1,
      pidsPeak: 1,
      cpuUsageUsec: 2,
      cpuUserUsec: 1,
      cpuSystemUsec: 1,
      cpuThrottledUsec: 0,
      cpuThrottledPeriods: 0,
      ioReadBytes: 0,
      ioWriteBytes: 0,
      ioReadOps: 0,
      ioWriteOps: 0,
      writableStoragePeakBytes: 1,
      writableStoragePeakFiles: 1,
    },
    events: { memoryMaxEvents: 0, memoryOomEvents: 0, memoryOomKills: 0, pidsMaxEvents: 0 },
    terminationCause: 'COMPLETED',
    exitCode: 0,
    signal: null,
  }
}

async function publication(
  receipt: ResourceDomainReceipt,
  eventProposal = proposal,
  gatewayReceipts: unknown[] = [gatewayReceipt()],
) {
  const dir = join(root!, 'artifacts', 'proposal-1-1')
  await mkdir(dir, { recursive: true })
  await publishBundle(dir, {
    'proposal.json': `${JSON.stringify(eventProposal, null, 2)}\n`,
    'gateway-receipts.json': `${JSON.stringify(gatewayReceipts)}\n`,
    'idempotency-key.json': `${JSON.stringify({
      idempotencyKey: `audit-run/proposal/1/1/${proposal.parentCandidateId}`,
    })}\n`,
    'sandbox-resource.json': `${JSON.stringify(receipt)}\n`,
  })
}

const event = () => ({ eventId: 'proposal:1:1:completed', payload: proposal })

describe('stable proposal publication audit', () => {
  it('accepts an exact committed proposal/resource/gateway/idempotency bundle', async () => {
    await publication(resource())
    await expect(
      verifyStableProposalPublications(root!, 'audit-run', route, [event()]),
    ).resolves.toEqual([])
  })

  it('rejects a self-consistently committed failed proposal resource receipt', async () => {
    const failed = resource()
    failed.terminationCause = 'CONTROL_PROTOCOL_FAILURE'
    failed.exitCode = null
    failed.signal = 'SIGKILL'
    await publication(failed)
    const reasons = await verifyStableProposalPublications(root!, 'audit-run', route, [event()])
    expect(reasons.join('\n')).toMatch(/resource receipt.*exit code zero/)
  })

  it('rejects a committed proposal whose bytes differ from the journal event', async () => {
    await publication(resource(), { ...proposal, hypothesis: 'different bytes' })
    const reasons = await verifyStableProposalPublications(root!, 'audit-run', route, [event()])
    expect(reasons.join('\n')).toMatch(/proposal bytes differ from journal/)
  })

  it('rejects a missing committed bundle for a proposal completion event', async () => {
    const reasons = await verifyStableProposalPublications(root!, 'audit-run', route, [event()])
    expect(reasons.join('\n')).toMatch(/committed bundle is missing/)
  })

  it.each([
    ['empty request id', { requestId: '' }],
    ['malformed attempt row', { attempts: [null] }],
    ['empty error', { error: '' }],
    ['foreign route hash', { routeHash: `sha256:${'9'.repeat(64)}` }],
  ] as const)('rejects a gateway receipt with %s', async (_label, mutation) => {
    await publication(resource(), proposal, [{ ...gatewayReceipt(), ...mutation }])
    const reasons = await verifyStableProposalPublications(root!, 'audit-run', route, [event()])
    expect(reasons.join('\n')).toMatch(/gateway receipt matrix is invalid/)
  })

  it.each([
    [
      'failure-only evidence',
      [{ ...gatewayReceipt(), attempts: [gatewayAttempt(503)], error: 'provider failed' }],
    ],
    ['a success receipt carrying an error', [{ ...gatewayReceipt(), error: 'impossible' }]],
    [
      'a non-retryable attempt followed by success',
      [{ ...gatewayReceipt(), attempts: [gatewayAttempt(400), gatewayAttempt(200, 1)] }],
    ],
  ] as const)('rejects completed proposal gateway matrix with %s', async (_label, receipts) => {
    await publication(resource(), proposal, [...receipts])
    const reasons = await verifyStableProposalPublications(root!, 'audit-run', route, [event()])
    expect(reasons.join('\n')).toMatch(/gateway receipt matrix is invalid/)
  })
})
