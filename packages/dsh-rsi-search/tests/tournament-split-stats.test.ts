/**
 * Tournament + split ceremony + sealed info-flow + bootstrap stats tests
 * (spec 03 §11, spec 04 §3/§5, spec 05 §4).
 */
import { describe, expect, it } from 'vitest'
import {
  buildShortlist,
  lockChampion,
  commitSplit,
  verifySplit,
  assertNoSealedLeak,
  assertNotLocked,
  SPLIT_SIZES,
  pairedBootstrapCi,
  classifyPromotion,
  type ArchiveView,
  type NodeUtility,
  type SplitAssignment,
} from '../src/index.js'

function view(nodes: NodeUtility[]): ArchiveView {
  return { nodes, observations: [] }
}

describe('shortlist tournament (spec 03 §11)', () => {
  it('ranks by clade CMP descending', () => {
    const baseline: NodeUtility = {
      candidateId: 'baseline',
      canonicalParent: null,
      donorCandidates: [],
      s: 0,
      f: 0,
    }
    const good: NodeUtility = {
      candidateId: 'good',
      canonicalParent: 'baseline',
      donorCandidates: [],
      s: 5,
      f: 1,
    }
    const ok: NodeUtility = {
      candidateId: 'ok',
      canonicalParent: 'baseline',
      donorCandidates: [],
      s: 2,
      f: 2,
    }
    const v = view([baseline, good, ok])
    const sl = buildShortlist(v, {
      ...{ K: 80, q0: 3, alpha: 0.6, tau: 1, waveSize: 4, shortlistSize: 5 },
    })
    expect(sl[0]!.candidateId).toBe('good') // CMP 5/6 ≈ 0.83
    expect(sl[1]!.candidateId).toBe('ok') // CMP 2/4 = 0.5
    expect(sl[0]!.rank).toBe(1)
  })

  it('lockChampion returns the rank-1 candidate', () => {
    const sl = [{ candidateId: 'x', cmp: 0.9, s: 9, f: 1, rank: 1 }]
    const res = lockChampion(sl)
    expect(res.championId).toBe('x')
    expect(res.outcome).toBe('DEVELOPMENT_CHAMPION')
  })

  it('lockChampion reports NO_DEVELOPMENT_IMPROVEMENT on empty/undefined shortlist', () => {
    expect(lockChampion([]).outcome).toBe('NO_DEVELOPMENT_IMPROVEMENT')
    expect(lockChampion([{ candidateId: 'y', cmp: undefined, s: 0, f: 0, rank: 1 }]).outcome).toBe(
      'NO_DEVELOPMENT_IMPROVEMENT',
    )
  })
})

