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
} from '@dsh-self-evolving/candidate-sdk'
import { publishBytes, type ObjectRef, type ObjectStore } from '../object-store/index.js'
import { verifyExport, type ExportManifest } from './export.js'
import { resolveV011Citations, type ResolvedCitation } from './v011-citations.js'

export interface FailureCluster {
  slug: string
  mechanism: string
  citations: EvidenceCitation[]
}

export interface V011Analysis {
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

export interface CandidateIntent {
  schemaVersion: 2
  proposal: { hypothesis: string }
  runtime: { requiredServices: string[]; optionalServices: string[]; newToolNames: string[] }
}

export interface V011ParentEvidenceBinding {
  schemaVersion: 1
  parentCandidateDigest: `sha256:${string}`
  parentEvaluationActionId: string
  parentExternalJobId: string
  analysisDigest: `sha256:${string}`
  mechanismOutcomeDigest: `sha256:${string}`
  normalizedTrialDigest: `sha256:${string}`
  trajectoryDigest: `sha256:${string}`
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
  proposerResourceReceiptDigest: `sha256:${string}`
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

export function assertV011AutonomousChildShape(operations: TreeOperation[]): void {
  if (!operations.some((row) => row.op === 'modify' && row.path === 'src/index.ts')) {
    throw new Error('v0.1.1 materializer: child must modify src/index.ts')
  }
  if (
    !operations.some(
      (row) => row.op === 'add' && row.path.startsWith('src/') && row.path.endsWith('.ts'),
    )
  ) {
    throw new Error('v0.1.1 materializer: child must add a production module under src/**')
  }
  if (
    !operations.some(
      (row) => row.op === 'add' && row.path.startsWith('tests/') && row.path.endsWith('.spec.ts'),
    )
  ) {
    throw new Error('v0.1.1 materializer: child must add a candidate-owned tests/**/*.spec.ts')
  }
}

/**
 * Collapse only byte-identical duplicate citation claims. Two claims that name
 * the same immutable object location but disagree about media type,
 * observation, or any other field are contradictory evidence and must fail
 * closed instead of depending on input order.
 */
export function deduplicateEvidenceCitations(rows: EvidenceCitation[]): EvidenceCitation[] {
  const byLocation = new Map<string, EvidenceCitation>()
  for (const row of rows) {
    const key = `${row.objectDigest}:${canonicalV011(row.locator)}`
    const existing = byLocation.get(key)
    if (existing === undefined) {
      byLocation.set(key, row)
      continue
    }
    if (canonicalV011(existing) !== canonicalV011(row)) {
      throw new Error(`v0.1.1 materializer: conflicting evidence citation at ${key}`)
    }
  }
  return [...byLocation.values()]
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

export function assertExactParentEvidenceGrounding(
  analysis: V011Analysis,
  required: V011ParentEvidenceBinding,
): void {
  const selected = analysis.failureClusters.find(
    (cluster) => cluster.slug === analysis.selectedCluster,
  )
  if (selected === undefined) throw new Error('v0.1.1 analysis: selected cluster does not exist')
  const hasCitation = (digest: string, media: RegExp): boolean =>
    selected.citations.some(
      (citation) => citation.objectDigest === digest && media.test(citation.mediaType),
    )
  if (!hasCitation(required.trajectoryDigest, /atif|trajectory/i)) {
    throw new Error('v0.1.1 analysis: selected cluster lacks exact parent trajectory citation')
  }
  if (!hasCitation(required.normalizedTrialDigest, /normalized|trial-record/i)) {
    throw new Error('v0.1.1 analysis: selected cluster lacks exact parent normalized citation')
  }
  const reconciliation = analysis.ancestorReconciliations.find(
    (row) => row.clusterSlug === analysis.selectedCluster,
  )
  if (reconciliation?.analysisCitation.objectDigest !== required.analysisDigest) {
    throw new Error('v0.1.1 analysis: selected cluster lacks exact parent analysis citation')
  }
  if (reconciliation.outcomeCitation.objectDigest !== required.mechanismOutcomeDigest) {
    throw new Error(
      'v0.1.1 analysis: selected cluster lacks exact parent mechanism-outcome citation',
    )
  }
}

export async function validateV011ProposalSemantics(input: {
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
  proposal: V011Proposal
  analysis: V011Analysis
  candidateIntent: CandidateIntent
  ancestorClustersRequiringReconciliation?: string[]
  requiredParentEvidence?: V011ParentEvidenceBinding
}): Promise<{ operations: TreeOperation[]; resolvedCitations: ResolvedCitation[] }> {
  if (!verifyExport(input.exportManifest))
    throw new Error('v0.1.1 materializer: invalid export Merkle root')
  const actualExportDigest = digestV011(canonicalV011(input.exportManifest))
  if (actualExportDigest !== input.expected.exportManifestDigest) {
    throw new Error('v0.1.1 materializer: export manifest digest mismatch')
  }
  if (input.exportManifest.merkleRoot !== input.expected.exportMerkleRoot) {
    throw new Error('v0.1.1 materializer: export Merkle binding mismatch')
  }
  if (
    input.proposal.proposalId !== input.expected.proposalId ||
    input.proposal.canonicalParentDigest !== input.expected.parentDigest ||
    input.proposal.evidenceExport.manifestDigest !== input.expected.exportManifestDigest ||
    input.proposal.evidenceExport.merkleRoot !== input.expected.exportMerkleRoot ||
    input.proposal.analysisPath !== 'analysis.json'
  ) {
    throw new Error('v0.1.1 materializer: proposal does not match durable reservation')
  }
  if (
    input.proposal.hypothesis !== input.analysis.falsifiableHypothesis ||
    input.proposal.hypothesis !== input.candidateIntent.proposal.hypothesis
  ) {
    throw new Error(
      'v0.1.1 materializer: hypothesis differs across proposal, analysis, and candidate intent',
    )
  }
  assertTrajectoryGrounding(input.analysis)
  if (input.requiredParentEvidence !== undefined) {
    assertExactParentEvidenceGrounding(input.analysis, input.requiredParentEvidence)
  }
  for (const cluster of new Set(input.ancestorClustersRequiringReconciliation ?? [])) {
    if (!input.analysis.ancestorReconciliations.some((row) => row.clusterSlug === cluster)) {
      throw new Error(`v0.1.1 analysis: missing ancestor reconciliation for ${cluster}`)
    }
  }
  assertRuntimeIntentAgainstCatalog(input.candidateIntent.runtime, input.capabilityCatalog)
  const parent = await snapshotV011Tree(input.parentRoot)
  const child = await snapshotV011Tree(input.childRoot)
  const parentArchive = await canonicalizeV011Tree(parent)
  if (`sha256:${parentArchive.hash}` !== input.expected.parentDigest) {
    throw new Error('v0.1.1 materializer: canonical parent bytes do not match reservation')
  }
  const diff = await deriveV011Operations(parent, child)
  assertDeclaredOperations(diff.operations, input.proposal.declaredOperations)
  assertV011AutonomousChildShape(diff.operations)
  const citations = deduplicateEvidenceCitations([
    ...input.proposal.evidenceCitations,
    ...input.analysis.failureClusters.flatMap((cluster) => cluster.citations),
    ...input.analysis.ancestorReconciliations.flatMap((row) => [
      row.analysisCitation,
      row.outcomeCitation,
    ]),
    ...input.proposal.capabilityRequests.flatMap((request) => request.evidenceCitations),
  ])
  const resolvedCitations = await resolveV011Citations({
    citations,
    exportManifest: input.exportManifest,
    exportRoot: input.exportRoot,
  })
  return { operations: diff.operations, resolvedCitations }
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
  proposerResourceReceiptDigest: `sha256:${string}`
  proposerUsage: Record<string, unknown>
  ancestorClustersRequiringReconciliation?: string[]
  requiredParentEvidence?: V011ParentEvidenceBinding
}): Promise<V011MaterializationOutput> {
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
  const semantic = await validateV011ProposalSemantics({
    parentRoot: input.parentRoot,
    childRoot: input.childRoot,
    exportRoot: input.exportRoot,
    exportManifest: input.exportManifest,
    expected: input.expected,
    capabilityCatalog: input.capabilityCatalog,
    proposal,
    analysis,
    candidateIntent,
    ...(input.ancestorClustersRequiringReconciliation === undefined
      ? {}
      : {
          ancestorClustersRequiringReconciliation: input.ancestorClustersRequiringReconciliation,
        }),
    ...(input.requiredParentEvidence === undefined
      ? {}
      : { requiredParentEvidence: input.requiredParentEvidence }),
  })
  const child = await snapshotV011Tree(input.childRoot)
  const archive = await canonicalizeV011Tree(child)
  const [sourceRef, analysisRef, proposalRef] = await Promise.all([
    publishBytes(
      input.store,
      archive.bytes,
      'application/vnd.dsh-self-evolving.candidate-source+tar',
      'DEV_OBSERVED',
    ),
    publishBytes(
      input.store,
      analysisBytes,
      'application/vnd.dsh-self-evolving.analysis+json',
      'DEV_OBSERVED',
    ),
    publishBytes(
      input.store,
      proposalBytes,
      'application/vnd.dsh-self-evolving.proposal+json',
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
    proposerResourceReceiptDigest: input.proposerResourceReceiptDigest,
    operations: semantic.operations,
    capabilityCatalogDigest: input.capabilityCatalog.digest,
    retainedCapabilityRequests: proposal.capabilityRequests,
    proposerUsage: input.proposerUsage,
  }
  await assertV011('materialization-receipt', receipt)
  const receiptRef = await publishBytes(
    input.store,
    Buffer.from(canonicalV011(receipt)),
    'application/vnd.dsh-self-evolving.materialization-receipt+json',
    'DEV_OBSERVED',
  )
  return {
    receipt,
    receiptRef,
    sourceRef,
    analysisRef,
    proposalRef,
    resolvedCitations: semantic.resolvedCitations,
  }
}
