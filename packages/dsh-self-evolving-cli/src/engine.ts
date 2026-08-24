import { open, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as SelfEvolvingBundle from '@dsh-self-evolving/core'
import {
  readAll,
  canonicalJson,
  recoverEvaluationAction,
  replay,
  type DurableBoundary,
  type EvaluationProvider,
  type JournalEvent,
  type RecordInput,
} from '@dsh-self-evolving/core'
import type { DoctorCheck, DoctorReport } from './doctor.js'
import type { ProjectConfig } from './config.js'

export interface BuiltCandidate {
  candidateId: string
  sourceDigest: string
  capsuleDigest: string
  buildManifestDigest: string
  sourceRoot: string
  evidenceRefs: string[]
  capsuleRoot?: string
  runtimePackageName?: string
  proposalDigest?: string
  analysisDigest?: string
  targetClusterSlug?: string
  hypothesis?: string
}

export interface StableProposal {
  proposalId: string
  parentCandidateId: string
  hypothesis: string
  sourceDiff: string
  evidenceRefs: string[]
  artifactDigest: string
}

export interface StableProposalInput {
  generation: number
  attempt: number
  parent: BuiltCandidate
  evidenceRefs: string[]
  idempotencyKey: string
}

export interface StableBuildInput {
  generation: number
  attempt: number
  parent: BuiltCandidate
  proposal: StableProposal
  idempotencyKey: string
}

export interface StableEvaluationSpec {
  actionId: string
  idempotencyKey: string
  candidate: BuiltCandidate
  taskId: string
  attemptIndex: 0
  kind: 'baseline-discovery' | 'candidate'
}

export interface StableDemoCapabilities {
  preflight(): Promise<DoctorReport>
  baseline: BuiltCandidate
  observedTaskIds(): Promise<string[]>
  propose(input: StableProposalInput): Promise<StableProposal>
  build(input: StableBuildInput): Promise<BuiltCandidate>
  evaluationProvider(spec: StableEvaluationSpec): EvaluationProvider
  reserveUsd?(spec: StableEvaluationSpec): number
  onEvaluationBoundary?(spec: StableEvaluationSpec, boundary: DurableBoundary): void | Promise<void>
  afterCandidateEvaluation?(input: {
    generation: number
    parent: BuiltCandidate
    child: BuiltCandidate
    taskId: string
    observations: Array<{
      candidateId: string
      taskId: string
      attemptIndex: number
      status: 'pass' | 'fail' | 'invalid'
      reward: number | null
    }>
  }): Promise<{ outcomeDigest: string; status: string }>
}

export interface StableDemoResult {
  status: 'STABLE_ITERATION_VERIFIED' | 'NO_REAL_FAILURE_SIGNAL' | 'NO_ADMISSIBLE_CHILD'
  runId: string
  baselineTrials: number
  candidateTrials: number
  solverTrials: number
  admittedChildren: number
  maxLineageDepth: number
  sealedAccessCount: number
  finalStateHash: string
}

interface FailurePool {
  schemaVersion: 1
  runId: string
  batchSize: 1 | 6
  evaluatedTaskIds: string[]
  taskIds: string[]
  frozenBeforeCandidateRewards: true
}

const DIGEST = /^sha256:[0-9a-f]{64}$/
const USD_MICRO_SCALE = 1_000_000
const USD_UNIT_TOLERANCE = 1e-6

/**
 * Split the run's hard USD cap into deterministic fixed-precision
 * reservations. Rounding down is intentional: multiplying the result by the
 * trial bound must never oversell the cap.
 */
export function evaluationReserveUsd(budgetUsd: number, trialLimit: number): number {
  const scaledBudget = budgetUsd * USD_MICRO_SCALE
  const budgetMicros = Math.round(scaledBudget)
  if (
    !Number.isFinite(budgetUsd) ||
    budgetUsd < 0 ||
    Object.is(budgetUsd, -0) ||
    !Number.isSafeInteger(budgetMicros) ||
    Math.abs(scaledBudget - budgetMicros) > USD_UNIT_TOLERANCE ||
    !Number.isSafeInteger(trialLimit) ||
    trialLimit <= 0
  ) {
    throw new Error('stable engine: invalid USD budget allocation')
  }
  return Math.floor(budgetMicros / trialLimit) / USD_MICRO_SCALE
}

function assertCandidate(candidate: BuiltCandidate): void {
  if (candidate.candidateId !== 'baseline' && !DIGEST.test(candidate.candidateId)) {
    throw new Error(`stable engine: invalid candidate id ${candidate.candidateId}`)
  }
  for (const value of [
    candidate.sourceDigest,
    candidate.capsuleDigest,
    candidate.buildManifestDigest,
  ]) {
    if (!DIGEST.test(value)) throw new Error('stable engine: candidate identity is incomplete')
  }
}

function input<P>(eventId: string, type: string, payload: P): RecordInput<P> {
  return {
    eventId,
    occurredAt: new Date().toISOString(),
    type,
    causationId: eventId,
    correlationId: eventId,
    actor: 'stable-demo-controller',
    payload,
  }
}

async function recordOnce<P>(
  service: SelfEvolvingBundle.SelfEvolvingService,
  eventId: string,
  type: string,
  payload: P,
): Promise<void> {
  const events = await readAll(service.journal)
  const existing = events.find((event) => event.eventId === eventId)
  if (existing !== undefined) {
    if (existing.type !== type || canonicalJson(existing.payload) !== canonicalJson(payload)) {
      throw new Error(`stable engine: conflicting event replay ${eventId}`)
    }
    return
  }
  await service.record(input(eventId, type, payload))
}

function eventPayload<T>(events: JournalEvent[], eventId: string): T | undefined {
  return events.find((event) => event.eventId === eventId)?.payload as T | undefined
}

function isBaselineNonPassingSignal(row: {
  candidateId: string
  status: 'pass' | 'fail' | 'invalid'
  reward: number | null
}): boolean {
  return (
    row.candidateId === 'baseline' &&
    (row.status === 'fail' || row.status === 'invalid') &&
    row.reward === 0
  )
}

async function writeFailurePool(config: ProjectConfig, pool: FailurePool): Promise<void> {
  const path = join(config.stateDir, 'failure-pool.json')
  const bytes = JSON.stringify(pool, null, 2) + '\n'
  const file = await open(path, 'wx', 0o600).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
    const current = await readFile(path, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(current) as unknown
    } catch (parseError) {
      throw new Error('stable engine: frozen failure pool is not valid JSON', {
        cause: parseError,
      })
    }
    if (canonicalJson(parsed) !== canonicalJson(pool)) {
      throw new Error('stable engine: frozen failure pool conflict')
    }
    return null
  })
  if (file === null) return
  try {
    await file.writeFile(bytes)
    await file.sync()
  } finally {
    await file.close()
  }
}

