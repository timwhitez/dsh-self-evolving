import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalV011,
  canonicalizeV011Tree,
  digestV011,
  freezeCapabilityCatalog,
  materializeV011ChildSlot,
  reserveProposalId,
  snapshotV011Tree,
  V011_PROTOCOL,
  type EvidenceCitation,
} from '@dsh-rsi/candidate-sdk'
import {
  aggregateCapabilityRequests,
  assertCapabilityRequestsDoNotWidenCurrentLineage,
  buildExport,
  deriveMechanismOutcome,
  materializeProposerExport,
  materializeV011Proposal,
  publishBytes,
  publishMechanismOutcomeOnce,
  type ObjectStore,
} from '../src/index.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function parentFixture(root: string): Promise<string> {
  const parent = join(root, 'parent')
  await mkdir(join(parent, 'src'), { recursive: true })
  await mkdir(join(parent, 'tests'), { recursive: true })
  await Promise.all([
    writeFile(join(parent, 'src/index.ts'), "export const prompt = 'baseline'\n"),
    writeFile(join(parent, 'tests/base.spec.ts'), 'export const baseline = true\n'),
    writeFile(join(parent, 'package.json'), '{"name":"trusted-template"}\n'),
    writeFile(join(parent, 'cordis.patch.yml'), '- insert: []\n'),
    writeFile(join(parent, 'tsconfig.json'), '{}\n'),
    writeFile(
      join(parent, 'candidate.json'),
      JSON.stringify({
        schemaVersion: 2,
        proposal: {
          hypothesis: 'The migrated baseline preserves predecessor behavior exactly.',
          targetFailureModes: ['none'],
          expectedBehaviorChange: 'None.',
          regressionRisks: ['migration mismatch'],
          touchedSurfaces: ['systemPrompt'],
        },
        runtime: {
          requiredServices: ['systemPrompt'],
          optionalServices: [],
          newToolNames: [],
          supportsModes: ['solve', 'propose'],
        },
        tests: { mechanismAssertions: ['boots'], preservationAssertions: ['unloads'] },
      }) + '\n',
    ),
  ])
  return parent
}

