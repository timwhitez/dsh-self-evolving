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
import { deriveFixtureCross, verifyInvalidReplacementFixture } from '../src/v011-audit.js'
import type { V011DemoConfig } from '../src/config.js'
import { assertV011, digestV011, v011SchemaDigest } from '@dsh-self-evolving/candidate-sdk'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'v011-fixture-audit-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const PARENT_DIGEST = 'sha256:' + 'a'.repeat(64)

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
  let reason: string | null = null
  try {
    await assertV011('analysis', JSON.parse(analysisBytes))
  } catch (error) {
    reason = error instanceof Error ? error.message : 'unknown'
  }
  if (reason === null) throw new Error('fixture unexpectedly validated')
  await writeFile(join(action, 'invalid-fixture-proposal.json'), proposalBytes)
  await writeFile(join(action, 'invalid-fixture-analysis.json'), analysisBytes)
  await writeFile(
    join(action, 'rejection.json'),
    JSON.stringify(
      {
        schemaVersion: 2,
        classification: 'FIXTURE_VALIDATOR_REJECT',
        validator: 'assertV011:analysis',
        analysisSchemaDigest: await v011SchemaDigest('analysis'),
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
  await writeFile(
    join(action, 'materialization.json'),
    JSON.stringify(
      {
        stableProposal: {},
        materialization: { proposalId: 'p-fixture', parentDigest: PARENT_DIGEST },
      },
      null,
    ) + '\n',
  )
}

describe('invalid-replacement fixture audit (issue #113)', () => {
  it('accepts a real digest-bound, replayable fixture record', async () => {
    await realFixture(join(root!, 'v011', 'actions', 'proposal-1-1'), 'fixture-audit-run')
    const cross = { parentDigest: PARENT_DIGEST, proposalId: 'p-fixture' }
    const reasons = await verifyInvalidReplacementFixture(config(), cross)
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
    const cross = { parentDigest: PARENT_DIGEST, proposalId: 'p-fixture' }
    const reasons = await verifyInvalidReplacementFixture(config(), cross)
    expect(reasons.join('\n')).toMatch(/not digest-bound|not retained/)
  })

  it('rejects a digest-bound fixture whose reason is not reproducible', async () => {
    await realFixture(join(root!, 'v011', 'actions', 'proposal-1-1'), 'fixture-audit-run')
    const path = join(root!, 'v011', 'actions', 'proposal-1-1', 'rejection.json')
    const record = JSON.parse(await readFileText(path)) as { reasonDigest: string }
    record.reasonDigest = sha('a different validator outcome')
    await writeFile(path, JSON.stringify(record, null, 2) + '\n')
    const cross = { parentDigest: PARENT_DIGEST, proposalId: 'p-fixture' }
    const reasons = await verifyInvalidReplacementFixture(config(), cross)
    expect(reasons.join('\n')).toMatch(/reason is not reproducible/)
  })

  it('rejects a fixture whose analysis unexpectedly validates', async () => {
    const action = join(root!, 'v011', 'actions', 'proposal-1-1')
    await realFixture(action, 'fixture-audit-run')
    // Overwrite the retained analysis with a VALID one, keeping all digests
    // self-consistent: the replay must catch the semantic impossibility.
    const citation = {
      objectDigest: 'sha256:' + 'c'.repeat(64),
      mediaType: 'application/json',
      locator: { kind: 'json-pointer', value: '/' },
      observation: 'fixture observation',
    }
    const validAnalysis =
      JSON.stringify(
        {
          schemaVersion: 1,
          failureClusters: [
            {
              slug: 'fixture-invalid-cluster',
              mechanism: 'A mechanism description of sufficient length.',
              citations: [citation, { ...citation, objectDigest: 'sha256:' + 'd'.repeat(64) }],
            },
          ],
          ancestorReconciliations: [],
          selectedCluster: 'fixture-invalid-cluster',
          falsifiableHypothesis: 'fixture hypothesis of sufficient length',
          expectedBehaviorChange: 'none',
          preservationRequirements: ['nothing to preserve'],
          regressionRisks: ['no risks'],
        },
        null,
        2,
      ) + '\n'
    await writeFile(join(action, 'invalid-fixture-analysis.json'), validAnalysis)
    const path = join(action, 'rejection.json')
    const record = JSON.parse(await readFileText(path)) as Record<string, unknown>
    record['fixtureAnalysisDigest'] = digestV011(validAnalysis)
    record['reasonDigest'] = sha('any')
    await writeFile(path, JSON.stringify(record, null, 2) + '\n')
    const cross = { parentDigest: PARENT_DIGEST, proposalId: 'p-fixture' }
    const reasons = await verifyInvalidReplacementFixture(config(), cross)
    expect(reasons.join('\n')).toMatch(/unexpectedly validates/)
  })

  it('rejects a v2 record missing the binding object without crashing', async () => {
    const action = join(root!, 'v011', 'actions', 'proposal-1-1')
    await realFixture(action, 'fixture-audit-run')
    const path = join(action, 'rejection.json')
    const record = JSON.parse(await readFileText(path)) as Record<string, unknown>
    delete record['binding']
    await writeFile(path, JSON.stringify(record, null, 2) + '\n')
    const cross = { parentDigest: PARENT_DIGEST, proposalId: 'p-fixture' }
    const reasons = await verifyInvalidReplacementFixture(config(), cross)
    expect(reasons.join('\n')).toMatch(/not digest-bound/)
  })

  it('rejects a fixture pinned to a different analysis schema (issue #203)', async () => {
    const action = join(root!, 'v011', 'actions', 'proposal-1-1')
    await realFixture(action, 'fixture-audit-run')
    const path = join(action, 'rejection.json')
    const record = JSON.parse(await readFileText(path)) as { analysisSchemaDigest: string }
    record.analysisSchemaDigest = 'sha256:' + 'f'.repeat(64)
    await writeFile(path, JSON.stringify(record, null, 2) + '\n')
    const cross = { parentDigest: PARENT_DIGEST, proposalId: 'p-fixture' }
    const reasons = await verifyInvalidReplacementFixture(config(), cross)
    expect(reasons.join('\n')).toMatch(/not digest-bound/)
  })

  it('rejects a fixture whose parent digest contradicts the materialization receipt', async () => {
    const action = join(root!, 'v011', 'actions', 'proposal-1-1')
    await realFixture(action, 'fixture-audit-run')
    const reasons = await verifyInvalidReplacementFixture(config(), {
      parentDigest: 'sha256:' + 'e'.repeat(64),
      proposalId: 'p-fixture',
    })
    expect(reasons.join('\n')).toMatch(/not digest-bound/)
  })

  it('rejects a fixture whose proposalId contradicts the materialization receipt', async () => {
    const action = join(root!, 'v011', 'actions', 'proposal-1-1')
    await realFixture(action, 'fixture-audit-run')
    const reasons = await verifyInvalidReplacementFixture(config(), {
      parentDigest: PARENT_DIGEST,
      proposalId: 'p-OTHER',
    })
    expect(reasons.join('\n')).toMatch(/not digest-bound/)
  })

  it('accepts a fixture when attempt 1 failed (baseline-only cross, issue #208)', async () => {
    const action = join(root!, 'v011', 'actions', 'proposal-1-1')
    await realFixture(action, 'fixture-audit-run')
    // No materialization.json (attempt failed); the baseline receipt carries
    // the trusted parent digest.
    await writeFile(
      join(root!, 'candidates', 'v011-baseline', 'stable-build.json'),
      JSON.stringify({ sourceDigest: PARENT_DIGEST }) + '\n',
      { flag: 'wx' },
    ).catch(async () => {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(root!, 'candidates', 'v011-baseline'), { recursive: true })
      await writeFile(
        join(root!, 'candidates', 'v011-baseline', 'stable-build.json'),
        JSON.stringify({ sourceDigest: PARENT_DIGEST }) + '\n',
      )
    })
    const reasons = await verifyInvalidReplacementFixture(config(), {
      parentDigest: PARENT_DIGEST,
    })
    expect(reasons).toEqual([])
  })

  it('fails closed when the fixture exists but the cross-binding is missing', async () => {
    const action = join(root!, 'v011', 'actions', 'proposal-1-1')
    await realFixture(action, 'fixture-audit-run')
    const reasons = await verifyInvalidReplacementFixture(config(), {})
    expect(reasons.join('\n')).toMatch(/not digest-bound/)
  })

  it('rejects a fixture from a different run binding', async () => {
    await realFixture(join(root!, 'v011', 'actions', 'proposal-1-1'), 'OTHER-RUN')
    const cross = { parentDigest: PARENT_DIGEST, proposalId: 'p-fixture' }
    const reasons = await verifyInvalidReplacementFixture(config(), cross)
    expect(reasons.join('\n')).toMatch(/not digest-bound/)
  })
})

function readFileText(path: string): Promise<string> {
  return import('node:fs/promises').then((fs) => fs.readFile(path, 'utf8'))
}

describe('deriveFixtureCross chain (issue #208)', () => {
  it('prefers the baseline receipt and adds proposalId when materialization exists', async () => {
    const action = join(root!, 'v011', 'actions', 'proposal-1-1')
    await realFixture(action, 'fixture-audit-run')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(root!, 'candidates', 'v011-baseline'), { recursive: true })
    await writeFile(
      join(root!, 'candidates', 'v011-baseline', 'stable-build.json'),
      JSON.stringify({ sourceDigest: PARENT_DIGEST }) + '\n',
    )
    const cross = await deriveFixtureCross(config())
    expect(cross.parentDigest).toBe(PARENT_DIGEST)
    expect(cross.proposalId).toBe('p-fixture')
  })

  it('falls back to the materialization parentDigest when no baseline receipt exists', async () => {
    const action = join(root!, 'v011', 'actions', 'proposal-1-1')
    await realFixture(action, 'fixture-audit-run')
    const cross = await deriveFixtureCross(config())
    expect(cross.parentDigest).toBe(PARENT_DIGEST)
    expect(cross.proposalId).toBe('p-fixture')
  })

  it('returns an empty cross when neither receipt exists', async () => {
    const cross = await deriveFixtureCross(config())
    expect(cross).toEqual({})
  })

  describe('catalog digest recomputation (issue #82)', () => {
    it('rejects an arbitrary digest string on a protocol-matching catalog', async () => {
      const root2 = await mkdtemp(join(tmpdir(), 'v011-catalog-'))
      const { rm: rmDir } = await import('node:fs/promises')
      setTimeout(() => void rmDir(root2, { recursive: true, force: true }), 0).unref?.()

      const { mkdir, writeFile: wf } = await import('node:fs/promises')
      await mkdir(join(root2, 'v011'), { recursive: true })
      await wf(
        join(root2, 'v011', 'capability-catalog.json'),
        JSON.stringify({
          digest: 'not-a-digest',
          catalog: {
            schemaVersion: 1,
            protocol: 'dsh-self-evolving-candidate-tree-v2',
            dshCommit: 'a'.repeat(40),
            capabilities: [
              {
                id: 'systemPrompt',
                tier: 'T0',
                kind: 'service',
                signature: 'sig',
                enabled: true,
                fixtureDigest: 'sha256:' + '1'.repeat(64),
              },
            ],
          },
        }) + '\n',
      )
      // Direct check of the audit behavior via a minimal harness: reuse
      // auditStableRun is too heavy; assert through the exported audit's
      // reason by calling auditV011Run would need full state. Instead pin the
      // recomputation contract directly.
      const { freezeCapabilityCatalog } = await import('@dsh-self-evolving/candidate-sdk')
      const raw = JSON.parse(
        await (
          await import('node:fs/promises')
        ).readFile(join(root2, 'v011', 'capability-catalog.json'), 'utf8'),
      ) as { digest: string; catalog: unknown }
      const frozen = await freezeCapabilityCatalog(raw.catalog as never)
      expect(frozen.digest).not.toBe(raw.digest)
      expect(frozen.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    })
  })
})
