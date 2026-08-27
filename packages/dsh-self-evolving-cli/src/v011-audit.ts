import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assertExactParentEvidenceGrounding,
  readControllerStatus,
  type V011Analysis,
  type V011ParentEvidenceBinding,
} from '@dsh-self-evolving/core'
import { assertV011, digestV011, v011SchemaDigest } from '@dsh-self-evolving/candidate-sdk'
import { auditStableRun } from './audit.js'
import type { V011DemoConfig } from './config.js'

export interface V011AuditReport {
  accepted: boolean
  status: 'AUTONOMOUS_PLUGIN_DEVELOPMENT_VERIFIED' | 'IN_PROGRESS' | 'REJECTED'
  reasons: string[]
  stateHash: string
  eventCount: number
  claimBoundary: {
    sealedAccessCount: 0 | number
    benchmarkImprovementClaimed: false
  }
}

async function json(path: string): Promise<unknown | null> {
  return readFile(path, 'utf8')
    .then((raw) => JSON.parse(raw) as unknown)
    .catch(() => null)
}

function sha(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

async function files(root: string): Promise<string[]> {
  const output: string[] = []
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) output.push(path)
    }
  }
  if ((await stat(root).catch(() => null))?.isDirectory()) await walk(root)
  return output.sort()
}

export interface FixtureCrossBinding {
  /** Parent digest from the baseline receipt (fallback: action materialization). */
  parentDigest?: string | undefined
  /** Reserved proposalId from the successor action's materialization receipt. */
  proposalId?: string | undefined
}

export async function verifyInvalidReplacementFixture(
  config: V011DemoConfig,
  cross: FixtureCrossBinding = {},
): Promise<string[]> {
  const reasons: string[] = [] // The invalid-replacement fixture must be a REAL reproducible negative
  // action: the audit replays the retained fixture through the same
  // validator and cross-checks every digest binding (issue #113). A
  // pre-created two-field file cannot satisfy this.
  const fixtureAction = join(config.stateDir, 'v011', 'actions', 'proposal-1-1')
  const rejection = (await json(join(fixtureAction, 'rejection.json'))) as {
    schemaVersion?: unknown
    classification?: unknown
    validator?: unknown
    fixtureProposalDigest?: unknown
    fixtureAnalysisDigest?: unknown
    analysisSchemaDigest?: unknown
    reasonDigest?: unknown
    binding?: unknown
    retained?: unknown
    replacedBy?: unknown
  } | null
  if (rejection === null) {
    reasons.push('deterministic invalid-child replacement fixture missing')
  } else {
    const proposalBytes = await readFile(
      join(fixtureAction, 'invalid-fixture-proposal.json'),
      'utf8',
    ).catch(() => null)
    const analysisBytes = await readFile(
      join(fixtureAction, 'invalid-fixture-analysis.json'),
      'utf8',
    ).catch(() => null)
    if (proposalBytes === null || analysisBytes === null) {
      reasons.push('invalid-replacement fixture artifacts are not retained')
    } else {
      const binding =
        typeof rejection.binding === 'object' && rejection.binding !== null
          ? (rejection.binding as Record<string, unknown>)
          : null
      const replayable =
        rejection.schemaVersion === 2 &&
        rejection.classification === 'FIXTURE_VALIDATOR_REJECT' &&
        rejection.validator === 'assertV011:analysis' &&
        rejection.retained === true &&
        typeof rejection.replacedBy === 'string' &&
        rejection.replacedBy.endsWith('/proposal/1/1') &&
        binding !== null &&
        binding['runId'] === config.runId &&
        typeof cross.parentDigest === 'string' &&
        binding['parentDigest'] === cross.parentDigest &&
        (cross.proposalId === undefined || binding['proposalId'] === cross.proposalId) &&
        typeof rejection.analysisSchemaDigest === 'string' &&
        rejection.analysisSchemaDigest === (await v011SchemaDigest('analysis')) &&
        digestV011(proposalBytes) === rejection.fixtureProposalDigest &&
        digestV011(analysisBytes) === rejection.fixtureAnalysisDigest
      if (!replayable) {
        reasons.push(
          'invalid-replacement fixture record is not digest-bound (legacy/synthetic records are not auditable; for an incomplete action delete ' +
            `${join(fixtureAction, 'rejection.json')} and resume to regenerate)`,
        )
      } else {
        // Replay the rejection through the real validator.
        try {
          await assertV011('analysis', JSON.parse(analysisBytes))
          reasons.push('invalid-replacement fixture unexpectedly validates')
        } catch (error) {
          const replayed = error instanceof Error ? error.message : ''
          if (sha(replayed) !== rejection.reasonDigest) {
            reasons.push('invalid-replacement fixture reason is not reproducible')
          }
        }
      }
    }
  }
  return reasons
}

