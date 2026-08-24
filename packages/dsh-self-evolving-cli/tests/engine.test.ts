import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EvaluationProvider } from '@dsh-self-evolving/core'
import {
  createStableDemoConfig,
  createV011DemoConfig,
  evaluationReserveUsd,
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
  config: ReturnType<typeof createStableDemoConfig> | ReturnType<typeof createV011DemoConfig>
  counters: { proposals: number; builds: number; launches: number; collects: number }
  capabilities: StableDemoCapabilities
}>
async function fixture(v011: boolean): Promise<{
  config: ReturnType<typeof createV011DemoConfig>
  counters: { proposals: number; builds: number; launches: number; collects: number }
  capabilities: StableDemoCapabilities
}>
async function fixture(v011 = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-engine-'))
  roots.push(root)
  const repoRoot = join(root, 'repo')
  const stateDir = join(root, 'state')
  const createConfig = v011 ? createV011DemoConfig : createStableDemoConfig
  const config = createConfig({
    runId: 'stable-k3',
    stateDir,
    repoRoot,
    codeCommit: 'a'.repeat(40),
  })
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
        proposalId: `proposal-${input.generation}-${input.attempt}`,
        parentCandidateId: input.parent.candidateId,
        hypothesis: `generation ${input.generation} bounded recovery mechanism`,
        sourceDiff: `@@ generation ${input.generation}`,
        evidenceRefs: input.evidenceRefs,
        artifactDigest: digest(`proposal-${input.generation}-${input.attempt}`),
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
            status: baselineFailure ? 'fail' : 'pass',
            reward: baselineFailure ? 0 : 1,
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
  it('allocates fixed-precision reservations without overselling the run budget', () => {
    expect(evaluationReserveUsd(5, 15)).toBe(0.333333)
    expect(evaluationReserveUsd(5, 15) * 15).toBeLessThanOrEqual(5)
    expect(evaluationReserveUsd(1.000001, 3)).toBe(0.333333)
    expect(() => evaluationReserveUsd(0.0000001, 15)).toThrow(/invalid USD budget allocation/)
    expect(() => evaluationReserveUsd(Number.NaN, 15)).toThrow(/invalid USD budget allocation/)
  })

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
        status: spec.taskId === 'task-2' ? 'invalid' : 'pass',
        reward: spec.taskId === 'task-2' ? null : 1,
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

  it('accepts a reward-zero attributable invalid as a non-passing baseline signal', async () => {
    const { config, capabilities } = await fixture()
    const original = capabilities.evaluationProvider
    capabilities.evaluationProvider = (spec) => {
      const provider = original(spec)
      const collect = provider.collect.bind(provider)
      provider.collect = async (externalJobId) => {
        const observation = await collect(externalJobId)
        return spec.candidate.candidateId === 'baseline' && spec.taskId === 'task-2'
          ? { ...observation, status: 'invalid' as const, reward: 0 }
          : observation
      }
      return provider
    }
    const result = await runStableDemo(config, capabilities)
    expect(result.status).toBe('STABLE_ITERATION_VERIFIED')
    expect(result.baselineTrials).toBe(6)
    await expect(readFile(join(config.stateDir, 'failure-pool.json'), 'utf8')).resolves.toContain(
      'task-2',
    )
  })

  it('stops schema-11 failure discovery immediately after the first attributable non-pass', async () => {
    const { config, counters, capabilities } = await fixture(true)
    const result = await runStableDemo(config, capabilities)
    expect(result.status).toBe('STABLE_ITERATION_VERIFIED')
    expect(result.baselineTrials).toBe(2)
    expect(result.candidateTrials).toBe(3)
    expect(result.solverTrials).toBe(5)
    expect(counters.launches).toBe(5)
    await expect(readFile(join(config.stateDir, 'failure-pool.json'), 'utf8')).resolves.toContain(
      '"batchSize": 1',
    )
  })

  it('records a build reject and admits a bounded replacement proposal', async () => {
    const { config, counters, capabilities } = await fixture()
    const originalBuild = capabilities.build
    const originalPropose = capabilities.propose
    const proposalEvidence: string[][] = []
    capabilities.propose = async (input) => {
      proposalEvidence.push(input.evidenceRefs)
      return originalPropose(input)
    }
    let rejected = false
    capabilities.build = async (input) => {
      if (!rejected) {
        rejected = true
        counters.builds += 1
        throw new Error('fixture compile reject')
      }
      return originalBuild(input)
    }
    const result = await runStableDemo(config, capabilities)
    expect(result.status).toBe('STABLE_ITERATION_VERIFIED')
    expect(counters.proposals).toBe(4)
    expect(counters.builds).toBe(4)
    expect(proposalEvidence[1]).toEqual(
      expect.arrayContaining([expect.stringContaining('rejection:BUILD_REJECT:journal:sha256:')]),
    )
  })

  it('records an invalid proposal and continues with the next bounded attempt', async () => {
    const { config, counters, capabilities } = await fixture()
    const originalPropose = capabilities.propose
    let rejected = false
    capabilities.propose = async (input) => {
      if (!rejected) {
        rejected = true
        counters.proposals += 1
        throw new Error('fixture protocol reject')
      }
      return originalPropose(input)
    }
    const result = await runStableDemo(config, capabilities)
    expect(result.status).toBe('STABLE_ITERATION_VERIFIED')
    expect(counters.proposals).toBe(4)
    expect(counters.builds).toBe(3)
  })

  it('terminates deterministically when all three proposal attempts are rejected', async () => {
    const { config, counters, capabilities } = await fixture()
    capabilities.propose = async () => {
      counters.proposals += 1
      throw new Error('fixture deterministic protocol rejection')
    }
    const result = await runStableDemo(config, capabilities)
    expect(result.status).toBe('NO_ADMISSIBLE_CHILD')
    expect(result.admittedChildren).toBe(0)
    expect(counters.proposals).toBe(3)
    const replay = await runStableDemo(config, capabilities)
    expect(replay).toEqual(result)
    expect(counters.proposals).toBe(3)
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

  it('resumes a mid-run durable boundary without insertion-order conflicts or duplicate launch', async () => {
    const { config, counters, capabilities } = await fixture()
    let injected = false
    capabilities.onEvaluationBoundary = (spec, boundary) => {
      if (!injected && spec.actionId === 'eval:baseline:task-1' && boundary === 'launch') {
        injected = true
        throw new Error('fixture process interruption')
      }
    }
    await expect(runStableDemo(config, capabilities)).rejects.toThrow(
      'fixture process interruption',
    )
    delete capabilities.onEvaluationBoundary
    const resumed = await runStableDemo(config, capabilities)
    expect(resumed.status).toBe('STABLE_ITERATION_VERIFIED')
    expect(counters.launches).toBe(9)
    expect(counters.collects).toBe(9)
  })

  it('reuses the frozen failure pool when resuming after the first candidate launch', async () => {
    const { config, counters, capabilities } = await fixture(true)
    let injected = false
    capabilities.onEvaluationBoundary = (spec, boundary) => {
      if (!injected && spec.actionId === 'eval:candidate:1' && boundary === 'launch') {
        injected = true
        throw new Error('fixture candidate process interruption')
      }
    }
    await expect(runStableDemo(config, capabilities)).rejects.toThrow(
      'fixture candidate process interruption',
    )
    delete capabilities.onEvaluationBoundary
    const resumed = await runStableDemo(config, capabilities)
    expect(resumed.status).toBe('STABLE_ITERATION_VERIFIED')
    expect(resumed.baselineTrials).toBe(2)
    expect(resumed.candidateTrials).toBe(3)
    expect(counters.launches).toBe(5)
    expect(counters.collects).toBe(5)
  })
})
