import { open, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readAll, replay, stateHash, type DurableBoundary } from '@dsh-self-evolving/core'
import type { ProjectConfig } from './config.js'

export interface CrashInjectionRequest {
  schemaVersion: 1
  actionId: string
  boundary: DurableBoundary
}

export async function requestCrashInjection(
  config: ProjectConfig,
  request: CrashInjectionRequest,
): Promise<void> {
  const file = await open(join(config.stateDir, 'crash-injection-request.json'), 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(request, null, 2) + '\n')
    await file.sync()
  } finally {
    await file.close()
  }
}

export async function readCrashInjectionRequest(
  config: ProjectConfig,
): Promise<CrashInjectionRequest | null> {
  const raw = await readFile(join(config.stateDir, 'crash-injection-request.json'), 'utf8').catch(
    () => null,
  )
  if (raw === null) return null
  const request = JSON.parse(raw) as CrashInjectionRequest
  if (
    request.schemaVersion !== 1 ||
    typeof request.actionId !== 'string' ||
    !['intent', 'launch', 'collect', 'commit'].includes(request.boundary)
  ) {
    throw new Error('crash receipt: invalid injection request')
  }
  return request
}

export interface CrashReceiptFacts {
  runId: string
  injectedActionId: string
  injectedBoundary: string
  staleWriterLockReceipts: string[]
  launchEvents: number
  observationEvents: number
  commitEvents: number
  replayStateHash: string
}

/**
 * Recompute the crash/resume facts from durable state (journal + preserved
 * stale locks + the injection request). Shared by finalization and the
 * audit so the receipt can be independently re-derived, never trusted
 * (issue #78).
 */
export async function computeCrashReceiptFacts(
  config: ProjectConfig,
  request: { actionId: string; boundary: string },
): Promise<CrashReceiptFacts> {
  const journalDir = join(config.stateDir, 'journal')
  const staleLocks = (await readdir(journalDir)).filter((name) => name.startsWith('lock.stale-'))
  if (staleLocks.length === 0) throw new Error('crash receipt: preserved stale writer lock missing')
  const journal = {
    journalDir,
    runId: config.runId,
    segmentMaxBytes: 16 * 1024 * 1024,
  }
  const events = await readAll(journal)
  const launched = events.filter((event) => event.eventId === `${request.actionId}:action.launched`)
  const observed = events.filter(
    (event) => event.eventId === `${request.actionId}:evaluation.observed`,
  )
  const committed = events.filter(
    (event) => event.eventId === `${request.actionId}:action.committed`,
  )
  if (launched.length !== 1 || observed.length !== 1 || committed.length !== 1) {
    throw new Error('crash receipt: action did not reconcile exactly once')
  }
  return {
    runId: config.runId,
    injectedActionId: request.actionId,
    injectedBoundary: request.boundary,
    staleWriterLockReceipts: staleLocks.sort(),
    launchEvents: launched.length,
    observationEvents: observed.length,
    commitEvents: committed.length,
    replayStateHash: stateHash(replay(events)),
  }
}

/**
 * Field-wise receipt verification with unknown-key rejection: one verifier
 * shared by finalization and audit so strictness cannot drift (review of
 * #210). Returns null when the file is unparseable or malformed.
 */
export function parseCrashReceipt(
  raw: string,
): (CrashReceiptFacts & { schemaVersion: number }) | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const expectedKeys = [
      'schemaVersion',
      'runId',
      'injectedActionId',
      'injectedBoundary',
      'staleWriterLockReceipts',
      'launchEvents',
      'observationEvents',
      'commitEvents',
      'replayStateHash',
    ]
    if (
      JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(expectedKeys.sort()) ||
      parsed['schemaVersion'] !== 1
    ) {
      return null
    }
    return parsed as unknown as CrashReceiptFacts & { schemaVersion: number }
  } catch {
    return null
  }
}

export function crashReceiptMatches(
  parsed: CrashReceiptFacts & { schemaVersion: number },
  facts: CrashReceiptFacts,
): boolean {
  return (
    parsed.runId === facts.runId &&
    parsed.injectedActionId === facts.injectedActionId &&
    parsed.injectedBoundary === facts.injectedBoundary &&
    JSON.stringify(parsed.staleWriterLockReceipts) ===
      JSON.stringify(facts.staleWriterLockReceipts) &&
    parsed.launchEvents === facts.launchEvents &&
    parsed.observationEvents === facts.observationEvents &&
    parsed.commitEvents === facts.commitEvents &&
    parsed.replayStateHash === facts.replayStateHash
  )
}

export async function finalizeCrashResumeReceipt(config: ProjectConfig): Promise<string | null> {
  const request = await readCrashInjectionRequest(config)
  if (request === null) return null
  const receiptPath = join(config.stateDir, 'crash-resume-receipt.json')
  const existing = await readFile(receiptPath, 'utf8').catch(() => null)
  if (existing !== null) {
    // Bare existence is not completion (issue #78): parse and fully
    // re-derive the receipt before accepting it.
    const parsed = parseCrashReceipt(existing)
    const facts =
      parsed === null ? null : await computeCrashReceiptFacts(config, request).catch(() => null)
    if (parsed === null || facts === null || !crashReceiptMatches(parsed, facts)) {
      throw new Error('crash receipt: existing receipt does not match re-derived facts')
    }
    return receiptPath
  }
  const receipt = {
    schemaVersion: 1,
    ...(await computeCrashReceiptFacts(config, request)),
  }
  const file = await open(receiptPath, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(receipt, null, 2) + '\n')
    await file.sync()
  } finally {
    await file.close()
  }
  return receiptPath
}
