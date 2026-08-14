import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { digestV011 } from '@dsh-rsi/candidate-sdk'
import {
  deriveMechanismOutcome,
  publishMechanismOutcomeOnce,
  type MechanismOutcomeRecord,
  type OutcomeTrial,
} from './v011-outcome.js'

export interface RecoveredProposalArtifact {
  status: 'CREATED' | 'REUSED'
  digest: `sha256:${string}`
  bytes: Uint8Array
}

export async function recoverV011ProposalPublication(input: {
  path: string
  expectedProposalId: string
  produce: () => Promise<Uint8Array>
  afterDurablePublish?: () => void | Promise<void>
}): Promise<RecoveredProposalArtifact> {
  const existing = await readFile(input.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing !== null) {
    const parsed = JSON.parse(existing.toString('utf8')) as { proposalId?: unknown }
    if (parsed.proposalId !== input.expectedProposalId) {
      throw new Error('v0.1.1 recovery: published proposal conflicts with reservation')
    }
    return {
      status: 'REUSED',
      digest: `sha256:${createHash('sha256').update(existing).digest('hex')}`,
      bytes: existing,
    }
  }
  const bytes = await input.produce()
  const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as { proposalId?: unknown }
  if (parsed.proposalId !== input.expectedProposalId) {
    throw new Error('v0.1.1 recovery: producer returned wrong reserved proposal')
  }
  await mkdir(dirname(input.path), { recursive: true, mode: 0o700 })
  const file = await open(input.path, 'wx', 0o600)
  try {
    await file.writeFile(bytes)
    await file.sync()
  } finally {
    await file.close()
  }
  await input.afterDurablePublish?.()
  return {
    status: 'CREATED',
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    bytes,
  }
}

export async function recoverV011OutcomeDerivation(input: {
  path: string
  proposalDigest: `sha256:${string}`
  hypothesis: string
  candidateDigest: `sha256:${string}`
  targetClusterSlug: string
  targetTaskHandle: string
  trials: OutcomeTrial[]
  afterDurablePublish?: () => void | Promise<void>
}): Promise<{ status: 'CREATED' | 'REUSED'; record: MechanismOutcomeRecord }> {
  const record = await deriveMechanismOutcome(input)
  const status = await publishMechanismOutcomeOnce(input.path, record)
  if (status === 'CREATED') await input.afterDurablePublish?.()
  return { status, record }
}

export interface V011AttemptResult {
  attempt: number
  status: 'REJECTED' | 'ADMITTED'
  classification?: string
  artifactDigest?: `sha256:${string}`
}

export function settleV011GenerationAttempts(attempts: V011AttemptResult[]): {
  status: 'ADMITTED' | 'NO_ADMISSIBLE_CHILD'
  admittedDigest: `sha256:${string}` | null
} {
  if (attempts.length === 0 || attempts.length > 3) {
    throw new Error('v0.1.1 attempts: generation must contain 1..3 ordered attempts')
  }
  for (const [index, attempt] of attempts.entries()) {
    if (attempt.attempt !== index + 1)
      throw new Error('v0.1.1 attempts: non-contiguous attempt sequence')
    if (attempt.status === 'ADMITTED') {
      if (attempt.artifactDigest === undefined)
        throw new Error('v0.1.1 attempts: admitted attempt lacks artifact')
      if (index !== attempts.length - 1)
        throw new Error('v0.1.1 attempts: work continued after admission')
      return { status: 'ADMITTED', admittedDigest: attempt.artifactDigest }
    }
    if (attempt.classification === undefined)
      throw new Error('v0.1.1 attempts: rejection lacks classification')
  }
  if (attempts.length < 3) throw new Error('v0.1.1 attempts: generation remains retryable')
  return { status: 'NO_ADMISSIBLE_CHILD', admittedDigest: null }
}

export function v011LineageStateHash(input: {
  runId: string
  candidates: Array<{ digest: string; parent: string | null }>
  attempts: V011AttemptResult[]
  outcomes: MechanismOutcomeRecord[]
}): `sha256:${string}` {
  return digestV011({
    runId: input.runId,
    candidates: [...input.candidates].sort((left, right) =>
      left.digest.localeCompare(right.digest),
    ),
    attempts: [...input.attempts].sort((left, right) => left.attempt - right.attempt),
    outcomes: [...input.outcomes].sort((left, right) =>
      left.idempotencyKey.localeCompare(right.idempotencyKey),
    ),
  })
}