describe('v0.1.1 materializer, citations, outcomes, and ledger', () => {
  it('binds a legal export to exact multi-file output and resolves spans', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rsi-v011-materializer-'))
    roots.push(root)
    const store: ObjectStore = { root: join(root, 'store') }
    const atif = await publishBytes(
      store,
      Buffer.from(JSON.stringify({ events: [{ type: 'tool', error: 'transient' }] })),
      'application/vnd.dsh-rsi.atif+json',
      'DEV_OBSERVED',
    )
    const normalized = await publishBytes(
      store,
      Buffer.from(JSON.stringify({ status: 'fail', reward: 0 })),
      'application/vnd.dsh-rsi.normalized-trial-record+json',
      'DEV_OBSERVED',
    )
    const sealed = await publishBytes(
      store,
      Buffer.from('{"canary":"never-export"}'),
      'application/json',
      'SEALED',
    )
    const exportRoot = join(root, 'export')
    const manifest = await materializeProposerExport({
      store,
      outDir: exportRoot,
      exportId: 'v011-export-1',
      principal: 'proposer:action-1',
      objects: [atif, normalized, sealed],
      createdFromStateHash: `sha256:${'1'.repeat(64)}`,
    })
    expect(manifest.objects).toHaveLength(2)
    const exportDigest = digestV011(canonicalV011(manifest))
    const parent = await parentFixture(root)
    const parentDigest =
      `sha256:${(await canonicalizeV011Tree(await snapshotV011Tree(parent))).hash}` as const
    const slot = join(root, 'slot')
    const child = join(slot, 'tree')
    await materializeV011ChildSlot(parent, child)
    await mkdir(join(child, 'src', 'retry'), { recursive: true })
    await writeFile(join(child, 'src/retry/bounded.ts'), 'export const retryLimit = 1\n')
    await writeFile(
      join(child, 'src/index.ts'),
      "export { retryLimit } from './retry/bounded.js'\n",
    )
    const hypothesis = 'One bounded retry after a transient tool failure reaches finalization.'
    const candidate = JSON.parse(await readFile(join(child, 'candidate.json'), 'utf8')) as Record<
      string,
      unknown
    >
    ;(candidate['proposal'] as Record<string, unknown>)['hypothesis'] = hypothesis
    ;(candidate['proposal'] as Record<string, unknown>)['expectedBehaviorChange'] =
      'Retry once after a transient tool failure.'
    await writeFile(join(child, 'candidate.json'), JSON.stringify(candidate) + '\n')
    const atifCitation: EvidenceCitation = {
      objectDigest: `sha256:${atif.digest}`,
      mediaType: atif.mediaType,
      locator: { kind: 'json-pointer', value: '/events/0' },
      observation: 'The tool returned one transient error.',
    }
    const normalizedCitation: EvidenceCitation = {
      objectDigest: `sha256:${normalized.digest}`,
      mediaType: normalized.mediaType,
      locator: { kind: 'json-pointer', value: '/status' },
      observation: 'The baseline trial failed.',
    }
    const catalog = await freezeCapabilityCatalog({
      schemaVersion: 1,
      protocol: V011_PROTOCOL,
      dshCommit: '4'.repeat(40),
      capabilities: [
        {
          id: 'systemPrompt',
          tier: 'T0',
          kind: 'service',
          signature: 'section',
          enabled: true,
          fixtureDigest: `sha256:${'5'.repeat(64)}`,
        },
      ],
    })
    const proposalId = reserveProposalId({
      runId: 'v011-run',
      generation: 1,
      attempt: 1,
      parentDigest,
      exportManifestDigest: exportDigest,
      capabilityCatalogDigest: catalog.digest,
    })
    const analysis = {
      schemaVersion: 1,
      failureClusters: [
        {
          slug: 'transient-tool-stop',
          mechanism: 'The agent stops after a transient tool error.',
          citations: [atifCitation, normalizedCitation],
        },
      ],
      ancestorReconciliations: [],
      selectedCluster: 'transient-tool-stop',
      falsifiableHypothesis: hypothesis,
      expectedBehaviorChange: 'Retry once.',
      preservationRequirements: ['Do not retry successful calls.'],
      regressionRisks: ['A duplicate tool call.'],
    }
    const request = {
      capability: 'tools/pre-execute',
      tier: 'T2' as const,
      motivation: 'Prevent duplicate dispatch.',
      evidenceCitations: [atifCitation],
    }
    const proposal = {
      schemaVersion: 2,
      proposalId,
      canonicalParentDigest: parentDigest,
      evidenceExport: { manifestDigest: exportDigest, merkleRoot: manifest.merkleRoot },
      donorCandidates: [],
      analysisPath: 'analysis.json',
      hypothesis,
      evidenceCitations: [atifCitation, normalizedCitation],
      declaredOperations: [
        { op: 'modify', path: 'candidate.json' },
        { op: 'modify', path: 'src/index.ts' },
        { op: 'add', path: 'src/retry/bounded.ts' },
      ],
      mechanismAssertions: ['One retry maximum.'],
      preservationAssertions: ['Success is not retried.'],
      capabilityRequests: [request],
    }
    await Promise.all([
      writeFile(join(slot, 'analysis.json'), JSON.stringify(analysis) + '\n'),
      writeFile(join(slot, 'proposal.json'), JSON.stringify(proposal) + '\n'),
    ])
    const output = await materializeV011Proposal({
      store,
      parentRoot: parent,
      childRoot: child,
      exportRoot,
      exportManifest: manifest,
      expected: {
        proposalId,
        parentDigest,
        exportManifestDigest: exportDigest,
        exportMerkleRoot: manifest.merkleRoot,
      },
      capabilityCatalog: catalog,
      transcript: Buffer.from('assistant transcript'),
      toolTrace: Buffer.from('[{"tool":"read"}]'),
      proposerUsage: { inputTokens: 100, outputTokens: 20 },
    })
    expect(output.receipt.operations).toEqual(proposal.declaredOperations)
    expect(output.resolvedCitations).toHaveLength(2)
    expect(output.receipt.retainedCapabilityRequests).toEqual([request])

    const ledger = aggregateCapabilityRequests({
      currentCatalog: catalog,
      proposals: [{ proposalDigest: output.receipt.proposalDigest, requests: [request] }],
    })
    expect(ledger.entries[0]).toMatchObject({
      capability: 'tools/pre-execute',
      count: 1,
      disposition: 'PENDING',
    })
    expect(() =>
      assertCapabilityRequestsDoNotWidenCurrentLineage({
        before: catalog,
        afterRequestProcessing: catalog,
      }),
    ).not.toThrow()
  })

  it('derives and publishes one outcome exactly once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rsi-v011-outcome-'))
    roots.push(root)
    const record = await deriveMechanismOutcome({
      proposalDigest: `sha256:${'1'.repeat(64)}`,
      hypothesis: 'A bounded retry changes the observed target outcome.',
      candidateDigest: `sha256:${'2'.repeat(64)}`,
      targetClusterSlug: 'transient-tool-stop',
      targetTaskHandle: 'opaque-observed-1',
      trials: [
        { ref: `sha256:${'3'.repeat(64)}`, role: 'target-baseline', status: 'fail', reward: 0 },
        { ref: `sha256:${'4'.repeat(64)}`, role: 'target-child', status: 'pass', reward: 1 },
      ],
    })
    expect(record.status).toBe('TARGET_IMPROVED')
    const path = join(root, 'outcomes', 'one.json')
    await expect(publishMechanismOutcomeOnce(path, record)).resolves.toBe('CREATED')
    await expect(publishMechanismOutcomeOnce(path, record)).resolves.toBe('REUSED')
    await expect(
      publishMechanismOutcomeOnce(path, { ...record, status: 'TARGET_UNCHANGED' }),
    ).rejects.toThrow(/conflicting exactly-once/)
  })

  it('rejects citations to excluded sealed objects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rsi-v011-citation-'))
    roots.push(root)
    const store: ObjectStore = { root: join(root, 'store') }
    const sealed = await publishBytes(store, Buffer.from('{}'), 'application/json', 'SEALED')
    const manifest = buildExport({
      exportId: 'empty',
      principal: 'proposer:test',
      purpose: 'candidate-expansion',
      allowedLabels: ['PUBLIC_SPEC', 'DEV_OBSERVED'],
      objects: [sealed],
      createdFromStateHash: null,
    })
    expect(manifest.objects).toEqual([])
  })
})
