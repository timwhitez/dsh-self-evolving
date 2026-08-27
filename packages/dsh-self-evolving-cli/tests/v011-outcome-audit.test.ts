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
import { deriveMechanismOutcome } from '@dsh-self-evolving/core'

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

// A REAL record from the trusted writer, so the control test proves genuine
// output is accepted (review of #211).
const valid = await deriveMechanismOutcome({
  proposalDigest: ('sha256:' + '2'.repeat(64)) as `sha256:${string}`,
  hypothesis: 'hypothesis of sufficient length',
  candidateDigest: ('sha256:' + '4'.repeat(64)) as `sha256:${string}`,
  targetClusterSlug: 'cluster',
  targetTaskHandle: 'task-1',
  trials: [
    {
      ref: ('sha256:' + '5'.repeat(64)) as `sha256:${string}`,
      role: 'target-baseline',
      status: 'fail',
      reward: 0,
      taskId: 'task-1',
      attemptIndex: 0,
    },
    {
      ref: ('sha256:' + '6'.repeat(64)) as `sha256:${string}`,
      role: 'target-child',
      status: 'pass',
      reward: 1,
      taskId: 'task-1',
      attemptIndex: 0,
    },
    {
      ref: ('sha256:' + '7'.repeat(64)) as `sha256:${string}`,
      role: 'preservation-baseline',
      status: 'pass',
      reward: 1,
      taskId: 'task-2',
      attemptIndex: 0,
    },
    {
      ref: ('sha256:' + '8'.repeat(64)) as `sha256:${string}`,
      role: 'preservation-child',
      status: 'pass',
      reward: 1,
      taskId: 'task-2',
      attemptIndex: 0,
    },
  ],
})

describe('mechanism-outcome content validation (issue #85)', () => {
  it('accepts a genuine writer-produced matrix', async () => {
    for (const generation of ['generation-1', 'generation-2', 'generation-3']) {
      await seedOutcome(generation, valid)
    }
    expect(await verifyMechanismOutcomes(root!)).toEqual([])
  })

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
