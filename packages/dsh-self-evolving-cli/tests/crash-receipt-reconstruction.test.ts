/**
 * Crash/resume receipt reconstruction contract (issue #78).
 *
 * A receipt is never accepted on bare existence: finalization re-derives the
 * complete facts from durable state (journal + preserved stale lock + the
 * injection request) and an existing file must match them byte-for-byte;
 * the audit re-derives the same facts independently instead of trusting the
 * receipt's counters.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { append, readAll, replay, stateHash } from '@dsh-self-evolving/core'
import { createStableDemoConfig, finalizeCrashResumeReceipt } from '../src/index.js'
import { auditStableRun } from '../src/index.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function config(root: string) {
  return createStableDemoConfig({
    runId: 'crash-facts',
    stateDir: root,
    repoRoot: '/root/dsh-self-evolving',
    codeCommit: 'a'.repeat(40),
  })
}

function event(eventId: string, type: string, payload: Record<string, unknown>) {
  return {
    eventId,
    occurredAt: '2026-08-27T00:00:00.000Z',
    type,
    causationId: 'eval:candidate:1',
    correlationId: 'eval:candidate:1',
    actor: 'test',
    payload,
  } as Parameters<typeof append>[1]
}

async function seeded(root: string): Promise<string> {
  const journalDir = join(root, 'journal')
  await mkdir(journalDir, { recursive: true })
  const journal = { journalDir, runId: 'crash-facts', segmentMaxBytes: 1_000_000 }
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
    event('eval:candidate:1:planned', 'action.planned', {
      actionId: 'eval:candidate:1',
      kind: 'evaluation',
      idempotencyKey: 'crash-facts/baseline/t1/0',
    }),
  )
  await append(
    journal,
    event('eval:candidate:1:reserved', 'action.reserved', {
      actionId: 'eval:candidate:1',
      idempotencyKey: 'crash-facts/baseline/t1/0',
    }),
  )
  await append(
    journal,
    event('eval:candidate:1:action.launched', 'action.launched', {
      actionId: 'eval:candidate:1',
      externalJobId: 'job-1',
    }),
  )
  await append(
    journal,
    event('eval:candidate:1:evaluation.observed', 'evaluation.observed', {
      candidateId: 'baseline',
      taskId: 't1',
      attemptIndex: 0,
      status: 'pass',
      reward: 1,
    }),
  )
  await append(
    journal,
    event('eval:candidate:1:action.committed', 'action.committed', {
      actionId: 'eval:candidate:1',
      externalJobId: 'job-1',
    }),
  )
  // Preserved stale writer lock from the killed writer.
  await writeFile(join(journalDir, 'lock.stale-1234'), '')
  await writeFile(
    join(root, 'crash-injection-request.json'),
    JSON.stringify({ schemaVersion: 1, actionId: 'eval:candidate:1', boundary: 'launch' }) + '\n',
  )
  return (
    JSON.stringify(
      {
        schemaVersion: 1,
        runId: 'crash-facts',
        injectedActionId: 'eval:candidate:1',
        injectedBoundary: 'launch',
        staleWriterLockReceipts: ['lock.stale-1234'],
        launchEvents: 1,
        observationEvents: 1,
        commitEvents: 1,
        replayStateHash: stateHash(replay(await readAll(journal))),
      },
      null,
      2,
    ) + '\n'
  )
}

describe('crash receipt reconstruction (issue #78)', () => {
  it('accepts an existing receipt that matches independently re-derived facts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-crash-reconstruct-'))
    roots.push(root)
    const expected = await seeded(root)
    await writeFile(join(root, 'crash-resume-receipt.json'), expected)
    await expect(finalizeCrashResumeReceipt(config(root))).resolves.toBe(
      join(root, 'crash-resume-receipt.json'),
    )
  })

  it('rejects a pre-created forged receipt (old two-field shape)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-crash-forged-'))
    roots.push(root)
    await seeded(root)
    await writeFile(
      join(root, 'crash-resume-receipt.json'),
      JSON.stringify({
        launchEvents: 1,
        observationEvents: 1,
        commitEvents: 1,
        replayStateHash: 'sha256:' + '0'.repeat(64),
      }) + '\n',
    )
    await expect(finalizeCrashResumeReceipt(config(root))).rejects.toThrow(
      /does not match re-derived facts/,
    )
  })

  it('rejects a receipt whose boundary or stale locks were tampered', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-crash-tamper-'))
    roots.push(root)
    const expected = JSON.parse(await seeded(root)) as Record<string, unknown>
    expected['injectedBoundary'] = 'collect'
    await writeFile(
      join(root, 'crash-resume-receipt.json'),
      JSON.stringify(expected, null, 2) + '\n',
    )
    await expect(finalizeCrashResumeReceipt(config(root))).rejects.toThrow(
      /does not match re-derived facts/,
    )
  })

  it('audit re-derives crash facts and rejects a counter-only receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-crash-audit-'))
    roots.push(root)
    await seeded(root)
    await writeFile(
      join(root, 'crash-resume-receipt.json'),
      JSON.stringify({
        schemaVersion: 1,
        runId: 'crash-facts',
        injectedActionId: 'eval:candidate:1',
        injectedBoundary: 'launch',
        staleWriterLockReceipts: ['lock.stale-9999'],
        launchEvents: 1,
        observationEvents: 1,
        commitEvents: 1,
        replayStateHash: 'sha256:' + '0'.repeat(64),
      }) + '\n',
    )
    const report = await auditStableRun(config(root))
    expect(report.reasons.join('\n')).toMatch(/exactly-once receipt is invalid/)
  })

  describe('one-to-one evidence graph (issue #79)', () => {
    it('audit rejects a matrix where counts match but one child is uncovered', async () => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-audit-graph-'))
      roots.push(root)
      // Seed a journal whose aggregates look complete (3 children, 3 candidate
      // observations, 3 builds) but where child C has NO evidence and child A
      // is triple-covered.
      const journalDir = join(root, 'journal')
      await mkdir(journalDir, { recursive: true })
      const journal = { journalDir, runId: 'crash-facts', segmentMaxBytes: 1_000_000 }
      await append(
        journal,
        event('candidate:baseline', 'candidate.admitted', {
          candidateId: 'baseline',
          canonicalParent: null,
          donorCandidates: [],
        }),
      )
      let parent = 'baseline'
      for (const id of ['child-a', 'child-b', 'child-c']) {
        await append(
          journal,
          event(`candidate:${id}`, 'candidate.admitted', {
            candidateId: id,
            canonicalParent: parent,
            donorCandidates: [],
          }),
        )
        parent = id
      }
      for (let index = 0; index < 6; index += 1) {
        await append(
          journal,
          event(`obs:baseline:${index}`, 'evaluation.observed', {
            candidateId: 'baseline',
            taskId: `t${index}`,
            attemptIndex: 0,
            status: index === 0 ? 'fail' : 'pass',
            reward: index === 0 ? 0 : 1,
          }),
        )
      }
      // Three candidate observations: all reference child-a.
      for (let index = 0; index < 3; index += 1) {
        await append(
          journal,
          event(`obs:child:${index}`, 'evaluation.observed', {
            candidateId: 'child-a',
            taskId: `t${index}`,
            attemptIndex: 0,
            status: 'pass',
            reward: 1,
          }),
        )
      }
      // Three build completions: all reference child-a.
      for (let index = 0; index < 3; index += 1) {
        await append(
          journal,
          event(`build:${index}`, 'build.completed', {
            candidateId: 'child-a',
          }),
        )
      }
      await writeFile(join(journalDir, 'lock.stale-1'), '')
      const report = await auditStableRun(config(root))
      expect(report.reasons.join('\n')).toMatch(/lacks exactly one build receipt: child-b/)
      expect(report.reasons.join('\n')).toMatch(/lacks an attributable observation: child-c/)
    })
  })
})
