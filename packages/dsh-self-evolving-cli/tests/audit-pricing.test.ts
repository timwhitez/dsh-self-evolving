/**
 * Stable-audit pricing controls (issue #223): the audit's unpriced-usage
 * rejection has both a negative and a positive control through the real
 * auditStableRun path. The real evaluator additionally rejects every summary
 * that lacks replayed broker-v2 terminal/raw authority.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { append, type Journal } from '@dsh-self-evolving/core'
import {
  auditStableRun,
  buildGate5EvaluatorEnvironment,
  createRealEvaluationProvider,
  createStableDemoConfig,
  type StableDemoConfig,
} from '../src/index.js'
import { GATE5_BROKER_PROTOCOL } from '../src/gate5-security.js'

const roots: string[] = []
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function event(eventId: string, type: string, payload: Record<string, unknown>) {
  return {
    eventId,
    occurredAt: '2026-08-28T00:00:00.000Z',
    type,
    causationId: 'eval:baseline:task-1:0',
    correlationId: 'eval:baseline:task-1:0',
    actor: 'test',
    payload,
  } as Parameters<typeof append>[1]
}

/**
 * Seed the minimal durable state the audit reads: one admitted candidate,
 * one launched evaluation, one observation. The audit rejects this run for
 * unrelated reasons (missing children, no failure pool); the controls below
 * assert only the presence/absence of the unpriced-usage reason.
 */
async function seed(root: string, observationPayload: Record<string, unknown>): Promise<void> {
  const journalDir = join(root, 'journal')
  await mkdir(journalDir, { recursive: true })
  const journal: Journal = { journalDir, runId: 'audit-pricing', segmentMaxBytes: 1_000_000 }
  await append(
    journal,
    event('candidate:baseline', 'candidate.admitted', {
      candidateId: 'baseline',
      canonicalParent: null,
      donorCandidates: [],
    }),
  )
  await append(
    journal,
    event('eval:planned', 'action.planned', {
      actionId: 'eval:baseline:task-1:0',
      kind: 'evaluation',
      idempotencyKey: 'audit-pricing/baseline/task-1/0',
    }),
  )
  await append(journal, event('eval:observed', 'evaluation.observed', observationPayload))
}

function config(root: string): StableDemoConfig {
  return createStableDemoConfig({
    runId: 'audit-pricing',
    stateDir: root,
    repoRoot,
    codeCommit: 'a'.repeat(40),
  })
}

describe('stable audit unpriced-usage controls (issue #223)', () => {
  it('rejects a run whose observation lacks a valid pricing state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-audit-pricing-'))
    roots.push(root)
    await seed(root, {
      candidateId: 'baseline',
      taskId: 'task-1',
      attemptIndex: 0,
      status: 'pass',
      reward: 1,
      costUsd: 0,
      rawEvidenceDigests: [],
    })
    const report = await auditStableRun(config(root))
    expect(report.accepted).toBe(false)
    expect(report.reasons).toContain('unresolved unpriced evaluation usage: 1')
  })

  it('does not raise the unpriced reason for genuinely priced observations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-audit-pricing-'))
    roots.push(root)
    await seed(root, {
      candidateId: 'baseline',
      taskId: 'task-1',
      attemptIndex: 0,
      status: 'pass',
      reward: 1,
      costUsd: 0.01,
      pricing: { state: 'priced' },
      rawEvidenceDigests: [],
    })
    const report = await auditStableRun(config(root))
    expect(report.reasons).not.toContain('unresolved unpriced evaluation usage: 1')
    expect(report.reasons.join('\n')).not.toMatch(/unresolved unpriced evaluation usage/)
  })
})

describe('real evaluator broker-v2 authority', () => {
  const evaluatorCandidateId = `sha256:${'d'.repeat(64)}`
  const specBase = {
    actionId: 'eval:baseline:task-1:0',
    idempotencyKey: 'audit-pricing/baseline/task-1/0',
    taskId: 'task-1',
    attemptIndex: 0,
    kind: 'baseline-discovery',
  } as const

  function spec(candidateId: string) {
    return {
      ...specBase,
      candidate: {
        candidateId,
        sourceDigest: `sha256:${'a'.repeat(64)}`,
        capsuleDigest: `sha256:${'b'.repeat(64)}`,
        buildManifestDigest: `sha256:${'c'.repeat(64)}`,
        sourceRoot: '/tmp/unused',
        evidenceRefs: [],
      },
    }
  }

  const runId = `stable-g5v2-${createHash('sha256')
    .update(`${GATE5_BROKER_PROTOCOL}\0${specBase.idempotencyKey}`)
    .digest('hex')
    .slice(0, 24)}`

  it('passes both planned candidate identities into the external evaluator', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-provider-identity-env-'))
    roots.push(root)
    const planned = spec(evaluatorCandidateId)
    const environment = buildGate5EvaluatorEnvironment(config(root), planned, runId, 333_333)
    expect(environment['GATE5_EXPECTED_CANDIDATE_ID']).toBe(planned.candidate.candidateId)
    expect(environment['GATE5_EXPECTED_CAPSULE_DIGEST']).toBe(planned.candidate.capsuleDigest)
  })

  async function providerWithSummary(
    row: Record<string, unknown>,
  ): Promise<{ provider: ReturnType<typeof createRealEvaluationProvider>; dir: string }> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-provider-pricing-'))
    roots.push(root)
    const cfg = config(root)
    const provider = createRealEvaluationProvider(cfg, spec(evaluatorCandidateId))
    // A retired summary with matching caller identities is still not broker-v2 authority.
    const dir = join(cfg.stateDir, 'external-evaluator', runId)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'summary.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        runId,
        capabilityMode: 'real-official-responses-harbor-acp',
        candidateId: evaluatorCandidateId,
        normalized: [{ candidateId: evaluatorCandidateId, taskId: 'task-1', ...row }],
      })}\n`,
    )
    return { provider, dir }
  }

  it('rejects a retired schema-1 summary before it can become score authority', async () => {
    const { provider } = await providerWithSummary({
      status: 'pass',
      reward: 1,
      costUsd: 0.01,
      priced: true,
    })
    await expect(provider.inspect()).rejects.toThrow(/ambiguous incomplete prior external job/)
    await expect(provider.collect(runId)).rejects.toThrow(/no terminal authority/)
  })

  it('rejects a forged terminal marker instead of trusting an existing summary', async () => {
    const { provider, dir } = await providerWithSummary({
      status: 'pass',
      reward: 1,
      costUsd: 0.01,
      priced: true,
    })
    await writeFile(join(dir, 'execution-terminal.json'), '{}\n')
    await expect(provider.collect(runId)).rejects.toThrow()
  })

  it('recognizes only the broker protocol terminal marker for crash recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-provider-terminal-'))
    roots.push(root)
    const cfg = config(root)
    const provider = createRealEvaluationProvider(cfg, spec(evaluatorCandidateId))
    const dir = join(cfg.stateDir, 'external-evaluator', runId)
    await mkdir(join(dir, 'jobs', runId), { recursive: true })
    await writeFile(join(dir, 'jobs', runId, 'result.json'), '{}\n')
    await expect(provider.inspect()).rejects.toThrow(/ambiguous incomplete prior external job/)
    await writeFile(join(dir, 'execution-terminal.json'), '{}\n')
    await expect(provider.inspect()).rejects.toThrow()
  })
})
