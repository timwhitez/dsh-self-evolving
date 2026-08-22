import { describe, expect, it } from 'vitest'
import {
  computeEventHash,
  replay,
  stateHash,
  type JournalEvent,
} from '../src/index.js'

interface LogicalEvent {
  eventId: string
  type: string
  payload: Record<string, unknown>
}

function materialize(events: LogicalEvent[]): JournalEvent[] {
  const out: JournalEvent[] = []
  let previousHash: string | null = null
  for (const [index, row] of events.entries()) {
    const partial: Omit<JournalEvent, 'eventHash'> = {
      schemaVersion: 1,
      runId: 'wave-order-test',
      seq: index + 1,
      eventId: row.eventId,
      occurredAt: '2026-08-14T00:00:00.000Z',
      type: row.type,
      causationId: null,
      correlationId: 'wave-1',
      actor: 'test',
      payload: row.payload,
      previousHash,
    }
    const eventHash = computeEventHash(partial)
    out.push({ ...partial, eventHash })
    previousHash = eventHash
  }
  return out
}

describe('same-wave reducer canonicalization', () => {
  it('produces the same derived state hash for different valid completion orders', () => {
    const prefix: LogicalEvent[] = [{ eventId: 'preflight', type: 'run.preflight', payload: {} }]
    const wave: LogicalEvent[] = [
      {
        eventId: 'candidate-a',
        type: 'candidate.admitted',
        payload: { candidateId: 'c_a', canonicalParent: null, donorCandidates: [] },
      },
      {
        eventId: 'candidate-b',
        type: 'candidate.admitted',
        payload: { candidateId: 'c_b', canonicalParent: null, donorCandidates: [] },
      },
      {
        eventId: 'action-a',
        type: 'action.planned',
        payload: { actionId: 'a_eval', kind: 'evaluation', idempotencyKey: 'key-a' },
      },
      {
        eventId: 'action-b',
        type: 'action.planned',
        payload: { actionId: 'b_eval', kind: 'evaluation', idempotencyKey: 'key-b' },
      },
      {
        eventId: 'observation-a',
        type: 'evaluation.observed',
        payload: {
          candidateId: 'c_a',
          taskId: 'task-2',
          attemptIndex: 0,
          status: 'pass',
          reward: 1,
        },
      },
      {
        eventId: 'observation-b',
        type: 'evaluation.observed',
        payload: {
          candidateId: 'c_b',
          taskId: 'task-1',
          attemptIndex: 0,
          status: 'fail',
          reward: 0,
        },
      },
    ]

    const stateA = replay(materialize([...prefix, ...wave]))
    const stateB = replay(
      materialize([
        ...prefix,
        wave[5]!,
        wave[3]!,
        wave[1]!,
        wave[4]!,
        wave[2]!,
        wave[0]!,
      ]),
    )

    expect(stateA.lastSeq).toBe(stateB.lastSeq)
    expect(stateA.lastEventHash).not.toBe(stateB.lastEventHash)
    expect(stateA.candidates).toEqual(stateB.candidates)
    expect(stateA.actions).toEqual(stateB.actions)
    expect(stateA.observations).toEqual(stateB.observations)
    expect(stateHash(stateA)).toBe(stateHash(stateB))
  })

  it('defensively canonicalizes observation arrays supplied by older snapshots', () => {
    const state = replay(
      materialize([
        {
          eventId: 'observation-a',
          type: 'evaluation.observed',
          payload: {
            candidateId: 'c_a',
            taskId: 'task-2',
            attemptIndex: 0,
            status: 'pass',
            reward: 1,
          },
        },
        {
          eventId: 'observation-b',
          type: 'evaluation.observed',
          payload: {
            candidateId: 'c_a',
            taskId: 'task-1',
            attemptIndex: 0,
            status: 'fail',
            reward: 0,
          },
        },
      ]),
    )
    const reversed = { ...state, observations: [...state.observations].reverse() }

    expect(stateHash(reversed)).toBe(stateHash(state))
  })
})