describe('split ceremony (spec 04 §3)', () => {
  function makeAssignment(): SplitAssignment[] {
    const tasks: SplitAssignment[] = []
    for (let i = 0; i < SPLIT_SIZES.devObserved; i++)
      tasks.push({ taskId: `t${i}`, label: 'dev-observed' })
    for (let i = 0; i < SPLIT_SIZES.devGuard; i++)
      tasks.push({ taskId: `g${i}`, label: 'dev-guard' })
    for (let i = 0; i < SPLIT_SIZES.sealed; i++) tasks.push({ taskId: `s${i}`, label: 'sealed' })
    return tasks
  }

  it('commits a 48/12/29 split with a Merkle root', () => {
    const commitment = commitSplit(makeAssignment(), 'sha256:seed-commitment')
    expect(commitment.sizes.devObserved).toBe(48)
    expect(commitment.sizes.devGuard).toBe(12)
    expect(commitment.sizes.sealed).toBe(29)
    expect(commitment.merkleRoot).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('verifySplit accepts the matching assignment', () => {
    const a = makeAssignment()
    const c = commitSplit(a, 'sha256:seed')
    expect(verifySplit(c, a)).toBe(true)
  })

  it('verifySplit rejects a tampered assignment (swapped label)', () => {
    const a = makeAssignment()
    const c = commitSplit(a, 'sha256:seed')
    a[0]!.label = 'sealed' // corrupt
    expect(verifySplit(c, a)).toBe(false)
  })

  it('commitSplit rejects wrong sizes', () => {
    const bad = makeAssignment().slice(0, 47) // too few dev-observed
    bad.push(
      ...Array.from({ length: 1 }, (_, i) => ({ taskId: `x${i}`, label: 'dev-observed' as const })),
    )
    // now 48 dev-observed? No — sliced to 47 then +1 = 48, but original 48 dev-observed sliced to 47.
    // Simpler: build a definitely-wrong one.
    const wrong: SplitAssignment[] = [{ taskId: 'only', label: 'dev-observed' }]
    expect(() => commitSplit(wrong, 'sha256:seed')).toThrow(/dev-observed count/)
  })
})

describe('sealed info-flow guard (spec 05 §4)', () => {
  it('aborts when a non-sealed principal accesses a sealed resource before reveal', () => {
    expect(() => assertNoSealedLeak('selector:act1', 'sealed', false)).toThrow(
      /INFORMATION_FLOW_VIOLATION/,
    )
    expect(() => assertNoSealedLeak('proposer:act1', 'sealed', false)).toThrow(
      /INFORMATION_FLOW_VIOLATION/,
    )
  })

  it('allows a sealed principal to access sealed resources', () => {
    expect(() => assertNoSealedLeak('sealed:reveal-service', 'sealed', false)).not.toThrow()
  })

  it('allows any principal after the single reveal', () => {
    expect(() => assertNoSealedLeak('selector:act1', 'sealed', true)).not.toThrow()
  })

  it('allows non-sealed resources regardless', () => {
    expect(() => assertNoSealedLeak('proposer:act1', 'dev-observed', false)).not.toThrow()
    expect(() => assertNoSealedLeak('selector:act1', 'dev-guard', false)).not.toThrow()
  })
})

describe('candidate lock (spec 03, spec 06)', () => {
  it('refuses selector/proposer after lock', () => {
    expect(() => assertNotLocked(true, 'selectParent')).toThrow(/LOCKED/)
    expect(() => assertNotLocked(true, 'propose')).toThrow(/LOCKED/)
  })
  it('allows before lock', () => {
    expect(() => assertNotLocked(false, 'selectParent')).not.toThrow()
  })
})

describe('paired cluster-bootstrap CI (spec 04 §5)', () => {
  it('a clear +10pp lift with all-positive deltas → promoted, CI lower > 0', () => {
    // 29 tasks; candidate wins 20, ties 9, loses 0.
    const trials = Array.from({ length: 29 }, (_, i) => ({
      taskId: `s${i}`,
      baselineReward: i < 9 ? 1 : 0,
      candidateReward: 1,
    }))
    const res = pairedBootstrapCi(trials, { nResamples: 2000, masterSeed: 1n })
    expect(res.delta).toBeGreaterThan(0.05)
    expect(res.ci95[0]).toBeGreaterThan(0)
    expect(res.promoted).toBe(true)
    expect(classifyPromotion(res)).toBe('SEALED_PROMOTED')
  })

  it('a near-zero lift → not promoted', () => {
    const trials = Array.from({ length: 29 }, (_, i) => ({
      taskId: `s${i}`,
      baselineReward: i % 2 === 0 ? 1 : 0,
      candidateReward: i % 2 === 0 ? 1 : 0, // identical → delta 0
    }))
    const res = pairedBootstrapCi(trials, { nResamples: 1000, masterSeed: 2n })
    expect(res.delta).toBeCloseTo(0, 6)
    expect(res.promoted).toBe(false)
    expect(classifyPromotion(res)).toBe('SEALED_REJECTED')
  })

  it('is deterministic for a fixed seed', () => {
    const trials = Array.from({ length: 29 }, (_, i) => ({
      taskId: `s${i}`,
      baselineReward: 0,
      candidateReward: i < 15 ? 1 : 0,
    }))
    const a = pairedBootstrapCi(trials, { nResamples: 1000, masterSeed: 99n })
    const b = pairedBootstrapCi(trials, { nResamples: 1000, masterSeed: 99n })
    expect(a.ci95).toEqual(b.ci95)
    expect(a.delta).toBe(b.delta)
  })
})
