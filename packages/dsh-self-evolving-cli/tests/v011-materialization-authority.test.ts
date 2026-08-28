import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonicalV011 } from '@dsh-self-evolving/candidate-sdk'
import {
  publishBytes,
  type ObjectStore,
  type V011MaterializationReceipt,
} from '@dsh-self-evolving/core'
import { verifyV011MaterializationAuthority } from '../src/v011-materialization-authority.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'v011-materialization-authority-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const digest = (character: string) => `sha256:${character.repeat(64)}` as `sha256:${string}`

async function fixture() {
  const store: ObjectStore = { root: join(root!, 'store') }
  const action = join(root!, 'action')
  const proposalId = `p_${'1'.repeat(32)}`
  const slot = join(action, 'children', proposalId)
  await mkdir(slot, { recursive: true })
  const hypothesis = 'A bounded retry completes after one transient tool failure.'
  const citation = (character: string, mediaType: string) => ({
    objectDigest: digest(character),
    mediaType,
    locator: { kind: 'json-pointer', value: '/status' },
    observation: 'The trusted observed record contains the selected failure.',
  })
  const analysis = {
    schemaVersion: 1,
    failureClusters: [
      {
        slug: 'transient-tool-stop',
        mechanism: 'The agent stops after one transient tool failure.',
        citations: [
          citation('2', 'application/vnd.dsh-self-evolving.atif+json'),
          citation('3', 'application/vnd.dsh-self-evolving.normalized-trial-record+json'),
        ],
      },
    ],
    ancestorReconciliations: [],
    selectedCluster: 'transient-tool-stop',
    falsifiableHypothesis: hypothesis,
    expectedBehaviorChange: 'Retry once.',
    preservationRequirements: ['Do not retry successful calls.'],
    regressionRisks: ['A duplicate tool call.'],
  }
  const analysisBytes = Buffer.from(`${JSON.stringify(analysis)}\n`)
  await writeFile(join(slot, 'analysis.json'), analysisBytes)
  const analysisRef = await publishBytes(
    store,
    analysisBytes,
    'application/vnd.dsh-self-evolving.analysis+json',
    'DEV_OBSERVED',
  )
  const operations = [{ op: 'modify' as const, path: 'src/index.ts' }]
  const materialization: V011MaterializationReceipt = {
    schemaVersion: 1,
    proposalId,
    parentDigest: digest('4'),
    sourceDigest: digest('5'),
    exportManifestDigest: digest('6'),
    analysisDigest: `sha256:${analysisRef.digest}`,
    proposalDigest: digest('7'),
    transcriptDigest: digest('8'),
    toolTraceDigest: digest('9'),
    proposerResourceReceiptDigest: digest('a'),
    operations,
    capabilityCatalogDigest: digest('b'),
    retainedCapabilityRequests: [],
    proposerUsage: { gatewayReceipts: 1 },
  }
  const materializationRef = await publishBytes(
    store,
    Buffer.from(canonicalV011(materialization)),
    'application/vnd.dsh-self-evolving.materialization-receipt+json',
    'DEV_OBSERVED',
  )
  const value = {
    stableProposal: {
      proposalId,
      parentCandidateId: materialization.parentDigest,
      hypothesis,
      sourceDiff: JSON.stringify({ slot, operations }),
      evidenceRefs: [`object:sha256:${analysisRef.digest}`],
      artifactDigest: `sha256:${materializationRef.digest}`,
    },
    materialization,
  }
  return { store, action, value, materializationRef }
}

describe('v0.1.1 materialization authority', () => {
  it('cross-checks the exact wrapper, stable proposal, resource-bound receipt digest and CAS bytes', async () => {
    const input = await fixture()
    await expect(
      verifyV011MaterializationAuthority({
        store: input.store,
        value: input.value,
        actionRoot: input.action,
      }),
    ).resolves.toMatchObject({ stableProposal: input.value.stableProposal })

    await expect(
      verifyV011MaterializationAuthority({
        store: input.store,
        value: {
          ...input.value,
          stableProposal: { ...input.value.stableProposal, artifactDigest: digest('c') },
        },
        actionRoot: input.action,
      }),
    ).rejects.toThrow(/stable proposal binding/)
    await expect(
      verifyV011MaterializationAuthority({
        store: input.store,
        value: { ...input.value, unexpected: true },
        actionRoot: input.action,
      }),
    ).rejects.toThrow(/invalid wrapper/)
  })

  it('rejects a materialization object whose CAS bytes were changed', async () => {
    const input = await fixture()
    const objectPath = join(
      input.store.root,
      'objects',
      'sha256',
      input.materializationRef.digest.slice(0, 2),
      input.materializationRef.digest,
    )
    await writeFile(objectPath, 'tampered')
    await expect(
      verifyV011MaterializationAuthority({
        store: input.store,
        value: input.value,
        actionRoot: input.action,
      }),
    ).rejects.toThrow(/EVIDENCE_CORRUPT|size mismatch|bytes mismatch/)
  })
})
