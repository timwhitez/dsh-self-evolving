/** Read-only controller status projection; never acquires a writer lock. */
import { join } from 'node:path'
import { readAll, readHead, type Journal } from './journal/index.js'
import { replay, stateHash, type ControllerState } from './reducer/index.js'

export interface StatusInput {
  stateDir: string
  runId: string
  segmentMaxBytes?: number
}

export interface ControllerStatus {
  runId: string
  eventCount: number
  head: Awaited<ReturnType<typeof readHead>>
  state: ControllerState
  stateHash: string
}

export async function readControllerStatus(input: StatusInput): Promise<ControllerStatus> {
  const journal: Journal = {
    journalDir: join(input.stateDir, 'journal'),
    runId: input.runId,
    segmentMaxBytes: input.segmentMaxBytes ?? 16 * 1024 * 1024,
  }
  const events = await readAll(journal)
  const state = replay(events)
  return {
    runId: input.runId,
    eventCount: events.length,
    head: await readHead(journal),
    state,
    stateHash: stateHash(state),
  }
}
