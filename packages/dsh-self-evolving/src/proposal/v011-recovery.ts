import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { link, lstat, mkdir, open, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { assertV011, canonicalV011, digestV011 } from '@dsh-self-evolving/candidate-sdk'
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

export interface DurablePublishIdentity {
  schemaVersion: 1
  artifactKind: 'proposal' | 'mechanism-outcome'
  actionId: string
  artifactDigest: `sha256:${string}`
  reconciliationId: `sha256:${string}`
}

type DurablePublishHook = (identity: Readonly<DurablePublishIdentity>) => void | Promise<void>

function durablePublishIdentity(
  artifactKind: DurablePublishIdentity['artifactKind'],
  actionId: string,
  artifactDigest: `sha256:${string}`,
): Readonly<DurablePublishIdentity> {
  const identity: DurablePublishIdentity = {
    schemaVersion: 1,
    artifactKind,
    actionId,
    artifactDigest,
    reconciliationId: digestV011({
      schemaVersion: 1,
      domain: 'dsh-self-evolving:durable-publish-reconciliation:v1',
      artifactKind,
      actionId,
      artifactDigest,
    }),
  }
  return Object.freeze(identity)
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

async function readRegularFile(path: string): Promise<Buffer | null> {
  const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    },
  )
  if (file === null) return null
  try {
    const [held, canonical] = await Promise.all([file.stat(), lstat(path)])
    if (
      !held.isFile() ||
      !canonical.isFile() ||
      held.dev !== canonical.dev ||
      held.ino !== canonical.ino
    ) {
      throw new Error('v0.1.1 recovery: artifact path is not one stable regular file')
    }
    return await file.readFile()
  } finally {
    await file.close()
  }
}

async function validateProposalArtifact(
  bytes: Uint8Array,
  expectedProposalId: string,
): Promise<void> {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown
  } catch (error) {
    throw new Error('v0.1.1 recovery: published proposal is not valid JSON', { cause: error })
  }
  await assertV011('proposal', parsed)
  if ((parsed as { proposalId?: unknown }).proposalId !== expectedProposalId) {
    throw new Error('v0.1.1 recovery: published proposal conflicts with reservation')
  }
}

async function reconcileProposal(
  bytes: Uint8Array,
  proposalId: string,
  hook: DurablePublishHook | undefined,
): Promise<`sha256:${string}`> {
  const digest = digestV011(bytes)
  await hook?.(durablePublishIdentity('proposal', proposalId, digest))
  return digest
}

export async function recoverV011ProposalPublication(input: {
  path: string
  expectedProposalId: string
  produce: () => Promise<Uint8Array>
  afterDurablePublish?: DurablePublishHook
}): Promise<RecoveredProposalArtifact> {
  const existing = await readRegularFile(input.path)
  if (existing !== null) {
    await validateProposalArtifact(existing, input.expectedProposalId)
    const digest = await reconcileProposal(
      existing,
      input.expectedProposalId,
      input.afterDurablePublish,
    )
    return {
      status: 'REUSED',
      digest,
      bytes: existing,
    }
  }
  const bytes = Buffer.from(await input.produce())
  await validateProposalArtifact(bytes, input.expectedProposalId)
  const parent = dirname(input.path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const stagingPath = `${input.path}.staging-${process.pid}-${randomUUID()}`
  const file = await open(stagingPath, 'wx', 0o600)
  try {
    await file.writeFile(bytes)
    await file.sync()
  } finally {
    await file.close()
  }
  let status: RecoveredProposalArtifact['status'] = 'CREATED'
  let committedBytes: Uint8Array = bytes
  try {
    try {
      await link(stagingPath, input.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      status = 'REUSED'
      const winner = await readRegularFile(input.path)
      if (winner === null) {
        throw new Error('v0.1.1 recovery: concurrent proposal publication disappeared', {
          cause: error,
        })
      }
      committedBytes = winner
      await validateProposalArtifact(committedBytes, input.expectedProposalId)
      if (digestV011(committedBytes) !== digestV011(bytes)) {
        throw new Error('v0.1.1 recovery: concurrent proposal publication conflicts', {
          cause: error,
        })
      }
    }
    await syncDirectory(parent)
  } finally {
    await rm(stagingPath, { force: true })
  }
  const digest = await reconcileProposal(
    committedBytes,
    input.expectedProposalId,
    input.afterDurablePublish,
  )
  return { status, digest, bytes: committedBytes }
}

export async function recoverV011OutcomeDerivation(input: {
  path: string
  proposalDigest: `sha256:${string}`
  hypothesis: string
  candidateDigest: `sha256:${string}`
  targetClusterSlug: string
  targetTaskHandle: string
  trials: OutcomeTrial[]
  afterDurablePublish?: DurablePublishHook
}): Promise<{ status: 'CREATED' | 'REUSED'; record: MechanismOutcomeRecord }> {
  const record = await deriveMechanismOutcome(input)
  const status = await publishMechanismOutcomeOnce(input.path, record)
  const bytes = Buffer.from(canonicalV011(record) + '\n')
  await input.afterDurablePublish?.(
    durablePublishIdentity('mechanism-outcome', record.idempotencyKey, digestV011(bytes)),
  )
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