function lineageDepth(events: JournalEvent[]): { children: number; maxDepth: number } {
  const state = replay(events)
  const nodes = new Map(Object.values(state.candidates).map((node) => [node.candidateId, node]))
  const children = [...nodes.values()].filter((node) => node.canonicalParent !== null)
  let maxDepth = 0
  for (const child of children) {
    let depth = 0
    let current = child
    const seen = new Set<string>()
    while (current.canonicalParent !== null) {
      if (seen.has(current.candidateId)) throw new Error('stable engine: lineage cycle')
      seen.add(current.candidateId)
      depth += 1
      const parent = nodes.get(current.canonicalParent)
      if (parent === undefined) throw new Error('stable engine: lineage parent missing')
      current = parent
    }
    maxDepth = Math.max(maxDepth, depth)
  }
  return { children: children.length, maxDepth }
}

async function evaluate(
  config: ProjectConfig,
  service: SelfEvolvingBundle.SelfEvolvingService,
  caps: StableDemoCapabilities,
  spec: StableEvaluationSpec,
): Promise<void> {
  const reserveUsd =
    caps.reserveUsd?.(spec) ??
    evaluationReserveUsd(config.limits.budgetUsd, config.limits.solverTrialsMax)
  await recoverEvaluationAction(
    service,
    {
      actionId: spec.actionId,
      idempotencyKey: spec.idempotencyKey,
      reserveUsd,
      budgetLedger: {
        ledgerPath: join(config.stateDir, 'budget.jsonl'),
        limits: {
          usd: config.limits.budgetUsd,
          solverTokens: Number.MAX_SAFE_INTEGER,
          proposerTokens: Number.MAX_SAFE_INTEGER,
          taskTrials: config.limits.solverTrialsMax,
          proposalCalls: config.limits.admittedChildren,
          wallClockSec: 7 * 24 * 3600,
          concurrencySlots: 1,
          storageBytes: 10 * 1024 * 1024 * 1024,
        },
      },
    },
    caps.evaluationProvider(spec),
    {
      onDurableBoundary: async (boundary) => caps.onEvaluationBoundary?.(spec, boundary),
    },
  )
}

