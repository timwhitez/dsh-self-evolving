import {
  canonicalJson,
  computeTotals,
  observationPricing,
  readAll,
  readControllerStatus,
  type EvaluationObservation,
} from '@dsh-self-evolving/core'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectConfig } from './config.js'
import {
  computeCrashReceiptFacts,
  crashReceiptMatches,
  parseCrashReceipt,
  readCrashInjectionRequest,
} from './crash.js'
import { assertProposalResourceReceipt, readResourceBoundStableBuild } from './real-capabilities.js'
import { loadPublishedBundle } from './publish.js'

export interface StableAuditReport {
  accepted: boolean
  status: 'STABLE_ITERATION_VERIFIED' | 'IN_PROGRESS' | 'REJECTED'
  reasons: string[]
  stateHash: string
  eventCount: number
}

interface ProposalCompletionEvent {
  eventId: string
  payload: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
}

function validGatewayReceipt(value: unknown): boolean {
  if (!isRecord(value)) return false
  const required = ['requestHash', 'requestId', 'responseHash', 'routeHash']
  const optional = ['attempts', 'error']
  if (
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key)) ||
    required.some((key) => typeof value[key] !== 'string') ||
    !['requestHash', 'responseHash', 'routeHash'].every((key) =>
      /^sha256:[0-9a-f]{64}$/.test(value[key] as string),
    ) ||
    (value['attempts'] !== undefined && !Array.isArray(value['attempts'])) ||
    (value['error'] !== undefined && typeof value['error'] !== 'string')
  ) {
    return false
  }
  return true
}

function validStableProposal(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    exactKeys(value, [
      'artifactDigest',
      'evidenceRefs',
      'hypothesis',
      'parentCandidateId',
      'proposalId',
      'sourceDiff',
    ]) &&
    ['artifactDigest', 'hypothesis', 'parentCandidateId', 'proposalId', 'sourceDiff'].every(
      (key) => typeof value[key] === 'string' && (value[key] as string).length > 0,
    ) &&
    Array.isArray(value['evidenceRefs']) &&
    value['evidenceRefs'].length > 0 &&
    value['evidenceRefs'].every((ref) => typeof ref === 'string')
  )
}

