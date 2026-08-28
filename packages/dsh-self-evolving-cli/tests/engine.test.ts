import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readAll,
  replay as replayAll,
  type EvaluationProvider,
  type Journal,
} from '@dsh-self-evolving/core'
import {
  createStableDemoConfig,
  createV011DemoConfig,
  auditStableRun,
  evaluationReserveUsd,
  initializeState,
  runStableDemo,
  type BuiltCandidate,
  type StableDemoCapabilities,
  type StableProposal,
} from '../src/index.js'

function serviceJournal(config: { stateDir: string; runId: string }): Journal {
  return {
    journalDir: join(config.stateDir, 'journal'),
    runId: config.runId,
    segmentMaxBytes: 16 * 1024 * 1024,
  }
}

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
  const baselineCandidateId = v011 ? digest('baseline-source') : 'baseline'
  const capabilities: StableDemoCapabilities = {
    async preflight() {
      return { ready: true, checks: [] }
    },
    baseline: {
      candidateId: baselineCandidateId,
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
            spec.candidate.candidateId === baselineCandidateId && spec.taskId === 'task-2'
          return {
            candidateId: spec.candidate.candidateId,
            taskId: spec.taskId,
            attemptIndex: 0,
            status: baselineFailure ? 'fail' : 'pass',
            reward: baselineFailure ? 0 : 1,
            costUsd: 0.001,
            pricing: { state: 'priced' },
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

  it('suspends with PENDING_EVALUATIONS while a launched saga is still running', async () => {
    const { config, counters, capabilities } = await fixture()
    const original = capabilities.evaluationProvider
    let firstLaunchInspection = true
    capabilities.evaluationProvider = (spec) => {
      const provider = original(spec)
      const inspect = provider.inspect.bind(provider)
      provider.inspect = async (key) => {
        // After the durable launch of the very first discovery trial, the
        // provider still reports the job running: the saga must return
        // pending instead of collecting.
        if (
          spec.kind === 'baseline-discovery' &&
          spec.taskId === 'task-1' &&
          counters.launches >= 1 &&
          firstLaunchInspection &&
          (await inspect(key)).status !== undefined
        ) {
          firstLaunchInspection = false
          const real = await inspect(key)
          return { ...real, status: 'running' as const }
        }
        return inspect(key)
      }
      return provider
    }

    const suspended = await runStableDemo(config, capabilities)
    expect(suspended.status).toBe('PENDING_EVALUATIONS')
    expect(suspended.baselineTrials).toBe(0)
    expect(counters.launches).toBe(1)
    expect(counters.collects).toBe(0)

    const events = await readAll(serviceJournal(config))
    expect(events.some((event) => event.type === 'failure-pool.frozen')).toBe(false)
    expect(events.some((event) => event.type === 'run.terminal')).toBe(false)
    await expect(stat(join(config.stateDir, 'failure-pool.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })

    // The job has now finished: the plain resume reconciles the same action
    // exactly once and completes the run.
    const resumed = await runStableDemo(config, capabilities)
    expect(resumed.status).toBe('STABLE_ITERATION_VERIFIED')
    expect(counters.launches).toBe(9)
    expect(counters.collects).toBe(9)
  })

  it('records durable proposal/build action intent around every side effect', async () => {
    const { config, capabilities } = await fixture()
    const result = await runStableDemo(config, capabilities)
    expect(result.status).toBe('STABLE_ITERATION_VERIFIED')
    const events = await readAll(serviceJournal(config))
    const types = events.map((event) => event.type)
    for (const actionId of ['proposal:1:1', 'build:1:1']) {
      expect(types).toContain('action.planned')
      const planned = events.find(
        (event) =>
          event.type === 'action.planned' &&
          (event.payload as { actionId?: string }).actionId === actionId,
      )
      expect(planned, actionId).toBeDefined()
      expect((planned!.payload as { idempotencyKey?: string }).idempotencyKey).toContain(
        config.runId,
      )
      for (const kind of ['action.reserved', 'action.launched', 'action.committed']) {
        const row = events.find(
          (event) =>
            event.type === kind && (event.payload as { actionId?: string }).actionId === actionId,
        )
        expect(row, `${actionId} ${kind}`).toBeDefined()
      }
    }
    // Every action in the run is terminal (audit contract).
    const state = replayAll(events)
    for (const action of Object.values(state.actions)) {
      expect(['COMMITTED', 'FAILED', 'CANCELLED', 'ABANDONED']).toContain(action.status)
    }
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
        status: 'pass' as const,
        reward: 1,
        costUsd: 0.001,
        pricing: { state: 'priced' },
      })
      return provider
    }
    const result = await runStableDemo(config, capabilities)
    expect(result.status).toBe('NO_REAL_FAILURE_SIGNAL')
    expect(result.solverTrials).toBe(12)
    expect(counters.proposals).toBe(0)
    expect(counters.builds).toBe(0)
  })

  it('accepts a null-reward attributable invalid as a non-passing baseline signal', async () => {
    const { config, capabilities } = await fixture()
    const original = capabilities.evaluationProvider
    capabilities.evaluationProvider = (spec) => {
      const provider = original(spec)
      const collect = provider.collect.bind(provider)
      provider.collect = async (externalJobId) => {
        const observation = await collect(externalJobId)
        return spec.candidate.candidateId === capabilities.baseline.candidateId &&
          spec.taskId === 'task-2'
          ? { ...observation, status: 'invalid' as const, reward: null }
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
    const audit = await auditStableRun(config)
    expect(audit.reasons.join('\n')).not.toMatch(
      /candidate observation matrix|failure pool contains|baseline batch is incomplete/,
    )
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
