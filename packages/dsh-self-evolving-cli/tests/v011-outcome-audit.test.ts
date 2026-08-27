/**
 * Mechanism-outcome content validation contract (issue #85).
 *
 * Filename counts prove nothing: each generation's record must parse against
 * the official schema and carry bound identities; the set must be exactly
 * generations 1-3 with no duplicates or strays.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifyMechanismOutcomes } from '../src/v011-audit.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'v011-outcome-audit-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function seedOutcome(generation: string, body: unknown): Promise<void> {
  const dir = join(root!, 'v011', 'outcomes', generation)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'outcome.json'), JSON.stringify(body, null, 2) + '\n')
}

const valid = {
  schemaVersion: 1,
  idempotencyKey: 'sha256:' + '1'.repeat(64),
  proposalDigest: 'sha256:' + '2'.repeat(64),
  hypothesisDigest: 'sha256:' + '3'.repeat(64),
  candidateDigest: 'sha256:' + '4'.repeat(64),
  targetClusterSlug: 'cluster',
  targetTaskHandle: 'task',
  trialRefs: ['sha256:' + '5'.repeat(64)],
  targetTrials: 1,
  preservationTrials: 1,
  status: 'MECHANISM_CONFIRMED',
  singleTrialObservable: true,
}

describe('mechanism-outcome content validation (issue #85)', () => {
  it('flags an empty generation-3 outcome file', async () => {
    await seedOutcome('generation-1', valid)
    await seedOutcome('generation-2', valid)
    await seedOutcome('generation-3', {})
    const reasons = await verifyMechanismOutcomes(root!)
    expect(reasons.join('\n')).toMatch(/generation-3 fails its schema/)
  })

  it('flags a stray fourth outcome directory', async () => {
    for (const generation of ['generation-1', 'generation-2', 'generation-3']) {
      await seedOutcome(generation, valid)
    }
    await seedOutcome('generation-9', valid)
    const reasons = await verifyMechanismOutcomes(root!)
    expect(reasons.join('\n')).toMatch(/unexpected path/)
  })

  it('flags a record missing bound identities', async () => {
    await seedOutcome('generation-1', valid)
    await seedOutcome('generation-2', valid)
    await seedOutcome('generation-3', { ...valid, idempotencyKey: 'garbage' })
    const reasons = await verifyMechanismOutcomes(root!)
    expect(reasons.join('\n')).toMatch(/lacks a bound identity/)
  })
})
