import { describe, expect, it } from 'vitest'
import { genesisState, reduce, type ControllerState, type JournalEvent } from '../src/index.js'

function event(
  state: ControllerState,
  type: string,
  payload: Record<string, unknown>,
): JournalEvent {
  const seq = state.lastSeq + 1
  return {
    schemaVersion: 1,
    runId: 'reducer-invariants-v2',
    seq,
    eventId: `${type}:${seq}`,
    occurredAt: '2026-08-25T00:00:00.000Z',
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

function admit(
  state: ControllerState,
  candidateId = 'candidate-a',
  canonicalParent: string | null = null,
  donorCandidates: string[] = [],
): ControllerState {
  return apply(state, 'candidate.admitted', {
    candidateId,
    canonicalParent,
    donorCandidates,
  })
}

describe('reducer protocol state machine', () => {
  it('rejects unknown actions, lifecycle skips, and terminal rollback', () => {
    const genesis = genesisState()
    expect(() => apply(genesis, 'action.committed', { actionId: 'missing' })).toThrow(
      /unknown action/,
    )

    let state = apply(genesis, 'action.planned', {
      actionId: 'eval-1',
      kind: 'evaluation',
      idempotencyKey: 'key-1',
    })
    expect(() => apply(state, 'action.committed', { actionId: 'eval-1' })).toThrow(
      /PLANNED -> COMMITTED/,
    )

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

  it('freezes action kind, idempotency key, and external job identity', () => {
    let state = apply(genesisState(), 'action.planned', {
      actionId: 'eval-1',
      kind: 'evaluation',
      idempotencyKey: 'key-1',
    })
    expect(() =>
      apply(state, 'action.reserved', {
        actionId: 'eval-1',
        kind: 'build',
      }),
    ).toThrow(/kind is immutable/)
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

  it('requires a complete action identity at planning time', () => {
    expect(() =>
      apply(genesisState(), 'action.planned', {
        actionId: 'eval-1',
        kind: 'evaluation',
      }),
    ).toThrow(/idempotencyKey/)
    expect(() =>
      apply(genesisState(), 'action.planned', {
        actionId: 'eval-1',
        kind: 'unknown',
        idempotencyKey: 'key-1',
      }),
    ).toThrow(/valid kind/)
  })

  it('rejects duplicate and dangling candidate lineage', () => {
    const baseline = admit(genesisState(), 'baseline')
    expect(() => admit(baseline, 'baseline')).toThrow(/duplicate candidate admission/)
    expect(() => admit(baseline, 'child', 'missing-parent')).toThrow(/lineage parent is unknown/)
    expect(() => admit(baseline, 'child', 'baseline', ['missing-donor'])).toThrow(
      /donor candidate is unknown/,
    )
    expect(() => admit(baseline, 'child', 'baseline', ['baseline', 'baseline'])).toThrow(
      /duplicate donor candidate/,
    )
    expect(() => admit(baseline, 'child', 'baseline', ['child'])).toThrow(/cannot donate to itself/)
  })

  it('rejects unknown, malformed, inactive, and duplicate observations', () => {
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
        attemptIndex: 0.5,
        status: 'pass',
        reward: 1,
      }),
    ).toThrow(/non-negative safe integer/)
    expect(() =>
      apply(admitted, 'evaluation.observed', {
        candidateId: 'candidate-a',
        taskId: 'task-1',
        attemptIndex: 0,
        status: 'invalid',
        reward: 0,
      }),
    ).toThrow(/null reward/)

    const observed = apply(admitted, 'evaluation.observed', {
      candidateId: 'candidate-a',
      taskId: 'task-1',
      attemptIndex: 0,
      status: 'pass',
      reward: 0.75,
    })
    expect(() =>
      apply(observed, 'evaluation.observed', {
        candidateId: 'candidate-a',
        taskId: 'task-1',
        attemptIndex: 0,
        status: 'fail',
        reward: 0,
      }),
    ).toThrow(/duplicate observation/)

    const archived = apply(admitted, 'candidate.archived', { candidateId: 'candidate-a' })
    expect(() =>
      apply(archived, 'evaluation.observed', {
        candidateId: 'candidate-a',
        taskId: 'task-2',
        attemptIndex: 0,
        status: 'fail',
        reward: 0,
      }),
    ).toThrow(/inactive candidate/)
  })

  it('enforces monotonic run phases, lock closure, and sealed reveal ordering', () => {
    const preflight = apply(genesisState(), 'run.preflight', {})
    const searching = apply(preflight, 'run.searching', {})

    expect(() => apply(searching, 'run.preflight', {})).toThrow(/cannot follow SEARCHING/)
    expect(() => apply(searching, 'sealed.revealed', {})).toThrow(/cannot follow SEARCHING/)
    expect(() => apply(searching, 'sealed.accessed', {})).toThrow(/before reveal/)

    const locked = apply(searching, 'candidate.locked', {})
    expect(() => admit(locked, 'late')).toThrow(/closed after candidate lock/)
    const revealed = apply(locked, 'sealed.revealed', {})
    const terminal = apply(revealed, 'run.terminal', {})
    expect(() => apply(terminal, 'run.searching', {})).toThrow(/cannot follow TERMINAL/)
    expect(() => apply(terminal, 'candidate.archived', { candidateId: 'missing' })).toThrow(
      /cannot mutate a TERMINAL run/,
    )
  })

  it('accepts the complete durable evaluation lifecycle', () => {
    let state = apply(genesisState(), 'run.preflight', {})
    state = admit(state, 'baseline')
    state = apply(state, 'run.searching', {})
    state = apply(state, 'action.planned', {
      actionId: 'eval-1',
      kind: 'evaluation',
      idempotencyKey: 'key-1',
    })
    state = apply(state, 'action.reserved', {
      actionId: 'eval-1',
      idempotencyKey: 'key-1',
    })
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
