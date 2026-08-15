#!/usr/bin/env tsx
/**
 * Non-acceptance pilot-loop fixture.
 *
 * Exercises the pilot state machine with deterministic stub capabilities. It
 * does not call a model, build a runnable capsule, or invoke Harbor, so its
 * output can never satisfy Gate 6 acceptance.
 *
 * Outputs evidence/fixtures/pilot-loop/pilot-result.json. Formal Gate 6 evidence
 * belongs under evidence/pilot and must pass verifyGate6Acceptance.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  runPilotLoop,
  type PilotCapabilities,
  type ProposedChild,
} from '../packages/dsh-self-evolving-pilot/src/index.js'
import {
  DEFAULT_PARAMS,
  deterministicSplit,
  type TaskMeta,
} from '../packages/dsh-self-evolving-search/src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const evidenceDir = join(repoRoot, 'evidence', 'fixtures', 'pilot-loop')
const baselineRoot = join(repoRoot, 'packages', 'candidate-baseline')

const K = Number(process.env['PILOT_K'] ?? '3')
const B_EVAL = Number(process.env['PILOT_B_EVAL'] ?? '12')

async function main(): Promise<void> {
  await mkdir(evidenceDir, { recursive: true })
  // Use the baseline source as the root parent.
  const baselineSource = await readFile(join(baselineRoot, 'src', 'index.ts'), 'utf8')
  const baselineDigest = 'sha256:' + createHash('sha256').update(baselineSource).digest('hex')

  // Dev task ids from the split (dev-observed only).
  const inv = JSON.parse(
    await readFile(join(repoRoot, 'evidence', 'calibration', 'tb21-inventory.json'), 'utf8'),
  )
  const tasks: TaskMeta[] = inv.tasks
  const assignment = deterministicSplit(tasks, 0x5eed5eedn)
  const devTaskIds = assignment
    .filter((a) => a.label === 'dev-observed')
    .map((a) => a.taskId)
    .slice(0, 6)

  // Stub capabilities exercise loop mechanics only. They deliberately cannot
  // produce an acceptance envelope.
  let propId = 0
  const caps: PilotCapabilities = {
    async propose(_parentDigest: string, _parentSource: string): Promise<ProposedChild[]> {
      propId += 1
      return [
        {
          proposalId: `prop-${propId}`,
          canonicalParentDigest: baselineDigest,
          hypothesis: `Improve recovery by adding a bounded retry on transient tool failures (variant ${propId})`,
          sourceDiff: `+export function withRetry(fn) { let n=0; while(n<3){try{return fn()}catch{n++}}; throw new Error('retry-exhausted') } /* v${propId} */`,
          donorCandidates: [],
        },
      ]
    },
    async build(child: ProposedChild) {
      // Deterministic build: digest the sourceDiff; reject empty.
      if (child.sourceDiff.trim().length === 0) return null
      const digest = 'sha256:' + createHash('sha256').update(child.sourceDiff).digest('hex')
      return { candidateId: digest, digest }
    },
    async evaluate(candidateId: string, taskId: string, attempt: number) {
      const sample = createHash('sha256')
        .update(`${candidateId}\0${taskId}\0${attempt}`)
        .digest()[0]!
      const reward = (sample < 153 ? 1 : 0) as 0 | 1
      return { reward, costUsd: 0.002, wallSec: 50 }
    },
  }

  console.log(`Pilot: K=${K} B_eval=${B_EVAL} devTasks=${devTaskIds.length}`)
  const start = Date.now()
  const state = await runPilotLoop(
    'baseline',
    baselineSource,
    baselineDigest,
    {
      K,
      B_eval: B_EVAL,
      params: DEFAULT_PARAMS,
      devTaskIds,
      masterSeed: 0x70170n,
    },
    caps,
  )
  const wallSec = (Date.now() - start) / 1000

  const result = {
    runId: 'fixture-pilot-loop-001',
    status: 'NON_ACCEPTANCE_FIXTURE',
    capabilityMode: 'stub-fixture',
    K,
    B_eval: B_EVAL,
    admittedCount: state.admittedCount,
    N: state.N,
    duplicateEdges: state.duplicateEdges,
    buildRejects: state.buildRejects,
    evalFailures: state.evalFailures,
    terminal: state.terminal,
    reason: state.reason,
    wallSec,
    candidates: state.archive.nodes.map((n) => ({
      candidateId: n.candidateId.slice(0, 24),
      canonicalParent: n.canonicalParent?.slice(0, 24) ?? null,
      s: n.s,
      f: n.f,
    })),
    observationCount: state.archive.observations.length,
  }
  await writeFile(join(evidenceDir, 'pilot-result.json'), JSON.stringify(result, null, 2) + '\n')

  console.log('\n===== PILOT RESULT =====')
  console.log(`terminal: ${state.terminal} (${state.reason})`)
  console.log(
    `admitted: ${state.admittedCount}/${K}, N=${state.N}, dedup=${state.duplicateEdges}, buildRejects=${state.buildRejects}, evalFails=${state.evalFailures}`,
  )
  console.log(`observations: ${state.archive.observations.length}, wall: ${wallSec.toFixed(1)}s`)
}

await main()
