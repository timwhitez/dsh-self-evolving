/** Proposer-visible Archive projection derived exclusively from DEV_OBSERVED. */
import { createHash } from 'node:crypto'
import type { DataLabel } from '../object-store/index.js'
import type { CandidateNode } from '../reducer/index.js'

export interface LabeledCatalogObservation {
  label: DataLabel
  candidateId: string
  taskId: string
  attemptIndex: number
  reward: 0 | 1
  evidenceDigest: string
}

export interface ArchiveCatalogCandidate {
  candidateId: string
  canonicalParent: string | null
  donorCandidates: string[]
  status: CandidateNode['status']
  successes: number
  failures: number
  devObservationCount: number
  rawEvidenceDigests: string[]
}

export interface ArchiveCatalog {
  schemaVersion: 1
  sourceLabel: 'DEV_OBSERVED'
  candidates: ArchiveCatalogCandidate[]
  catalogHash: string
}

/**
 * Guarded/sealed inputs have zero influence on returned bytes: they are not
 * counted, named, hashed, or represented by an excluded-count side channel.
 */
export function buildArchiveCatalog(input: {
  candidates: CandidateNode[]
  observations: LabeledCatalogObservation[]
}): ArchiveCatalog {
  const candidates = [...input.candidates]
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId))
    .map<ArchiveCatalogCandidate>((candidate) => ({
      candidateId: candidate.candidateId,
      canonicalParent: candidate.canonicalParent,
      donorCandidates: [...candidate.donorCandidates].sort(),
      status: candidate.status,
      successes: 0,
      failures: 0,
      devObservationCount: 0,
      rawEvidenceDigests: [],
    }))
  const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]))
  const seen = new Set<string>()
  const development = input.observations
    .filter((observation) => observation.label === 'DEV_OBSERVED')
    .sort((left, right) => {
      const leftKey = `${left.candidateId}\0${left.taskId}\0${left.attemptIndex}`
      const rightKey = `${right.candidateId}\0${right.taskId}\0${right.attemptIndex}`
      return leftKey.localeCompare(rightKey)
    })

  for (const observation of development) {
    const candidate = byId.get(observation.candidateId)
    if (candidate === undefined) {
      throw new Error(
        `archive catalog: observation references unknown candidate ${observation.candidateId}`,
      )
    }
    if (!/^[0-9a-f]{64}$/.test(observation.evidenceDigest)) {
      throw new Error('archive catalog: evidence digest must be sha256 hex')
    }
    if (observation.reward !== 0 && observation.reward !== 1) {
      throw new Error('archive catalog: reward must be binary')
    }
    const key = `${observation.candidateId}/${observation.taskId}/${observation.attemptIndex}`
    if (seen.has(key)) throw new Error(`archive catalog: duplicate development observation ${key}`)
    seen.add(key)
    candidate.devObservationCount += 1
    if (observation.reward === 1) candidate.successes += 1
    else candidate.failures += 1
    candidate.rawEvidenceDigests.push(observation.evidenceDigest)
  }
  for (const candidate of candidates) candidate.rawEvidenceDigests.sort()

  const body = { schemaVersion: 1 as const, sourceLabel: 'DEV_OBSERVED' as const, candidates }
  return {
    ...body,
    catalogHash: `sha256:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`,
  }
}
