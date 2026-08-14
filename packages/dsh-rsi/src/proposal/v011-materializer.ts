import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assertDeclaredOperations,
  assertRuntimeIntentAgainstCatalog,
  assertV011,
  canonicalizeV011Tree,
  canonicalV011,
  deriveV011Operations,
  digestV011,
  snapshotV011Tree,
  type CapabilityRequest,
  type EvidenceCitation,
  type FrozenCapabilityCatalog,
  type TreeOperation,
  type V011Proposal,
} from '@dsh-rsi/candidate-sdk'
import { publishBytes, type ObjectRef, type ObjectStore } from '../object-store/index.js'
import { verifyExport, type ExportManifest } from './export.js'
import { resolveV011Citations, type ResolvedCitation } from './v011-citations.js'

interface FailureCluster {
  slug: string
  mechanism: string
  citations: EvidenceCitation[]
}

interface V011Analysis {
  schemaVersion: 1
  failureClusters: FailureCluster[]
  ancestorReconciliations: Array<{
    clusterSlug: string
    analysisCitation: EvidenceCitation
    outcomeCitation: EvidenceCitation
    position: 'CONFIRMED_INSUFFICIENT' | 'SUPERSEDED' | 'DISTINCT_RETRY'
  }>
  selectedCluster: string
  falsifiableHypothesis: string
  expectedBehaviorChange: string
  preservationRequirements: string[]
  regressionRisks: string[]
}

interface CandidateIntent {
  schemaVersion: 2
  proposal: { hypothesis: string }
  runtime: { requiredServices: string[]; optionalServices: string[]; newToolNames: string[] }
}

export interface V011MaterializationReceipt {
  schemaVersion: 1
  proposalId: string
  parentDigest: `sha256:${string}`
  sourceDigest: `sha256:${string}`
  exportManifestDigest: `sha256:${string}`
  analysisDigest: `sha256:${string}`
  proposalDigest: `sha256:${string}`
  transcriptDigest: `sha256:${string}`
  toolTraceDigest: `sha256:${string}`
  operations: TreeOperation[]
  capabilityCatalogDigest: `sha256:${string}`
  retainedCapabilityRequests: CapabilityRequest[]
  proposerUsage: Record<string, unknown>
}

export interface V011MaterializationOutput {
  receipt: V011MaterializationReceipt
  receiptRef: ObjectRef
  sourceRef: ObjectRef
  analysisRef: ObjectRef
  proposalRef: ObjectRef
  resolvedCitations: ResolvedCitation[]
}

function uniqueCitations(rows: EvidenceCitation[]): EvidenceCitation[] {
  const byKey = new Map(
    rows.map((row) => [`${row.objectDigest}:${JSON.stringify(row.locator)}`, row]),
  )
  return [...byKey.values()]
}

function assertTrajectoryGrounding(analysis: V011Analysis): void {
  const selected = analysis.failureClusters.find(
    (cluster) => cluster.slug === analysis.selectedCluster,
  )
  if (selected === undefined) throw new Error('v0.1.1 analysis: selected cluster does not exist')
  for (const cluster of analysis.failureClusters) {
    const media = cluster.citations.map((citation) => citation.mediaType)
    if (!media.some((value) => /atif|trajectory/i.test(value))) {
      throw new Error(`v0.1.1 analysis: cluster ${cluster.slug} lacks a trajectory citation`)
    }
    if (!media.some((value) => /normalized|trial-record/i.test(value))) {
      throw new Error(
        `v0.1.1 analysis: cluster ${cluster.slug} lacks a normalized outcome citation`,
      )
    }
  }
}