/** Re-read every stable proposer bundle; journal counts/digests alone are not authority. */
export async function verifyStableProposalPublications(
  stateDir: string,
  runId: string,
  proposals: ProposalCompletionEvent[],
): Promise<string[]> {
  const reasons: string[] = []
  for (const event of proposals) {
    const identity = /^proposal:(\d+):(\d+):completed$/.exec(event.eventId)
    if (identity === null || !validStableProposal(event.payload)) {
      reasons.push(`stable proposal event identity is invalid: ${event.eventId}`)
      continue
    }
    const [, generation, attempt] = identity
    const directory = join(stateDir, 'artifacts', `proposal-${generation}-${attempt}`)
    let bundle: Record<string, string> | null
    try {
      bundle = await loadPublishedBundle(directory)
    } catch (error) {
      reasons.push(
        `stable proposal ${event.eventId} committed bundle is invalid: ${error instanceof Error ? error.message : String(error)}`,
      )
      continue
    }
    if (bundle === null) {
      reasons.push(`stable proposal ${event.eventId} committed bundle is missing`)
      continue
    }
    const expectedFiles = [
      'gateway-receipts.json',
      'idempotency-key.json',
      'proposal.json',
      'sandbox-resource.json',
    ]
    if (JSON.stringify(Object.keys(bundle).sort()) !== JSON.stringify(expectedFiles)) {
      reasons.push(`stable proposal ${event.eventId} bundle inventory mismatch`)
      continue
    }
    let publishedProposal: unknown
    let idempotency: unknown
    let gatewayReceipts: unknown
    let resource: unknown
    try {
      publishedProposal = JSON.parse(bundle['proposal.json']!)
      idempotency = JSON.parse(bundle['idempotency-key.json']!)
      gatewayReceipts = JSON.parse(bundle['gateway-receipts.json']!)
      resource = JSON.parse(bundle['sandbox-resource.json']!)
    } catch {
      reasons.push(`stable proposal ${event.eventId} bundle JSON is invalid`)
      continue
    }
    if (!validStableProposal(publishedProposal)) {
      reasons.push(`stable proposal ${event.eventId} published proposal schema is invalid`)
    }
    try {
      if (canonicalJson(publishedProposal) !== canonicalJson(event.payload)) {
        reasons.push(`stable proposal ${event.eventId} proposal bytes differ from journal`)
      }
    } catch {
      reasons.push(`stable proposal ${event.eventId} proposal/journal value is not canonicalizable`)
    }
    const expectedKey = `${runId}/proposal/${generation}/${attempt}/${event.payload['parentCandidateId']}`
    if (
      !isRecord(idempotency) ||
      !exactKeys(idempotency, ['idempotencyKey']) ||
      idempotency['idempotencyKey'] !== expectedKey
    ) {
      reasons.push(`stable proposal ${event.eventId} idempotency binding mismatch`)
    }
    if (
      !Array.isArray(gatewayReceipts) ||
      gatewayReceipts.length === 0 ||
      gatewayReceipts.some((receipt) => !validGatewayReceipt(receipt))
    ) {
      reasons.push(`stable proposal ${event.eventId} gateway receipt matrix is invalid`)
    }
    try {
      assertProposalResourceReceipt(resource)
    } catch (error) {
      reasons.push(
        `stable proposal ${event.eventId} resource receipt is invalid: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return reasons
}

export async function auditStableRun(config: ProjectConfig): Promise<StableAuditReport> {
  const controller = await readControllerStatus(config)
  const events = await readAll({
    journalDir: join(config.stateDir, 'journal'),
    runId: config.runId,
    segmentMaxBytes: 16 * 1024 * 1024,
  })
  const reasons: string[] = []
  const state = controller.state
  const nodes = Object.values(state.candidates)
  const childNodes = nodes.filter((node) => node.canonicalParent !== null)
  const baselineNodes = nodes.filter((node) => node.canonicalParent === null)
  if (baselineNodes.length !== 1) {
    reasons.push(`baseline identity matrix is ${baselineNodes.length}/1`)
  }
  const baselineCandidateId = baselineNodes[0]?.candidateId ?? '__missing_baseline_identity__'
  const byId = new Map(nodes.map((node) => [node.candidateId, node]))
  const depthOf = (candidateId: string): number => {
    let depth = 0
    let current = byId.get(candidateId)
    const seen = new Set<string>()
    while (current?.canonicalParent !== null && current !== undefined) {
      if (seen.has(current.candidateId)) return -1
      seen.add(current.candidateId)
      depth += 1
      current = byId.get(current.canonicalParent)
    }
    return depth
  }
  if (childNodes.length !== config.limits.admittedChildren) {
    reasons.push(
      `unique admitted children incomplete: ${childNodes.length}/${config.limits.admittedChildren}`,
    )
  }
  if (config.profile === 'stable-demo') {
    for (let generation = 1; generation <= config.limits.admittedChildren; generation += 1) {
      const built = await readResourceBoundStableBuild(
        join(config.stateDir, 'candidates', `generation-${generation}`),
      ).catch(() => null)
      if (built === null || !childNodes.some((node) => node.candidateId === built.candidateId)) {
        reasons.push(`generation ${generation} resource-bound build publication is invalid`)
      }
    }
  }
  if (Math.max(0, ...childNodes.map((node) => depthOf(node.candidateId))) < 2) {
    reasons.push('lineage depth is below 2')
  }
  const candidateObservations = state.observations.filter(
    (row) => row.candidateId !== baselineCandidateId,
  )
  if (candidateObservations.length !== 3)
    reasons.push('candidate observation matrix is not exactly 3')
  if (state.sealedAccessCount !== 0) reasons.push('sealed state was accessed')

  const freezePath = join(config.stateDir, 'failure-pool.json')
  const freezeInfo = await stat(freezePath).catch(() => null)
  if (freezeInfo?.isFile() !== true) reasons.push('frozen failure pool missing')
  else {
    const freeze = JSON.parse(await readFile(freezePath, 'utf8')) as { taskIds?: unknown }
    if (!Array.isArray(freeze.taskIds) || freeze.taskIds.length === 0) {
      reasons.push('frozen failure pool is empty')
    } else {
      const taskIds = new Set(
        freeze.taskIds.filter((value): value is string => typeof value === 'string'),
      )
      const baselineByTask = new Map(
        state.observations
          .filter((row) => row.candidateId === baselineCandidateId)
          .map((row) => [row.taskId, row]),
      )
      if (
        [...taskIds].some((taskId) => {
          const row = baselineByTask.get(taskId)
          return (
            row === undefined ||
            !(
              (row.status === 'fail' && row.reward === 0) ||
              (row.status === 'invalid' && row.reward === null)
            )
          )
        })
      ) {
        reasons.push(
          'failure pool contains a task without an attributable non-passing baseline signal',
        )
      }
      if (candidateObservations.some((row) => !taskIds.has(row.taskId))) {
        reasons.push('candidate observation escaped the frozen failure pool')
      }
    }
  }
  const frozen = events.find((event) => event.eventId === 'failure-pool:frozen')
  const firstCandidateObservation = events.find(
    (event) =>
      event.type === 'evaluation.observed' &&
      (event.payload as { candidateId?: string }).candidateId !== baselineCandidateId,
  )
  if (
    frozen === undefined ||
    (firstCandidateObservation !== undefined && frozen.seq >= firstCandidateObservation.seq)
  ) {
    reasons.push('failure pool was not frozen before candidate rewards')
  }
  if (state.observations.length > config.limits.solverTrialsMax) {
    reasons.push('solver trial limit exceeded')
  }
  const baselineTrials = state.observations.filter(
    (row) => row.candidateId === baselineCandidateId,
  ).length
  const validBaselineTrialCount =
    config.profile === 'v011-stable-demo'
      ? baselineTrials >= 1 && baselineTrials <= config.limits.baselineFailureDiscoveryMax
      : [6, 12].includes(baselineTrials)
  if (!validBaselineTrialCount) reasons.push(`baseline batch is incomplete: ${baselineTrials}`)
  // Terminal (COMMITTED/FAILED/CANCELLED/ABANDONED) actions are settled; only
  // unresolved in-flight states fail the audit — proposal/build attempts that
  // were durably planned but rejected end FAILED by design (issue #53).
  const TERMINAL_ACTIONS = new Set(['COMMITTED', 'FAILED', 'CANCELLED', 'ABANDONED'])
  if (Object.values(state.actions).some((action) => !TERMINAL_ACTIONS.has(action.status))) {
    reasons.push('one or more external actions are not terminal')
  }
  const normalizedEvents = events.filter((event) => event.type === 'evaluation.observed')
  if (
    normalizedEvents.some((event) => {
      const refs = (event.payload as { rawEvidenceDigests?: unknown }).rawEvidenceDigests
      return (
        !Array.isArray(refs) || refs.length === 0 || refs.some((ref) => typeof ref !== 'string')
      )
    })
  ) {
    reasons.push('one or more observations lack raw evidence digests')
  }
  const proposals = events.filter((event) => event.type === 'proposal.completed')
  if (
    proposals.length < 3 ||
    proposals.length > 9 ||
    proposals.some((event) => {
      const refs = (event.payload as { evidenceRefs?: unknown }).evidenceRefs
      return (
        !Array.isArray(refs) ||
        !refs.some((ref) => typeof ref === 'string' && ref.startsWith('object:sha256:'))
      )
    })
  ) {
    reasons.push('proposer raw-evidence reference matrix is incomplete')
  }
  if (config.profile === 'stable-demo') {
    reasons.push(
      ...(await verifyStableProposalPublications(config.stateDir, config.runId, proposals)),
    )
  }
  if (events.filter((event) => event.type === 'build.completed').length !== 3) {
    reasons.push('build receipt matrix is incomplete')
  }
  // One-to-one evidence graph (issue #79): every admitted child must be
  // covered by EXACTLY one build receipt and the required candidate
  // observation; replayed/count-expanded rows for one child cannot fill the
  // matrix while another child has no attributable evidence.
  {
    const childIds = new Set(childNodes.map((node) => node.candidateId))
    const buildByCandidate = new Map<string, number>()
    for (const event of events.filter((row) => row.type === 'build.completed')) {
      const candidateId = (event.payload as { candidateId?: unknown }).candidateId
      if (typeof candidateId !== 'string') {
        reasons.push('build completion lacks a candidate identity')
        continue
      }
      buildByCandidate.set(candidateId, (buildByCandidate.get(candidateId) ?? 0) + 1)
    }
    const observationByCandidate = new Map<string, number>()
    for (const row of candidateObservations) {
      observationByCandidate.set(
        row.candidateId,
        (observationByCandidate.get(row.candidateId) ?? 0) + 1,
      )
    }
    for (const candidateId of childIds) {
      if (buildByCandidate.get(candidateId) !== 1) {
        reasons.push(`admitted child lacks exactly one build receipt: ${candidateId}`)
      }
      if ((observationByCandidate.get(candidateId) ?? 0) < 1) {
        reasons.push(`admitted child lacks an attributable observation: ${candidateId}`)
      }
    }
    const covered = new Set([...buildByCandidate.keys(), ...observationByCandidate.keys()])
    for (const candidateId of covered) {
      if (!childIds.has(candidateId)) {
        reasons.push(`evidence references an unknown candidate: ${candidateId}`)
      }
    }
  }

  const crashPath = join(config.stateDir, 'crash-resume-receipt.json')
  const crashReceipt = await stat(crashPath).catch(() => null)
  if (crashReceipt?.isFile() !== true) reasons.push('real crash/resume receipt missing')
  else {
    // Independently re-derive the crash facts from durable state instead of
    // trusting the receipt's counters (issue #78), using the SAME shared
    // field-wise verifier as finalization (review of #210).
    const crashRequest = await readCrashInjectionRequest(config).catch(() => null)
    const parsed = parseCrashReceipt(await readFile(crashPath, 'utf8'))
    const facts =
      crashRequest === null
        ? null
        : await computeCrashReceiptFacts(config, crashRequest).catch(() => null)
    if (
      parsed === null ||
      facts === null ||
      !crashReceiptMatches(parsed, facts) ||
      facts.replayStateHash !== controller.stateHash
    ) {
      reasons.push('crash/resume exactly-once receipt is invalid')
    }
  }
  const budget = await computeTotals({
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
  })
  if (budget.totals.reserved.usd !== 0) reasons.push('budget reservation remains unsettled')
  // Fail closed while any evaluation's usage is unpriced: a zero-spend entry
  // is only acceptable with trusted pricing evidence (issue #108).
  const unpriced = events.filter(
    (event) =>
      event.type === 'evaluation.observed' &&
      observationPricing(event.payload as unknown as EvaluationObservation).state !== 'priced',
  )
  if (unpriced.length > 0) {
    reasons.push(`unresolved unpriced evaluation usage: ${unpriced.length}`)
  }
  if (
    budget.entries.filter((entry) => entry.kind === 'spend').length !== state.observations.length
  ) {
    reasons.push('budget spend count does not match observations')
  }
  if (state.runPhase !== 'TERMINAL') reasons.push(`run is not terminal: ${state.runPhase}`)
  return {
    accepted: reasons.length === 0,
    status:
      reasons.length === 0
        ? 'STABLE_ITERATION_VERIFIED'
        : state.runPhase === 'TERMINAL'
          ? 'REJECTED'
          : 'IN_PROGRESS',
    reasons,
    stateHash: controller.stateHash,
    eventCount: controller.eventCount,
  }
}
