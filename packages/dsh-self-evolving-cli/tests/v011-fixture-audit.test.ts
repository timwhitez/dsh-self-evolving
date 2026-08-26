/**
 * Invalid-replacement fixture audit contract (issue #113).
 *
 * The acceptance component may not be satisfied by a free-standing
 * synthesized rejection file: the fixture must be a real reproducible
 * negative action whose retained artifacts replay through the same trusted
 * validator with matching digests.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifyInvalidReplacementFixture } from '../src/v011-audit.js'
import type { V011DemoConfig } from '../src/config.js'
import { assertV011, digestV011 } from '@dsh-self-evolving/candidate-sdk'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'v011-fixture-audit-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function sha(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function config(): V011DemoConfig {
  return {
    runId: 'fixture-audit-run',
    stateDir: root!,
    repoRoot: root!,
    codeCommit: 'a'.repeat(40),
  } as unknown as V011DemoConfig
}

function diagnosticTail(message: string): string {
  return message.slice(0, 400)
}

async function realFixture(action: string, runId: string): Promise<void> {
  await mkdir(action, { recursive: true, mode: 0o700 })
  const proposalBytes =
    JSON.stringify(
      {
        schemaVersion: 2,
        proposalId: 'p-fixture',
        canonicalParentDigest: 'sha256:' + 'a'.repeat(64),
        evidenceExport: { manifestDigest: 'sha256:' + 'b'.repeat(64) },
      },
      null,
      2,
    ) + '\n'
  const analysisBytes =
    JSON.stringify(
      {
        schemaVersion: 1,
        failureClusters: [],
        ancestorReconciliations: [],
        selectedCluster: 'fixture-invalid-cluster',
        falsifiableHypothesis: 'fixture hypothesis',
        expectedBehaviorChange: 'none',
        regressionRisks: [],
      },
      null,
      2,
    ) + '\n'
  let reason: string
  try {
    await assertV011('analysis', JSON.parse(analysisBytes))
    throw new Error('fixture unexpectedly validated')
  } catch (error) {
    reason = error instanceof Error ? error.message : 'unknown'
  }
  await writeFile(join(action, 'invalid-fixture-proposal.json'), proposalBytes)
  await writeFile(join(action, 'invalid-fixture-analysis.json'), analysisBytes)
  await writeFile(
    join(action, 'rejection.json'),
    JSON.stringify(
      {
        schemaVersion: 2,
        classification: 'FIXTURE_VALIDATOR_REJECT',
        validator: 'assertV011:analysis',
        fixtureProposalDigest: digestV011(proposalBytes),
        fixtureAnalysisDigest: digestV011(analysisBytes),
        reasonDigest: sha(reason),
        reason: diagnosticTail(reason),
        binding: {
          runId,
          proposalId: 'p-fixture',
          parentDigest: 'sha256:' + 'a'.repeat(64),
          exportManifestDigest: 'sha256:' + 'b'.repeat(64),
        },
        retained: true,
        replacedBy: `${runId}/proposal/1/1`,
      },
      null,
      2,
    ) + '\n',
  )
}

describe('invalid-replacement fixture audit (issue #113)', () => {
  it('accepts a real digest-bound, replayable fixture record', async () => {
    await realFixture(join(root!, 'v011', 'actions', 'proposal-1-1'), 'fixture-audit-run')
    const reasons = await verifyInvalidReplacementFixture(config())
    expect(reasons).toEqual([])
  })

  it('rejects a pre-created synthetic two-field file', async () => {
    const action = join(root!, 'v011', 'actions', 'proposal-1-1')
    await mkdir(action, { recursive: true, mode: 0o700 })
    await writeFile(
      join(action, 'rejection.json'),
      JSON.stringify({
        schemaVersion: 1,
        classification: 'UNDECLARED_OUTPUT_FIXTURE',
        retained: true,
      }) + '\n',
    )
    const reasons = await verifyInvalidReplacementFixture(config())
    expect(reasons.join('\n')).toMatch(/not digest-bound|not retained/)
  })

  it('rejects a digest-bound fixture whose reason is not reproducible', async () => {
    await realFixture(join(root!, 'v011', 'actions', 'proposal-1-1'), 'fixture-audit-run')
    const path = join(root!, 'v011', 'actions', 'proposal-1-1', 'rejection.json')
    const record = JSON.parse(await readFileText(path)) as { reasonDigest: string }
    record.reasonDigest = sha('a different validator outcome')
    await writeFile(path, JSON.stringify(record, null, 2) + '\n')
    const reasons = await verifyInvalidReplacementFixture(config())
    expect(reasons.join('\n')).toMatch(/reason is not reproducible/)
  })

  it('rejects a fixture from a different run binding', async () => {
    await realFixture(join(root!, 'v011', 'actions', 'proposal-1-1'), 'OTHER-RUN')
    const reasons = await verifyInvalidReplacementFixture(config())
    expect(reasons.join('\n')).toMatch(/not digest-bound/)
  })
})

function readFileText(path: string): Promise<string> {
  return import('node:fs/promises').then((fs) => fs.readFile(path, 'utf8'))
}