export async function materializeV011Proposal(input: {
  store: ObjectStore
  parentRoot: string
  childRoot: string
  exportRoot: string
  exportManifest: ExportManifest
  expected: {
    proposalId: string
    parentDigest: `sha256:${string}`
    exportManifestDigest: `sha256:${string}`
    exportMerkleRoot: `sha256:${string}`
  }
  capabilityCatalog: FrozenCapabilityCatalog
  transcript: Uint8Array
  toolTrace: Uint8Array
  proposerUsage: Record<string, unknown>
  ancestorClustersRequiringReconciliation?: string[]
}): Promise<V011MaterializationOutput> {
  if (!verifyExport(input.exportManifest))
    throw new Error('v0.1.1 materializer: invalid export Merkle root')
  const actualExportDigest = digestV011(canonicalV011(input.exportManifest))
  if (actualExportDigest !== input.expected.exportManifestDigest) {
    throw new Error('v0.1.1 materializer: export manifest digest mismatch')
  }
  if (input.exportManifest.merkleRoot !== input.expected.exportMerkleRoot) {
    throw new Error('v0.1.1 materializer: export Merkle binding mismatch')
  }
  const proposalBytes = await readFile(join(input.childRoot, '..', 'proposal.json'))
  const analysisBytes = await readFile(join(input.childRoot, '..', 'analysis.json'))
  const proposal = JSON.parse(proposalBytes.toString('utf8')) as V011Proposal
  const analysis = JSON.parse(analysisBytes.toString('utf8')) as V011Analysis
  const candidateIntent = JSON.parse(
    await readFile(join(input.childRoot, 'candidate.json'), 'utf8'),
  ) as CandidateIntent
  await Promise.all([
    assertV011('proposal', proposal),
    assertV011('analysis', analysis),
    assertV011('candidate-intent', candidateIntent),
  ])
  if (
    proposal.proposalId !== input.expected.proposalId ||
    proposal.canonicalParentDigest !== input.expected.parentDigest ||
    proposal.evidenceExport.manifestDigest !== input.expected.exportManifestDigest ||
    proposal.evidenceExport.merkleRoot !== input.expected.exportMerkleRoot ||
    proposal.analysisPath !== 'analysis.json'
  ) {
    throw new Error('v0.1.1 materializer: proposal does not match durable reservation')
  }
  if (
    proposal.hypothesis !== analysis.falsifiableHypothesis ||
    proposal.hypothesis !== candidateIntent.proposal.hypothesis
  ) {
    throw new Error(
      'v0.1.1 materializer: hypothesis differs across proposal, analysis, and candidate intent',
    )
  }
  assertTrajectoryGrounding(analysis)
  for (const cluster of new Set(input.ancestorClustersRequiringReconciliation ?? [])) {
    if (!analysis.ancestorReconciliations.some((row) => row.clusterSlug === cluster)) {
      throw new Error(`v0.1.1 analysis: missing ancestor reconciliation for ${cluster}`)
    }
  }
  assertRuntimeIntentAgainstCatalog(candidateIntent.runtime, input.capabilityCatalog)
  const parent = await snapshotV011Tree(input.parentRoot)
  const child = await snapshotV011Tree(input.childRoot)
  const parentArchive = await canonicalizeV011Tree(parent)
  if (`sha256:${parentArchive.hash}` !== input.expected.parentDigest) {
    throw new Error('v0.1.1 materializer: canonical parent bytes do not match reservation')
  }
  const diff = await deriveV011Operations(parent, child)
  assertDeclaredOperations(diff.operations, proposal.declaredOperations)
  const archive = await canonicalizeV011Tree(child)
  const citations = uniqueCitations([
    ...proposal.evidenceCitations,
    ...analysis.failureClusters.flatMap((cluster) => cluster.citations),
    ...analysis.ancestorReconciliations.flatMap((row) => [
      row.analysisCitation,
      row.outcomeCitation,
    ]),
    ...proposal.capabilityRequests.flatMap((request) => request.evidenceCitations),
  ])
  const resolvedCitations = await resolveV011Citations({
    citations,
    exportManifest: input.exportManifest,
    exportRoot: input.exportRoot,
  })
  const [sourceRef, analysisRef, proposalRef] = await Promise.all([
    publishBytes(
      input.store,
      archive.bytes,
      'application/vnd.dsh-rsi.candidate-source+tar',
      'DEV_OBSERVED',
    ),
    publishBytes(
      input.store,
      analysisBytes,
      'application/vnd.dsh-rsi.analysis+json',
      'DEV_OBSERVED',
    ),
    publishBytes(
      input.store,
      proposalBytes,
      'application/vnd.dsh-rsi.proposal+json',
      'DEV_OBSERVED',
    ),
  ])
  const receipt: V011MaterializationReceipt = {
    schemaVersion: 1,
    proposalId: proposal.proposalId,
    parentDigest: input.expected.parentDigest,
    sourceDigest: `sha256:${archive.hash}`,
    exportManifestDigest: input.expected.exportManifestDigest,
    analysisDigest: `sha256:${analysisRef.digest}`,
    proposalDigest: `sha256:${proposalRef.digest}`,
    transcriptDigest: digestV011(input.transcript),
    toolTraceDigest: digestV011(input.toolTrace),
    operations: diff.operations,
    capabilityCatalogDigest: input.capabilityCatalog.digest,
    retainedCapabilityRequests: proposal.capabilityRequests,
    proposerUsage: input.proposerUsage,
  }
  await assertV011('materialization-receipt', receipt)
  const receiptRef = await publishBytes(
    input.store,
    Buffer.from(canonicalV011(receipt)),
    'application/vnd.dsh-rsi.materialization-receipt+json',
    'DEV_OBSERVED',
  )
  return { receipt, receiptRef, sourceRef, analysisRef, proposalRef, resolvedCitations }
}
