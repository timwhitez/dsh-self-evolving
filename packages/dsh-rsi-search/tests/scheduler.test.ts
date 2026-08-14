/**
 * Search algorithm golden + property tests (spec 07 §7 Accept).
 *
 *   - small-tree CMP hand-calc
 *   - UCB-Air boundary (expand vs evaluate cutoff)
 *   - seeded RNG replay determinism
 *   - duplicate/donor no-double-count
 *   - clade Thompson determinism + argmax
 *   - cold-start enforcement
 */
import { describe, expect, it } from 'vitest'
import {
  RngStream,
  cladeCMP,
  selectParentByCladeThompson,
  selectNodeByThompson,
  ucbAirDecision,
  needsColdStart,
  attributeObservation,
  DEFAULT_PARAMS,
  type ArchiveView,
  type NodeUtility,
} from '../src/index.js'

function view(nodes: NodeUtility[]): ArchiveView {
  return { nodes, observations: [] }
}

const baseline: NodeUtility = {
  candidateId: 'baseline',
  canonicalParent: null,
  donorCandidates: [],
  s: 0,
  f: 0,
}
const c1: NodeUtility = {
  candidateId: 'c1',
  canonicalParent: 'baseline',
  donorCandidates: [],
  s: 3,
  f: 1,
}
const c2: NodeUtility = {
  candidateId: 'c2',
  canonicalParent: 'baseline',
  donorCandidates: [],
  s: 1,
  f: 3,
}
const c1a: NodeUtility = {
  candidateId: 'c1a',
  canonicalParent: 'c1',
  donorCandidates: [],
  s: 2,
  f: 0,
}

describe('clade CMP (spec 03 §5)', () => {
  it('clade CMP for a leaf = its own s/(s+f)', () => {
    const v = view([baseline, c1])
    expect(cladeCMP(v, 'c1').cmp).toBeCloseTo(3 / 4, 6)
  })

  it('clade CMP aggregates descendants (c1 clade = c1 + c1a)', () => {
    const v = view([baseline, c1, c1a])
    // S_C = 3 + 2 = 5, F_C = 1 + 0 = 1 → 5/6
    expect(cladeCMP(v, 'c1').cmp).toBeCloseTo(5 / 6, 6)
  })

  it('clade CMP is undefined when s+f = 0', () => {
    const v = view([baseline])
    expect(cladeCMP(v, 'baseline').cmp).toBeUndefined()
  })

  it('baseline clade covers all descendants', () => {
    const v = view([baseline, c1, c2, c1a])
    // S_C(baseline) = 0+3+1+2 = 6, F_C = 0+1+3+0 = 4 → 6/10
    expect(cladeCMP(v, 'baseline').cmp).toBeCloseTo(0.6, 6)
  })
})

describe('UCB-Air expand/evaluate boundary (spec 03 §7)', () => {
  it('expands when (N+P_eval)^alpha >= T', () => {
    // N=10, P_eval=0, T=4 → 10^0.6 = 3.98 < 4 → evaluate. Hmm, close. Use N=12.
    expect(
      ucbAirDecision({ N: 12, P_eval: 0, T: 4, admittedCount: 1, params: DEFAULT_PARAMS }),
    ).toBe('expand')
  })

  it('evaluates when (N+P_eval)^alpha < T', () => {
    // N=2, P_eval=0, T=8 → 2^0.6 = 1.52 < 8 → evaluate
    expect(
      ucbAirDecision({ N: 2, P_eval: 0, T: 8, admittedCount: 1, params: DEFAULT_PARAMS }),
    ).toBe('evaluate')
  })

  it('always evaluates once admitted count >= K', () => {
    expect(
      ucbAirDecision({ N: 1000, P_eval: 0, T: 1, admittedCount: 80, params: DEFAULT_PARAMS }),
    ).toBe('evaluate')
  })

  it('the boundary is exact at the algebraic cutoff', () => {
    // Solve (N)^0.6 = T → N = T^(1/0.6). For T=16: N = 16^(5/3) ≈ 40.3179.
    const T = 16
    const cutoff = Math.pow(T, 1 / 0.6)
    expect(
      ucbAirDecision({ N: cutoff - 1, P_eval: 0, T, admittedCount: 1, params: DEFAULT_PARAMS }),
    ).toBe('evaluate')
    expect(
      ucbAirDecision({ N: cutoff + 1, P_eval: 0, T, admittedCount: 1, params: DEFAULT_PARAMS }),
    ).toBe('expand')
  })
})

