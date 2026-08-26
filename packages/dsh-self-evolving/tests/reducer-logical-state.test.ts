import { describe, expect, it } from 'vitest'
import {
  computeEventHash,
  logicalStateHash,
  logicalStateProjection,
  replay,
  stateHash,
  type ControllerState,
  type JournalEvent,
} from '../src/index.js'

interface LogicalEvent {
  eventId: string
  type: string
  payload: Record<string, unknown>
}

function materialize(events: LogicalEvent[]): JournalEvent[] {
  const rows: JournalEvent[] = []
  let previousHash: string | null = null
  for (const [index, event] of events.entries()) {
    const partial: Omit<JournalEvent, 'eventHash'> = {
      schemaVersion: 1,
      runId: 'logical-state-order-test',
      seq: index + 1,
      eventId: event.eventId,
      occurredAt: '2026-08-25T00:00:00.000Z',
      type: event.type,
      causationId: null,
      correlationId: 'wave-1',
      actor: 'test',
      payload: event.payload,
      previousHash,
    }
    const eventHash = computeEventHash(partial)
    rows.push({ ...partial, eventHash })
    previousHash = eventHash
  }
  return rows
}

const prefix: LogicalEvent[] = [
  { eventId: 'preflight', type: 'run.preflight', payload: {} },
  { eventId: 'searching', type: 'run.searching', payload: {} },
  {
    eventId: 'admit-a',
    type: 'candidate.admitted',
    payload: { candidateId: 'c_a', canonicalParent: null, donorCandidates: [] },
  },
  {
    eventId: 'admit-b',
    type: 'candidate.admitted',
    payload: { candidateId: 'c_b', canonicalParent: 'c_a', donorCandidates: [] },
  },
]

const observationA: LogicalEvent = {
  eventId: 'observation-a',
  type: 'evaluation.observed',
  payload: {
    candidateId: 'c_a',
    taskId: 'task-2',
    attemptIndex: 0,
    status: 'pass',
    reward: 1,
  },
}

const observationB: LogicalEvent = {
  eventId: 'observation-b',
  type: 'evaluation.observed',
  payload: {
    candidateId: 'c_b',
    taskId: 'task-1',
    attemptIndex: 0,
    status: 'fail',
    reward: 0,
  },
}

describe('exact checkpoint and logical reducer identities', () => {
  it('keeps journal/checkpoint identity order-sensitive while logical facts are order-independent', () => {
    const stateAB = replay(materialize([...prefix, observationA, observationB]))
    const stateBA = replay(materialize([...prefix, observationB, observationA]))

    expect(stateAB.lastSeq).toBe(stateBA.lastSeq)
    expect(stateAB.lastEventHash).not.toBe(stateBA.lastEventHash)
    expect(stateAB.observations).not.toEqual(stateBA.observations)
    expect(stateHash(stateAB)).not.toBe(stateHash(stateBA))
    expect(logicalStateProjection(stateAB)).toEqual(logicalStateProjection(stateBA))
    expect(logicalStateHash(stateAB)).toBe(logicalStateHash(stateBA))
  })

  it('never normalizes a changed journal tail out of the exact checkpoint hash', () => {
    const state = replay(materialize([...prefix, observationA]))
    const changedTail: ControllerState = {
      ...state,
      lastSeq: state.lastSeq + 1,
      lastEventHash: `sha256:${'f'.repeat(64)}`,
    }

    expect(stateHash(changedTail)).not.toBe(stateHash(state))
    expect(logicalStateProjection(changedTail)).toEqual(logicalStateProjection(state))
    expect(logicalStateHash(changedTail)).toBe(logicalStateHash(state))
  })

  it('retains every logical observation fact in the logical identity', () => {
    const state = replay(materialize([...prefix, observationA]))
    const changedObservation: ControllerState = {
      ...state,
      observations: [{ ...state.observations[0]!, reward: 0 }],
    }

    expect(logicalStateProjection(changedObservation)).not.toEqual(logicalStateProjection(state))
    expect(logicalStateHash(changedObservation)).not.toBe(logicalStateHash(state))
  })

  it('does not mutate the persisted state while producing a canonical projection', () => {
    const state = replay(materialize([...prefix, observationA, observationB]))
    const before = structuredClone(state)

    logicalStateProjection(state)

    expect(state).toEqual(before)
  })
})
