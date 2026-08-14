import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EvaluationProvider } from '@dsh-rsi/core'
import {
  createStableDemoConfig,
  initializeState,
  runStableDemo,
  type BuiltCandidate,
  type StableDemoCapabilities,
  type StableProposal,
} from '../src/index.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

async function fixture(): Promise<{
  config: ReturnType<typeof createStableDemoConfig>
  counters: { proposals: number; builds: number; launches: number; collects: number }
  capabilities: StableDemoCapabilities
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rsi-engine-'))
  roots.push(root)
  const repoRoot = join(root, 'repo')
  const stateDir = join(root, 'state')
  const config = createStableDemoConfig({ runId: 'stable-k3', stateDir, repoRoot })
  await initializeState(config)
  const counters = { proposals: 0, builds: 0, launches: 0, collects: 0 }
  const providers = new Map<string, { externalJobId: string; terminal: boolean }>()
  const capabilities: StableDemoCapabilities = {
    async preflight() {
      return { ready: true, checks: [] }
    },
    baseline: {
      candidateId: 'baseline',
      sourceDigest: digest('baseline-source'),
      capsuleDigest: digest('baseline-capsule'),
      buildManifestDigest: digest('baseline-build'),
      sourceRoot: join(repoRoot, 'baseline'),
      evidenceRefs: [],
    },
    async observedTaskIds() {
      return Array.from({ length: 12 }, (_, index) => `task-${index + 1}`)
    },
    async propose(input): Promise<StableProposal> {
      counters.proposals += 1
      return {
        proposalId: `proposal-${input.generation}`,
        parentCandidateId: input.parent.candidateId,
        hypothesis: `generation ${input.generation} bounded recovery mechanism`,
        sourceDiff: `@@ generation ${input.generation}`,
        evidenceRefs: input.evidenceRefs,
        artifactDigest: digest(`proposal-${input.generation}`),
      }
    },
    async build(input): Promise<BuiltCandidate> {
      counters.builds += 1
      const id = digest(`candidate-${input.generation}`)
      return {
        candidateId: id,
        sourceDigest: digest(`source-${input.generation}`),
        capsuleDigest: digest(`capsule-${input.generation}`),
        buildManifestDigest: digest(`build-${input.generation}`),
        sourceRoot: join(repoRoot, `candidate-${input.generation}`),
        evidenceRefs: input.proposal.evidenceRefs,
      }
    },
    evaluationProvider(spec): EvaluationProvider {
      return {
        async inspect(key) {
          const state = providers.get(key)
          return state === undefined
            ? { status: 'absent' }
            : {
                status: state.terminal ? 'terminal' : 'running',
                externalJobId: state.externalJobId,
              }
        },
        async launch(key) {
          counters.launches += 1
          const state = { externalJobId: `job-${digest(key).slice(-12)}`, terminal: true }
          providers.set(key, state)
          return { externalJobId: state.externalJobId }
        },
        async collect() {
          counters.collects += 1
          const baselineFailure =
            spec.candidate.candidateId === 'baseline' && spec.taskId === 'task-2'
          return {
            candidateId: spec.candidate.candidateId,
            taskId: spec.taskId,
            attemptIndex: 0,
            status: baselineFailure ? 'invalid' : 'pass',
            reward: baselineFailure ? null : 1,
            costUsd: 0.001,
            rawEvidenceDigests: [digest(`${spec.candidate.candidateId}/${spec.taskId}`)],
          } as Awaited<ReturnType<EvaluationProvider['collect']>>
        },
      }
    },
  }
  return { config, counters, capabilities }
}

describe('stable-demo engine', () => {
  it('freezes a batch-discovered failure then creates three children at lineage depth >=2', async () => {
    const { config, counters, capabilities } = await fixture()
    const result = await runStableDemo(config, capabilities)
    expect(result.status).toBe('STABLE_ITERATION_VERIFIED')
    expect(result.baselineTrials).toBe(6)
    expect(result.candidateTrials).toBe(3)
    expect(result.solverTrials).toBe(9)
    expect(result.maxLineageDepth).toBe(3)
    expect(counters).toEqual({ proposals: 3, builds: 3, launches: 9, collects: 9 })
    expect(
      JSON.parse(await readFile(join(config.stateDir, 'failure-pool.json'), 'utf8')),
    ).toMatchObject({
      taskIds: ['task-2'],
    })

    const replay = await runStableDemo(config, capabilities)
    expect(replay).toEqual(result)
    expect(counters).toEqual({ proposals: 3, builds: 3, launches: 9, collects: 9 })
  })

  it('stops without proposals when both frozen batches have no real failure', async () => {
    const { config, counters, capabilities } = await fixture()
    const original = capabilities.evaluationProvider
    capabilities.evaluationProvider = (spec) => {
      const provider = original(spec)
      provider.collect = async () => ({
        candidateId: spec.candidate.candidateId,
        taskId: spec.taskId,
        attemptIndex: 0,
        status: 'pass',
        reward: 1,
        costUsd: 0.001,
      })
      return provider
    }
    const result = await runStableDemo(config, capabilities)
    expect(result.status).toBe('NO_REAL_FAILURE_SIGNAL')
    expect(result.solverTrials).toBe(12)
    expect(counters.proposals).toBe(0)
    expect(counters.builds).toBe(0)
  })

  it('fails before any external effect when preflight is not ready', async () => {
    const { config, counters, capabilities } = await fixture()
    capabilities.preflight = async () => ({
      ready: false,
      checks: [{ name: 'docker', status: 'FAIL', detail: 'unavailable' }],
    })
    await expect(runStableDemo(config, capabilities)).rejects.toThrow('preflight failed')
    expect(counters.launches).toBe(0)
  })
})
