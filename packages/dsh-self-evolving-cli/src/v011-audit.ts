import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assertExactParentEvidenceGrounding,
  readAll,
  readControllerStatus,
  type V011Analysis,
  type V011ParentEvidenceBinding,
} from '@dsh-self-evolving/core'
import {
  assertV011,
  digestV011,
  freezeCapabilityCatalog,
  validateV011,
  v011SchemaDigest,
} from '@dsh-self-evolving/candidate-sdk'
import { auditStableRun } from './audit.js'
import { readV011StableBuild } from './v011-identity.js'
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

interface AuditedStableBuildIdentity {
  candidateId: string
  sourceDigest: string
  capsuleDigest: string
  buildManifestDigest: string
}

interface AuditedIdentityEvent {
  type: string
  payload: unknown
}

function identityPayloadMatches(payload: unknown, built: AuditedStableBuildIdentity): boolean {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false
  const row = payload as Record<string, unknown>
  return (
    row['candidateId'] === built.candidateId &&
    row['sourceDigest'] === built.sourceDigest &&
    row['capsuleDigest'] === built.capsuleDigest &&
    row['buildManifestDigest'] === built.buildManifestDigest
  )
}

export function verifyV011ControllerIdentityBinding(input: {
  label: string
  built: AuditedStableBuildIdentity
  expectedParent: string | null
  requireBuildReceipt: boolean
  candidates: Record<string, { candidateId: string; canonicalParent: string | null }>
  events: AuditedIdentityEvent[]
}): string[] {
  const reasons: string[] = []
  const node = input.candidates[input.built.candidateId]
  if (
    node === undefined ||
    node.candidateId !== input.built.candidateId ||
    node.canonicalParent !== input.expectedParent
  ) {
    reasons.push(`${input.label} disk identity does not bind the controller candidate/parent`)
  }

  const admissions = input.events.filter((event) => {
    if (event.type !== 'candidate.admitted') return false
    const payload = event.payload as { candidateId?: unknown } | null
    return payload?.candidateId === input.built.candidateId
  })
  if (admissions.length !== 1 || !identityPayloadMatches(admissions[0]?.payload, input.built)) {
    reasons.push(`${input.label} disk identity does not bind exactly one admission event`)
  }

  if (input.requireBuildReceipt) {
    const builds = input.events.filter((event) => {
      if (event.type !== 'build.completed') return false
      const payload = event.payload as { candidateId?: unknown } | null
      return payload?.candidateId === input.built.candidateId
    })
    if (builds.length !== 1 || !identityPayloadMatches(builds[0]?.payload, input.built)) {
      reasons.push(`${input.label} disk identity does not bind exactly one journal build receipt`)
    }
  }
  return reasons
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

/**
 * Validate mechanism-outcome CONTENT, not filename counts (issue #85): each
 * generation's record must parse against the official schema, carry bound
 * identities, and the set must be exactly generations 1-3.
 */
export async function verifyMechanismOutcomes(stateDir: string): Promise<string[]> {
  const reasons: string[] = []
  const outcomes = (await files(join(stateDir, 'v011', 'outcomes'))).filter((path) =>
    path.endsWith('/outcome.json'),
  )
  if (outcomes.length !== 3) reasons.push(`mechanism-outcome record matrix is ${outcomes.length}/3`)
  // Validate CONTENT, not filename counts (issue #85): each generation's
  // record must parse against the official schema, carry the expected
  // idempotency key shape, and the set must be exactly generations 1-3.
  const expectedGenerations = ['generation-1', 'generation-2', 'generation-3']
  const seenGenerations = new Set<string>()
  for (const path of outcomes) {
    const generation = path.split('/').at(-2)
    if (generation === undefined || !expectedGenerations.includes(generation)) {
      reasons.push(`mechanism-outcome at unexpected path: ${path}`)
      continue
    }
    if (seenGenerations.has(generation)) {
      reasons.push(`duplicate mechanism-outcome for ${generation}`)
    }
    seenGenerations.add(generation)
    const parsed = await readFile(path, 'utf8')
      .then((raw) => JSON.parse(raw) as Record<string, unknown>)
      .catch(() => null)
    if (parsed === null) {
      reasons.push(`mechanism-outcome for ${generation} is not valid JSON`)
      continue
    }
    const validation = await validateV011('mechanism-outcome', parsed)
    if (!validation.valid) {
      reasons.push(`mechanism-outcome for ${generation} fails its schema`)
    }
    const key = parsed['idempotencyKey']
    const candidateDigest = parsed['candidateDigest']
    if (
      typeof key !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(key) ||
      typeof candidateDigest !== 'string'
    ) {
      reasons.push(`mechanism-outcome for ${generation} lacks a bound identity`)
    }
  }
  for (const generation of expectedGenerations) {
    if (!seenGenerations.has(generation)) {
      reasons.push(`mechanism-outcome missing for ${generation}`)
    }
  }
  return reasons
}

/**
 * Recompute the frozen capability-catalog digest (issue #82): the embedded
 * catalog must survive the official freezer (unique ids, no enabled T3,
 * fixture coverage) and its canonical digest must equal the recorded one.
 */
export async function verifyCapabilityCatalog(
  stateDir: string,
): Promise<{ digest: `sha256:${string}` } | null> {
  const catalog = (await json(join(stateDir, 'v011', 'capability-catalog.json'))) as {
    digest?: unknown
    catalog?: unknown
  } | null
  if (catalog === null) return null
  try {
    const frozen = await freezeCapabilityCatalog(
      catalog.catalog as Parameters<typeof freezeCapabilityCatalog>[0],
    )
    if (frozen.digest !== catalog.digest) return null
    return { digest: frozen.digest }
  } catch {
    return null
  }
}

export async function auditV011Run(config: V011DemoConfig): Promise<V011AuditReport> {
  const predecessor = await auditStableRun(config)
  const controller = await readControllerStatus(config as never)
  const events = await readAll({
    journalDir: join(config.stateDir, 'journal'),
    runId: config.runId,
    segmentMaxBytes: 16 * 1024 * 1024,
  })
  const reasons = [...predecessor.reasons]
  const baselineRoot = join(config.stateDir, 'candidates', 'v011-baseline')
  const baselineIdentity = await readV011StableBuild(baselineRoot).catch(() => null)
  if (baselineIdentity === null) reasons.push('v0.1.1 baseline identity chain is incomplete')
  else {
    reasons.push(
      ...verifyV011ControllerIdentityBinding({
        label: 'baseline',
        built: baselineIdentity,
        expectedParent: null,
        requireBuildReceipt: false,
        candidates: controller.state.candidates,
        events,
      }),
    )
  }
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
  let previousCandidateId = baselineIdentity?.candidateId
  for (let generation = 1; generation <= 3; generation += 1) {
    const candidateRoot = join(config.stateDir, 'candidates', `generation-${generation}`)
    const built = await readV011StableBuild(candidateRoot).catch(() => null)
    if (built !== null) {
      reasons.push(
        ...verifyV011ControllerIdentityBinding({
          label: `generation ${generation}`,
          built,
          expectedParent: previousCandidateId ?? '__missing_v011_parent__',
          requireBuildReceipt: true,
          candidates: controller.state.candidates,
          events,
        }),
      )
      previousCandidateId = built.candidateId
    } else {
      previousCandidateId = undefined
    }
    const admission = (await json(join(candidateRoot, 'admission-receipt.json'))) as {
      admitted?: unknown
      stageReceipts?: unknown
      resourceReceiptDigest?: unknown
    } | null
    const resource = (await json(join(candidateRoot, 'resource-receipt.json'))) as {
      candidateDigest?: unknown
    } | null
    if (
      built?.proposalDigest === undefined ||
      built.runtimePackageName === undefined ||
      admission?.admitted !== true ||
      admission.stageReceipts === undefined ||
      typeof admission.resourceReceiptDigest !== 'string' ||
      resource === null ||
      admission.resourceReceiptDigest !== digestV011(resource) ||
      resource.candidateDigest !== built.candidateId
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
  reasons.push(...(await verifyMechanismOutcomes(config.stateDir)))

  if ((await verifyCapabilityCatalog(config.stateDir)) === null) {
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
