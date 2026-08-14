/**
 * Shortlist tournament + deterministic downgrade (spec 03 §11).
 *
 * The development tournament ranks admitted candidates by clade CMP to pick a
 * single development champion. When fewer than shortlistSize candidates have
 * enough trials to be rankable, the downgrade path is deterministic (not
 * reward-steered): it fills the shortlist by clade-CMP then by candidate id.
 */
import { cladeCMP, type ArchiveView, type SearchParams } from './scheduler.js'

export interface ShortlistEntry {
  candidateId: string
  cmp: number | undefined
  s: number
  f: number
  rank: number
}

/**
 * Build the development shortlist. Deterministic order:
 *   1. defined CMP descending;
 *   2. undefined-CMP nodes by candidateId ascending (deterministic tiebreak).
 */
export function buildShortlist(view: ArchiveView, params: SearchParams): ShortlistEntry[] {
  const eligible = view.nodes.filter((n) => n.canonicalParent !== null || n.s + n.f > 0)
  const entries: ShortlistEntry[] = eligible.map((n) => {
    const c = cladeCMP(view, n.candidateId)
    return { candidateId: n.candidateId, cmp: c.cmp, s: c.s, f: c.f, rank: 0 }
  })
  entries.sort((a, b) => {
    // defined CMP beats undefined.
    if (a.cmp !== undefined && b.cmp === undefined) return -1
    if (a.cmp === undefined && b.cmp !== undefined) return 1
    if (a.cmp !== undefined && b.cmp !== undefined) {
      if (b.cmp !== a.cmp) return b.cmp - a.cmp
    }
    // deterministic tiebreak: candidate id ascending.
    return a.candidateId.localeCompare(b.candidateId)
  })
  const shortlist = entries.slice(0, params.shortlistSize)
  shortlist.forEach((e, i) => {
    e.rank = i + 1
  })
  return shortlist
}

/**
 * Lock the unique development champion: the rank-1 entry. If the shortlist is
 * empty, returns NO_DEVELOPMENT_IMPROVEMENT (reported honestly, not invented).
 */
export function lockChampion(shortlist: ShortlistEntry[]): {
  championId: string | null
  outcome: 'DEVELOPMENT_CHAMPION' | 'NO_DEVELOPMENT_IMPROVEMENT'
} {
  if (shortlist.length === 0 || shortlist[0]!.cmp === undefined) {
    return { championId: null, outcome: 'NO_DEVELOPMENT_IMPROVEMENT' }
  }
  return { championId: shortlist[0]!.candidateId, outcome: 'DEVELOPMENT_CHAMPION' }
}
