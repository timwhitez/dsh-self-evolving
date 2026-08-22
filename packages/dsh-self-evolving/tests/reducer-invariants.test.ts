import { describe, expect, it } from 'vitest'
import {
  genesisState,
  reduce,
  type ControllerState,
  type JournalEvent,
} from '../src/index.js'

function event(state: ControllerState, type: string, payload: Record<string, unknown>): JournalEvent {
  const seq = state.lastSeq + 1
  return {
    schemaVersion: 1,
    runId: 'reducer-invariants',
    seq,
    eventId: `${type}:${seq}`,
    occurredAt: '2026-08-14T00:00:00.000Z',
    type,
    causationId: null,
    correlationId: null,
    actor: 'test',
    payload,
    previousHash: state.lastEventHash,
    eventHash: `sha256:${String(seq).padStart(64, '0')}`,
  }
}

function apply(
  state: ControllerState,
  type: string,
  payload: Record<string, unknown>,
): ControllerState {
  return reduce(state, event(state, type, payload))
}

function admit(state: ControllerState, candidateId = 'candidate-a'): ControllerState {
  return apply(state, 'candidate.admitted', {
    candidateId,
    canonicalParent: null,
    donorCandidates: [],
  })
}

describe('reducer protocol invariants', () => {
  it('rejects unknown actions and lifecycle skips', () => {
    const genesis = genesisState()
    expect(() => apply(genesis, 'action.committed', { actionId: 'missing' })).toThrow(
      /unknown action/,
    )

    const planned = apply(genesis, 'action.planned', {
      actionId: 'eval-1',
      kind: 'evaluation',
      idempotencyKey: 'key-1',
    })
    expect(() => apply(planned, 'action.committed', { actionId: 'eval-1' })).toThrow(
      /PLANNED -> COMMITTED/,
    )
  })

  it('prevents terminal actions from moving backwards', () => {
    let state = apply(genesisState(), 'action.planned', {
      actionId: 'eval-1',
      kind: 'evaluation',
      idempotencyKey: 'key-1',
    })
    state = apply(state, 'action.reserved', { actionId: 'eval-1' })
    state = apply(state, 'action.launched', {
      actionId: 'eval-1',
      externalJobId: 'job-1',
    })
    state = apply(state, 'action.committed', { actionId: 'eval-1' })

    expect(() => apply(state, 'action.running', { actionId: 'eval-1' })).toThrow(
      /COMMITTED -> RUNNING/,
    )
  })

  it('keeps action identity fields immutable across transitions', () => {
    let state = apply(genesisState(), 'action.planned', {
      actionId: 'eval-1',
      kind: 'evaluation',
      idempotencyKey: 'key-1',
    })
    expect(() =>
      apply(state, 'action.reserved', {
        actionId: 'eval-1',
        idempotencyKey: 'key-2',
      }),
    ).toThrow(/idempotency key changed/)

    state = apply(state, 'action.reserved', { actionId: 'eval-1' })
    state = apply(state, 'action.launched', {
      actionId: 'eval-1',
      externalJobId: 'job-1',
    })
    expect(() =>
      apply(state, 'action.collecting', {
        actionId: 'eval-1',
        externalJobId: 'job-2',
      }),
    ).toThrow(/external job id changed/)
  })

  it('rejects duplicate or dangling candidate lineage', () => {
    const admitted = admit(genesisState())
    expect(() => admit(admitted)).toThrow(/duplicate candidate admission/)
    expect(() =>
      apply(admitted, 'candidate.admitted', {
        candidateId: 'candidate-b',
        canonicalParent: 'missing-parent',
        donorCandidates: [],
      }),
    ).toThrow(/lineage parent is unknown/)
    expect(() =>
      apply(admitted, 'candidate.dev_observed', { candidateId: 'missing-candidate' }),
    ).toThrow(/unknown candidate/)
  })

  it('rejects unknown, malformed, and duplicate observations', () => {
    const genesis = genesisState()
    expect(() =>
      apply(genesis, 'evaluation.observed', {
        candidateId: 'missing',
        taskId: 'task-1',
        attemptIndex: 0,
        status: 'pass',
        reward: 1,
      }),
    ).toThrow(/unknown candidate/)

    const admitted = admit(genesis)
    expect(() =>
      apply(admitted, 'evaluation.observed', {
        candidateId: 'candidate-a',
        taskId: 'task-1',
        attemptIndex: 0,
        status: 'pass',
        reward: 0,
      }),
    ).toThrow(/pass observation requires reward/)

    const observed = apply(admitted, 'evaluation.observed', {
      candidateId: 'candidate-a',
      taskId: 'task-1',
      attemptIndex: 0,
      status: 'pass',
      reward: 1,
    })
    expect(() =>
      apply(observed, 'evaluation.observed', {
        candidateId: 'candidate-a',
        taskId: 'task-1',
        attemptIndex: 0,
        status: 'pass',
        reward: 1,
      }),
    ).toThrow(/duplicate observation/)
  })

  it('enforces monotonic run phases and sealed-data ordering', () => {
    const preflight = apply(genesisState(), 'run.preflight', {})
    const searching = apply(preflight, 'run.searching', {})

    expect(() => apply(searching, 'run.preflight', {})).toThrow(/cannot follow SEARCHING/)
    expect(() => apply(searching, 'sealed.revealed', {})).toThrow(/cannot follow SEARCHING/)
    expect(() => apply(searching, 'sealed.accessed', {})).toThrow(/before reveal/)

    const locked = apply(searching, 'candidate.locked', {})
    const revealed = apply(locked, 'sealed.revealed', {})
    const terminal = apply(revealed, 'run.terminal', {})
    expect(() => apply(terminal, 'candidate.admitted', {
      candidateId: 'late',
      canonicalParent: null,
      donorCandidates: [],
    })).toThrow(/cannot mutate a TERMINAL run/)
  })

  it('accepts the complete valid controller lifecycle', () => {
    let state = apply(genesisState(), 'run.preflight', {})
    state = admit(state, 'baseline')
    state = apply(state, 'run.searching', {})
    state = apply(state, 'action.planned', {
      actionId: 'eval-1',
      kind: 'evaluation',
      idempotencyKey: 'key-1',
    })
    state = apply(state, 'action.reserved', { actionId: 'eval-1' })
    state = apply(state, 'action.launched', {
      actionId: 'eval-1',
      externalJobId: 'job-1',
    })
    state = apply(state, 'action.collecting', {
      actionId: 'eval-1',
      externalJobId: 'job-1',
    })
    state = apply(state, 'evaluation.observed', {
      candidateId: 'baseline',
      taskId: 'task-1',
      attemptIndex: 0,
      status: 'pass',
      reward: 1,
    })
    state = apply(state, 'action.committed', {
      actionId: 'eval-1',
      externalJobId: 'job-1',
    })
    state = apply(state, 'candidate.dev_observed', { candidateId: 'baseline' })
    state = apply(state, 'candidate.locked', {})
    state = apply(state, 'sealed.revealed', {})
    state = apply(state, 'sealed.accessed', {})
    state = apply(state, 'run.terminal', {})

    expect(state.runPhase).toBe('TERMINAL')
    expect(state.actions['eval-1']?.status).toBe('COMMITTED')
    expect(state.candidates['baseline']?.status).toBe('DEV_OBSERVED')
    expect(state.observations).toHaveLength(1)
    expect(state.sealedAccessCount).toBe(1)
  })
})
