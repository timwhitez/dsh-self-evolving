import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  recoverV011OutcomeDerivation,
  recoverV011ProposalPublication,
  type DurablePublishIdentity,
} from '../src/proposal/v011-recovery.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-v011-recovery-callback-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`
}

function proposalBytes(proposalId: `p_${string}`): Buffer {
  const citation = (character: string) => ({
    objectDigest: digest(character),
    mediaType: 'application/json',
    locator: { kind: 'json-pointer' as const, value: '/result' },
    observation: `observation-${character}`,
  })
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      proposalId,
      canonicalParentDigest: digest('1'),
      evidenceExport: { manifestDigest: digest('2'), merkleRoot: digest('3') },
      donorCandidates: [],
      analysisPath: 'analysis.json',
      hypothesis: 'A bounded change should improve the selected target mechanism.',
      evidenceCitations: [citation('4'), citation('5')],
      declaredOperations: [{ op: 'modify', path: 'src/index.ts' }],
      mechanismAssertions: ['the target mechanism changes'],
      preservationAssertions: ['unrelated behavior remains stable'],
      capabilityRequests: [],
    }) + '\n',
  )
}

describe('v0.1.1 recovery post-publish callbacks', () => {
  it('runs the proposal callback when a durable artifact is reused', async () => {
    const path = join(root!, 'proposal.json')
    const proposalId = `p_${'a'.repeat(32)}` as const
    const bytes = proposalBytes(proposalId)
    await recoverV011ProposalPublication({
      path,
      expectedProposalId: proposalId,
      produce: async () => bytes,
    })

    const identities: DurablePublishIdentity[] = []
    let producerCalls = 0
    const recovered = await recoverV011ProposalPublication({
      path,
      expectedProposalId: proposalId,
      produce: async () => {
        producerCalls += 1
        throw new Error('producer must not run for a reused artifact')
      },
      afterDurablePublish: async (identity) => {
        identities.push(identity)
      },
    })

    expect(recovered.status).toBe('REUSED')
    expect(Buffer.from(recovered.bytes)).toEqual(bytes)
    expect(producerCalls).toBe(0)
    expect(identities).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        artifactKind: 'proposal',
        actionId: proposalId,
        artifactDigest: recovered.digest,
        reconciliationId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      }),
    ])
  })

  it('runs the proposal callback when a new artifact is created', async () => {
    const proposalId = `p_${'b'.repeat(32)}` as const
    let identity: DurablePublishIdentity | undefined
    const recovered = await recoverV011ProposalPublication({
      path: join(root!, 'created-proposal.json'),
      expectedProposalId: proposalId,
      produce: async () => proposalBytes(proposalId),
      afterDurablePublish: (published) => {
        identity = published
      },
    })

    expect(recovered.status).toBe('CREATED')
    expect(identity).toMatchObject({
      artifactKind: 'proposal',
      actionId: proposalId,
      artifactDigest: recovered.digest,
    })
  })

  it('runs the outcome callback when an exactly-once record is reused', async () => {
    const path = join(root!, 'outcome.json')
    const input = {
      path,
      proposalDigest: digest('1'),
      hypothesis: 'the child should improve the target task',
      candidateDigest: digest('2'),
      targetClusterSlug: 'target-cluster',
      targetTaskHandle: 'task-a',
      trials: [
        {
          ref: digest('3'),
          role: 'target-baseline' as const,
          status: 'fail' as const,
          reward: 0 as const,
          taskId: 'task-a',
          attemptIndex: 0,
        },
        {
          ref: digest('4'),
          role: 'target-child' as const,
          status: 'pass' as const,
          reward: 1 as const,
          taskId: 'task-a',
          attemptIndex: 0,
        },
      ],
    }
    let firstIdentity: DurablePublishIdentity | undefined
    const first = await recoverV011OutcomeDerivation({
      ...input,
      afterDurablePublish: (identity) => {
        firstIdentity = identity
      },
    })
    expect(first.status).toBe('CREATED')

    let reusedIdentity: DurablePublishIdentity | undefined
    const recovered = await recoverV011OutcomeDerivation({
      ...input,
      afterDurablePublish: async (identity) => {
        reusedIdentity = identity
      },
    })

    expect(recovered.status).toBe('REUSED')
    expect(recovered.record.idempotencyKey).toBe(first.record.idempotencyKey)
    expect(reusedIdentity).toEqual(firstIdentity)
    expect(reusedIdentity).toMatchObject({
      artifactKind: 'mechanism-outcome',
      actionId: first.record.idempotencyKey,
    })
  })

  it('rejects malformed reused proposal bytes before reconciliation', async () => {
    const path = join(root!, 'malformed-proposal.json')
    await writeFile(path, JSON.stringify({ proposalId: `p_${'c'.repeat(32)}` }) + '\n')
    let callbackCalls = 0

    await expect(
      recoverV011ProposalPublication({
        path,
        expectedProposalId: `p_${'c'.repeat(32)}`,
        produce: async () => {
          throw new Error('producer must not run')
        },
        afterDurablePublish: () => {
          callbackCalls += 1
        },
      }),
    ).rejects.toThrow(/proposal schema rejected/)
    expect(callbackCalls).toBe(0)
  })

  it('arbitrates concurrent proposal publication without clobbering or identity drift', async () => {
    const path = join(root!, 'concurrent-proposal.json')
    const proposalId = `p_${'d'.repeat(32)}` as const
    const bytes = proposalBytes(proposalId)
    let arrivals = 0
    let release!: () => void
    const gate = new Promise<void>((done) => {
      release = done
    })
    const identities: DurablePublishIdentity[] = []
    const publish = () =>
      recoverV011ProposalPublication({
        path,
        expectedProposalId: proposalId,
        produce: async () => {
          arrivals += 1
          if (arrivals === 2) release()
          await gate
          return bytes
        },
        afterDurablePublish: (identity) => {
          identities.push(identity)
        },
      })

    const results = await Promise.all([publish(), publish()])
    expect(results.map((result) => result.status).sort()).toEqual(['CREATED', 'REUSED'])
    expect(identities).toHaveLength(2)
    expect(identities[0]).toEqual(identities[1])
    expect(Buffer.from(results[0]!.bytes)).toEqual(bytes)
    expect(Buffer.from(results[1]!.bytes)).toEqual(bytes)
  })

  it('rejects a reused artifact symlink without following it', async () => {
    const proposalId = `p_${'e'.repeat(32)}` as const
    const outside = join(root!, 'outside-proposal.json')
    const path = join(root!, 'proposal-link.json')
    await writeFile(outside, proposalBytes(proposalId))
    await symlink(outside, path)
    let callbackCalls = 0

    await expect(
      recoverV011ProposalPublication({
        path,
        expectedProposalId: proposalId,
        produce: async () => proposalBytes(proposalId),
        afterDurablePublish: () => {
          callbackCalls += 1
        },
      }),
    ).rejects.toMatchObject({ code: 'ELOOP' })
    expect(callbackCalls).toBe(0)
  })

  it('rejects a reused outcome symlink before reconciliation', async () => {
    const outside = join(root!, 'outside-outcome.json')
    const path = join(root!, 'outcome-link.json')
    const input = {
      proposalDigest: digest('1'),
      hypothesis: 'the child should improve the target task',
      candidateDigest: digest('2'),
      targetClusterSlug: 'target-cluster',
      targetTaskHandle: 'task-a',
      trials: [
        {
          ref: digest('3'),
          role: 'target-baseline' as const,
          status: 'fail' as const,
          reward: 0 as const,
          taskId: 'task-a',
          attemptIndex: 0,
        },
        {
          ref: digest('4'),
          role: 'target-child' as const,
          status: 'pass' as const,
          reward: 1 as const,
          taskId: 'task-a',
          attemptIndex: 0,
        },
      ],
    }
    await recoverV011OutcomeDerivation({ path: outside, ...input })
    await symlink(outside, path)
    let callbackCalls = 0

    await expect(
      recoverV011OutcomeDerivation({
        path,
        ...input,
        afterDurablePublish: () => {
          callbackCalls += 1
        },
      }),
    ).rejects.toMatchObject({ code: 'ELOOP' })
    expect(callbackCalls).toBe(0)
  })
})