/**
 * Derive the fixture cross-binding (issues #203/#208): parentDigest from the
 * trusted baseline stable-build receipt (present even when attempt 1 failed),
 * falling back to the action's own materialization receipt; proposalId only
 * when that attempt's materialization exists.
 */
export async function deriveFixtureCross(config: V011DemoConfig): Promise<FixtureCrossBinding> {
  const baseline = (await json(
    join(config.stateDir, 'candidates', 'v011-baseline', 'stable-build.json'),
  )) as { sourceDigest?: unknown } | null
  const materialization = (await json(
    join(config.stateDir, 'v011', 'actions', 'proposal-1-1', 'materialization.json'),
  )) as { materialization?: { proposalId?: unknown; parentDigest?: unknown } } | null
  const materializationRecord = materialization?.materialization
  const cross: FixtureCrossBinding = {}
  if (typeof baseline?.sourceDigest === 'string') {
    cross.parentDigest = baseline.sourceDigest
  } else if (typeof materializationRecord?.parentDigest === 'string') {
    cross.parentDigest = materializationRecord.parentDigest
  }
  if (typeof materializationRecord?.proposalId === 'string') {
    cross.proposalId = materializationRecord.proposalId
  }
  return cross
}

export async function auditV011Run(config: V011DemoConfig): Promise<V011AuditReport> {
  const predecessor = await auditStableRun(config)
  const controller = await readControllerStatus(config as never)
  const reasons = [...predecessor.reasons]
  reasons.push(...(await verifyInvalidReplacementFixture(config, await deriveFixtureCross(config))))
  const baselineMigration = (await json(
    join(config.stateDir, 'candidates', 'v011-baseline', 'migration-receipt.json'),
  )) as { inheritedResultsPolicy?: unknown } | null
  if (baselineMigration?.inheritedResultsPolicy !== 'none') {
    reasons.push('v0.1 to v0.1.1 migration receipt missing or inherited results')
  }
  const actionFiles = (await files(join(config.stateDir, 'v011', 'actions'))).filter((path) =>
    path.endsWith('/materialization.json'),
  )
  if (actionFiles.length < 3)
    reasons.push(`materialization receipt matrix is ${actionFiles.length}/at-least-3`)
  const materializations = await Promise.all(
    actionFiles.map(async (path) => ({
      path,
      value: (await json(path)) as {
        stableProposal?: { artifactDigest?: string }
        materialization?: { proposalDigest?: string; operations?: Array<{ path?: string }> }
      } | null,
    })),
  )
  const generated = []
  for (let generation = 1; generation <= 3; generation += 1) {
    const candidateRoot = join(config.stateDir, 'candidates', `generation-${generation}`)
    const built = (await json(join(candidateRoot, 'stable-build.json'))) as {
      proposalDigest?: string
      targetClusterSlug?: string
      runtimePackageName?: string
    } | null
    const admission = (await json(join(candidateRoot, 'admission-receipt.json'))) as {
      admitted?: unknown
      stageReceipts?: unknown
    } | null
    if (
      built?.proposalDigest === undefined ||
      built.runtimePackageName === undefined ||
      admission?.admitted !== true ||
      admission.stageReceipts === undefined
    ) {
      reasons.push(`generation ${generation} admission binding incomplete`)
      continue
    }
    const materialization = materializations.find(
      (row) => row.value?.materialization?.proposalDigest === built.proposalDigest,
    )
    if (materialization === undefined) {
      reasons.push(`generation ${generation} has no matching materialization`)
      continue
    }
    const actionRoot = materialization.path.slice(0, -'/materialization.json'.length)
    const children = join(actionRoot, 'children')
    const slots = await readdir(children).catch(() => [])
    if (slots.length !== 1) {
      reasons.push(`generation ${generation} does not have one preassigned child slot`)
      continue
    }
    const slot = join(children, slots[0]!)
    const worker = (await json(join(slot, 'worker-output.json'))) as {
      parentLoader?: { mode?: unknown; entryDigest?: unknown; runtimeDigest?: unknown }
      transcript?: { toolTrace?: unknown[] }
      toolCallCount?: unknown
    } | null
    if (
      worker?.parentLoader?.mode !== 'propose' ||
      typeof worker.parentLoader.entryDigest !== 'string' ||
      typeof worker.parentLoader.runtimeDigest !== 'string' ||
      !Array.isArray(worker.transcript?.toolTrace) ||
      typeof worker.toolCallCount !== 'number' ||
      worker.toolCallCount < 4
    ) {
      reasons.push(`generation ${generation} exact-parent Loader/tool receipt invalid`)
    }
    const analysis = (await json(join(slot, 'analysis.json'))) as V011Analysis | null
    const trajectoryGrounded = analysis?.failureClusters?.every((cluster) => {
      const media = cluster.citations?.map((citation) => citation.mediaType ?? '') ?? []
      return (
        media.some((value) => /atif|trajectory/i.test(value)) &&
        media.some((value) => /normalized|trial-record/i.test(value))
      )
    })
    if (trajectoryGrounded !== true)
      reasons.push(`generation ${generation} lacks raw trajectory/outcome grounding`)
    if (generation >= 2) {
      const reconciliation = analysis?.ancestorReconciliations?.[0]
      if (
        reconciliation === undefined ||
        !/analysis/i.test(reconciliation.analysisCitation?.mediaType ?? '') ||
        !/mechanism-outcome/i.test(reconciliation.outcomeCitation?.mediaType ?? '')
      ) {
        reasons.push(`generation ${generation} lacks cumulative ancestor reconciliation`)
      }
      const binding = (await json(
        join(actionRoot, 'input', 'contracts', 'parent-evidence-binding.json'),
      )) as V011ParentEvidenceBinding | null
      const parent = (await json(
        join(config.stateDir, 'candidates', `generation-${generation - 1}`, 'stable-build.json'),
      )) as { candidateId?: unknown; analysisDigest?: unknown } | null
      const action = controller.state.actions[`eval:candidate:${generation - 1}`]
      let exact = false
      if (binding !== null && analysis !== null) {
        exact =
          binding.parentCandidateDigest === parent?.candidateId &&
          binding.analysisDigest === parent?.analysisDigest &&
          binding.parentEvaluationActionId === `eval:candidate:${generation - 1}` &&
          action?.status === 'COMMITTED' &&
          binding.parentExternalJobId === action.externalJobId
      }
      if (exact && binding !== null && analysis !== null) {
        try {
          assertExactParentEvidenceGrounding(analysis, binding)
          const outcomeBytes = await readFile(
            join(
              config.stateDir,
              'v011',
              'outcomes',
              `generation-${generation - 1}`,
              'outcome.json',
            ),
          )
          const outcome = JSON.parse(outcomeBytes.toString('utf8')) as {
            candidateDigest?: unknown
          }
          const summaryBytes = await readFile(
            join(
              config.stateDir,
              'external-evaluator',
              binding.parentExternalJobId,
              'summary.json',
            ),
          )
          const summary = JSON.parse(summaryBytes.toString('utf8')) as {
            runId?: unknown
            normalized?: Array<{ trajectoryHash?: unknown }>
          }
          exact =
            `sha256:${createHash('sha256').update(outcomeBytes).digest('hex')}` ===
              binding.mechanismOutcomeDigest &&
            outcome.candidateDigest === binding.parentCandidateDigest &&
            `sha256:${createHash('sha256').update(summaryBytes).digest('hex')}` ===
              binding.normalizedTrialDigest &&
            summary.runId === binding.parentExternalJobId &&
            `sha256:${summary.normalized?.[0]?.trajectoryHash ?? ''}` === binding.trajectoryDigest
        } catch {
          exact = false
        }
      }
      if (!exact)
        reasons.push(`generation ${generation} lacks exact parent evidence lineage binding`)
    }
    generated.push(candidateRoot)
  }
  const multiFile = await Promise.all(
    generated.map(
      async (root) =>
        (await files(join(root, 'tree', 'src'))).filter((path) => path.endsWith('.ts')).length,
    ),
  )
  if (!multiFile.some((count) => count >= 2))
    reasons.push('no admitted child contains multiple production files')
  const outcomes = (await files(join(config.stateDir, 'v011', 'outcomes'))).filter((path) =>
    path.endsWith('/outcome.json'),
  )
  if (outcomes.length !== 3) reasons.push(`mechanism-outcome record matrix is ${outcomes.length}/3`)
  const catalog = (await json(join(config.stateDir, 'v011', 'capability-catalog.json'))) as {
    digest?: unknown
    catalog?: { protocol?: unknown }
  } | null
  if (
    catalog?.catalog?.protocol !== 'dsh-self-evolving-candidate-tree-v2' ||
    typeof catalog.digest !== 'string'
  ) {
    reasons.push('frozen exact capability catalog missing')
  }
  const sealedAccessCount = predecessor.accepted
    ? 0
    : predecessor.reasons.some((reason) => reason.includes('sealed state was accessed'))
      ? 1
      : 0
  return {
    accepted: reasons.length === 0,
    status:
      reasons.length === 0
        ? 'AUTONOMOUS_PLUGIN_DEVELOPMENT_VERIFIED'
        : predecessor.status === 'IN_PROGRESS'
          ? 'IN_PROGRESS'
          : 'REJECTED',
    reasons,
    stateHash: predecessor.stateHash,
    eventCount: predecessor.eventCount,
    claimBoundary: { sealedAccessCount, benchmarkImprovementClaimed: false },
  }
}
