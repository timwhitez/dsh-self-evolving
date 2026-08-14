import { open, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readAll, replay, stateHash, type DurableBoundary } from '@dsh-rsi/core'
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

export async function finalizeCrashResumeReceipt(config: ProjectConfig): Promise<string | null> {
  const request = await readCrashInjectionRequest(config)
  if (request === null) return null
  const receiptPath = join(config.stateDir, 'crash-resume-receipt.json')
  if ((await readFile(receiptPath, 'utf8').catch(() => null)) !== null) return receiptPath
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
  const receipt = {
    schemaVersion: 1,
    runId: config.runId,
    injectedActionId: request.actionId,
    injectedBoundary: request.boundary,
    staleWriterLockReceipts: staleLocks.sort(),
    launchEvents: launched.length,
    observationEvents: observed.length,
    commitEvents: committed.length,
    replayStateHash: stateHash(replay(events)),
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