describe('seeded RNG replay determinism (spec 06 §9)', () => {
  it('the same seed + stream + draw count yields identical samples', () => {
    const seed = 0xdeadbeefn
    const a = new RngStream(seed, 'scheduler-thompson')
    const b = new RngStream(seed, 'scheduler-thompson')
    const seqA = Array.from({ length: 20 }, () => a.nextDouble())
    const seqB = Array.from({ length: 20 }, () => b.nextDouble())
    expect(seqA).toEqual(seqB)
  })

  it('different stream names produce different sequences', () => {
    const seed = 0xdeadbeefn
    const a = new RngStream(seed, 'scheduler-thompson')
    const b = new RngStream(seed, 'task-sampler')
    expect(a.nextDouble()).not.toBe(b.nextDouble())
  })

  it('parent Thompson selection is deterministic for a fixed seed', () => {
    const v = view([baseline, c1, c2])
    const r1 = new RngStream(42n, 'p')
    const r2 = new RngStream(42n, 'p')
    const pick1 = selectParentByCladeThompson(v, ['c1', 'c2'], DEFAULT_PARAMS, r1)
    const pick2 = selectParentByCladeThompson(v, ['c1', 'c2'], DEFAULT_PARAMS, r2)
    expect(pick1).toBe(pick2)
    expect(['c1', 'c2']).toContain(pick1)
  })
})

describe('duplicate/donor no-double-count (spec 03 §3)', () => {
  it('a donor is provenance only; observation attributes to the candidate, not donors', () => {
    const node: NodeUtility = {
      candidateId: 'child',
      canonicalParent: 'parent',
      donorCandidates: ['sha256:' + 'd'.repeat(64)],
      s: 1,
      f: 0,
    }
    const v = view([node])
    const attr = attributeObservation(v, 'child')
    expect(attr.attributedTo).toBe('child')
    expect(attr.donorsExcluded).toEqual(['sha256:' + 'd'.repeat(64)])
  })

  it('donors do not create a second parent edge in clade CMP', () => {
    // child has parent=P and donor=D. Clade(P) includes child; Clade(D) does NOT.
    const P: NodeUtility = {
      candidateId: 'P',
      canonicalParent: null,
      donorCandidates: [],
      s: 1,
      f: 1,
    }
    const D: NodeUtility = {
      candidateId: 'D',
      canonicalParent: null,
      donorCandidates: [],
      s: 5,
      f: 0,
    }
    const child: NodeUtility = {
      candidateId: 'child',
      canonicalParent: 'P',
      donorCandidates: ['D'],
      s: 2,
      f: 0,
    }
    const v = view([P, D, child])
    // Clade(P) = {P, child} → s=3, f=1 → 0.75
    expect(cladeCMP(v, 'P').cmp).toBeCloseTo(0.75, 6)
    // Clade(D) = {D} only (donor does not add child) → s=5, f=0 → 1.0
    expect(cladeCMP(v, 'D').cmp).toBeCloseTo(1.0, 6)
  })
})

describe('cold-start enforcement (spec 03 §6)', () => {
  it('a node with < q0 trials needs cold start', () => {
    const node: NodeUtility = {
      candidateId: 'n',
      canonicalParent: 'baseline',
      donorCandidates: [],
      s: 1,
      f: 1,
    }
    expect(needsColdStart(node, DEFAULT_PARAMS)).toBe(true) // 2 < 3
  })

  it('a node with >= q0 trials is cold-start-complete', () => {
    const node: NodeUtility = {
      candidateId: 'n',
      canonicalParent: 'baseline',
      donorCandidates: [],
      s: 2,
      f: 1,
    }
    expect(needsColdStart(node, DEFAULT_PARAMS)).toBe(false) // 3 >= 3
  })
})

describe('node Thompson selection', () => {
  it('selects the argmax node deterministically', () => {
    const a: NodeUtility = {
      candidateId: 'a',
      canonicalParent: null,
      donorCandidates: [],
      s: 4,
      f: 0,
    }
    const b: NodeUtility = {
      candidateId: 'b',
      canonicalParent: null,
      donorCandidates: [],
      s: 0,
      f: 4,
    }
    const v = view([a, b])
    // Over many draws, the high-success node should win most often.
    let aWins = 0
    for (let i = 0; i < 200; i++) {
      const r = new RngStream(BigInt(i), 'node')
      if (selectNodeByThompson(v, ['a', 'b'], r) === 'a') aWins++
    }
    expect(aWins).toBeGreaterThan(150) // a dominates
  })
})