function doctorFailures(report: DoctorReport): DoctorCheck[] {
  return report.checks.filter((item) => item.status !== 'PASS')
}

function classifyBuildRejection(message: string): string {
  if (message.includes('patch does not apply')) return 'PATCH_DOES_NOT_APPLY'
  if (message.includes('source diff')) return 'PATCH_CONTAINMENT_REJECT'
  if (message.includes('tsc failed')) return 'COMPILE_REJECT'
  if (message.includes('policy scan rejected')) return 'POLICY_REJECT'
  return 'BUILD_REJECT'
}

export async function runStableDemo(
  config: ProjectConfig,
  caps: StableDemoCapabilities,
): Promise<StableDemoResult> {
  assertCandidate(caps.baseline)
  const ctx = new Context()
  await ctx.plugin(SelfEvolvingBundle, {
    stateDir: config.stateDir,
    runId: config.runId,
    segmentMaxBytes: 16 * 1024 * 1024,
  })
  const service = ctx.selfEvolving
  try {
    let events = await readAll(service.journal)
    const terminal = eventPayload<{ status: StableDemoResult['status'] }>(events, 'run:terminal')
    if (terminal === undefined) {
      const doctor = await caps.preflight()
      if (!doctor.ready) {
        throw new Error(
          `stable engine: preflight failed: ${doctorFailures(doctor)
            .map((c) => c.name)
            .join(',')}`,
        )
      }
      await recordOnce(service, 'run:preflight', 'run.preflight', {
        profile: config.profile,
        solverTrialsMax: 15,
        sealedAccessCount: 0,
      })
      await recordOnce(service, 'candidate:baseline', 'candidate.admitted', {
        candidateId: caps.baseline.candidateId,
        canonicalParent: null,
        donorCandidates: [],
        sourceDigest: caps.baseline.sourceDigest,
        capsuleDigest: caps.baseline.capsuleDigest,
        buildManifestDigest: caps.baseline.buildManifestDigest,
      })
      await recordOnce(service, 'run:searching', 'run.searching', { profile: config.profile })

      const observed = await caps.observedTaskIds()
      if (new Set(observed).size < 12)
        throw new Error('stable engine: fewer than 12 unique observed tasks')
      const planned = observed.slice(0, 12)
      events = await readAll(service.journal)
      let pool = eventPayload<FailurePool>(events, 'failure-pool:frozen')
      if (pool === undefined) {
        let evaluated = 0
        const discoveryBatches =
          config.profile === 'v011-stable-demo'
            ? planned.map((taskId) => [taskId])
            : [planned.slice(0, 6), planned.slice(6, 12)]
        for (const batch of discoveryBatches) {
          for (const taskId of batch) {
            const spec: StableEvaluationSpec = {
              actionId: `eval:baseline:${taskId}`,
              idempotencyKey: `${config.runId}/baseline/${taskId}/0`,
              candidate: caps.baseline,
              taskId,
              attemptIndex: 0,
              kind: 'baseline-discovery',
            }
            await evaluate(config, service, caps, spec)
            evaluated += 1
          }
          events = await readAll(service.journal)
          const failures = replay(events).observations.filter(isBaselineNonPassingSignal)
          if (failures.length > 0) break
        }
        events = await readAll(service.journal)
        const taskIds = replay(events)
          .observations.filter(isBaselineNonPassingSignal)
          .map((row) => row.taskId)
          .sort()
        pool = {
          schemaVersion: 1,
          runId: config.runId,
          batchSize: config.profile === 'v011-stable-demo' ? 1 : 6,
          evaluatedTaskIds: planned.slice(0, evaluated),
          taskIds,
          frozenBeforeCandidateRewards: true,
        }
        await writeFailurePool(config, pool)
        await recordOnce(service, 'failure-pool:frozen', 'failure-pool.frozen', pool)
      } else {
        const expectedBatchSize = config.profile === 'v011-stable-demo' ? 1 : 6
        const evaluatedPrefix = planned.slice(0, pool.evaluatedTaskIds.length)
        const frozenSignals = replay(events)
          .observations.filter(
            (row) => isBaselineNonPassingSignal(row) && pool!.evaluatedTaskIds.includes(row.taskId),
          )
          .map((row) => row.taskId)
          .sort()
        if (
          pool.schemaVersion !== 1 ||
          pool.runId !== config.runId ||
          pool.batchSize !== expectedBatchSize ||
          pool.frozenBeforeCandidateRewards !== true ||
          pool.evaluatedTaskIds.length === 0 ||
          pool.evaluatedTaskIds.length > 12 ||
          canonicalJson(pool.evaluatedTaskIds) !== canonicalJson(evaluatedPrefix) ||
          new Set(pool.taskIds).size !== pool.taskIds.length ||
          canonicalJson(pool.taskIds) !== canonicalJson(frozenSignals)
        ) {
          throw new Error('stable engine: invalid frozen failure pool replay')
        }
        await writeFailurePool(config, pool)
      }
      const taskIds = pool.taskIds
      if (taskIds.length === 0) {
        await recordOnce(service, 'run:terminal', 'run.terminal', {
          status: 'NO_REAL_FAILURE_SIGNAL',
        })
      } else {
        let parent = caps.baseline
        let noAdmissibleChild = false
        for (let generation = 1; generation <= 3; generation += 1) {
          events = await readAll(service.journal)
          const evidenceRefs = events
            .filter(
              (event) =>
                event.type === 'evaluation.observed' &&
                taskIds.includes((event.payload as { taskId?: string }).taskId ?? ''),
            )
            .flatMap((event) => {
              const raw = (event.payload as { rawEvidenceDigests?: unknown }).rawEvidenceDigests
              const rawRefs = Array.isArray(raw)
                ? raw.filter((value): value is string => typeof value === 'string')
                : []
              return [...rawRefs.map((value) => `object:${value}`), `journal:${event.eventHash}`]
            })
          let child: BuiltCandidate | undefined
          for (let attempt = 1; attempt <= 3 && child === undefined; attempt += 1) {
            events = await readAll(service.journal)
            const rejectionEvidence = events
              .filter(
                (event) =>
                  (event.type === 'build.rejected' || event.type === 'proposal.rejected') &&
                  (event.payload as { generation?: unknown }).generation === generation,
              )
              .map((event) => {
                const classification =
                  (event.payload as { classification?: unknown }).classification ??
                  'PROPOSAL_REJECT'
                return `rejection:${String(classification)}:journal:${event.eventHash}`
              })
            const attemptEvidenceRefs = [...evidenceRefs, ...rejectionEvidence]
            const proposalEventId = `proposal:${generation}:${attempt}:completed`
            let proposal = eventPayload<StableProposal>(events, proposalEventId)
            if (proposal === undefined) {
              const proposalRejectionId = `proposal:${generation}:${attempt}:rejected`
              if (eventPayload(events, proposalRejectionId) !== undefined) continue
              try {
                proposal = await caps.propose({
                  generation,
                  attempt,
                  parent,
                  evidenceRefs: attemptEvidenceRefs,
                  idempotencyKey: `${config.runId}/proposal/${generation}/${attempt}/${parent.candidateId}`,
                })
                if (
                  proposal.parentCandidateId !== parent.candidateId ||
                  proposal.evidenceRefs.length === 0
                ) {
                  throw new Error('proposer did not bind parent and raw evidence')
                }
                await recordOnce(service, proposalEventId, 'proposal.completed', proposal)
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : 'unknown proposal rejection'
                await recordOnce(service, proposalRejectionId, 'proposal.rejected', {
                  generation,
                  attempt,
                  classification: 'PROPOSAL_PROTOCOL_REJECT',
                  errorDigest: `sha256:${createHash('sha256').update(message).digest('hex')}`,
                })
                continue
              }
            }
            const buildEventId = `build:${generation}:${attempt}:completed`
            events = await readAll(service.journal)
            child = eventPayload<BuiltCandidate>(events, buildEventId)
            if (child !== undefined) continue
            const rejectionId = `build:${generation}:${attempt}:rejected`
            if (eventPayload(events, rejectionId) !== undefined) continue
            try {
              child = await caps.build({
                generation,
                attempt,
                parent,
                proposal,
                idempotencyKey: `${config.runId}/build/${generation}/${attempt}/${proposal.artifactDigest}`,
              })
              assertCandidate(child)
              await recordOnce(service, buildEventId, 'build.completed', child)
            } catch (error) {
              const message = error instanceof Error ? error.message : 'unknown build rejection'
              await recordOnce(service, rejectionId, 'build.rejected', {
                generation,
                attempt,
                proposalId: proposal.proposalId,
                classification: classifyBuildRejection(message),
                errorDigest: `sha256:${createHash('sha256').update(message).digest('hex')}`,
              })
            }
          }
          if (child === undefined) {
            await recordOnce(service, 'run:terminal', 'run.terminal', {
              status: 'NO_ADMISSIBLE_CHILD',
              generation,
              attempts: 3,
            })
            noAdmissibleChild = true
            break
          }
          await recordOnce(service, `candidate:${child.candidateId}`, 'candidate.admitted', {
            candidateId: child.candidateId,
            canonicalParent: parent.candidateId,
            donorCandidates: [],
            sourceDigest: child.sourceDigest,
            capsuleDigest: child.capsuleDigest,
            buildManifestDigest: child.buildManifestDigest,
          })
          const taskId = taskIds[(generation - 1) % taskIds.length]!
          const spec: StableEvaluationSpec = {
            actionId: `eval:candidate:${generation}`,
            idempotencyKey: `${config.runId}/${child.candidateId}/${taskId}/0`,
            candidate: child,
            taskId,
            attemptIndex: 0,
            kind: 'candidate',
          }
          await evaluate(config, service, caps, spec)
          if (caps.afterCandidateEvaluation !== undefined) {
            const outcome = await caps.afterCandidateEvaluation({
              generation,
              parent,
              child,
              taskId,
              observations: replay(await readAll(service.journal)).observations,
            })
            await recordOnce(
              service,
              `mechanism-outcome:${generation}`,
              'mechanism-outcome.derived',
              { generation, candidateId: child.candidateId, ...outcome },
            )
          }
          await recordOnce(
            service,
            `candidate:${child.candidateId}:observed`,
            'candidate.dev_observed',
            {
              candidateId: child.candidateId,
            },
          )
          parent = child
        }
        if (!noAdmissibleChild) {
          await recordOnce(service, 'run:terminal', 'run.terminal', {
            status: 'STABLE_ITERATION_VERIFIED',
          })
        }
      }
    }

    events = await readAll(service.journal)
    const state = replay(events)
    const terminalStatus = eventPayload<{ status: StableDemoResult['status'] }>(
      events,
      'run:terminal',
    )
    if (terminalStatus === undefined) throw new Error('stable engine: terminal receipt missing')
    const baselineTrials = state.observations.filter((row) => row.candidateId === 'baseline').length
    const candidateTrials = state.observations.length - baselineTrials
    const lineage = lineageDepth(events)
    return {
      status: terminalStatus.status,
      runId: config.runId,
      baselineTrials,
      candidateTrials,
      solverTrials: state.observations.length,
      admittedChildren: lineage.children,
      maxLineageDepth: lineage.maxDepth,
      sealedAccessCount: state.sealedAccessCount,
      finalStateHash: SelfEvolvingBundle.stateHash(state),
    }
  } finally {
    await ctx.fiber.dispose()
  }
}
