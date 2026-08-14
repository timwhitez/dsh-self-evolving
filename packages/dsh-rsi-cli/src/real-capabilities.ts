import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { buildCandidate, packCapsule } from '@dsh-rsi/candidate-sdk'
import { runProposalSandbox, type EvaluationObservation } from '@dsh-rsi/core'
import {
  TrustedChatCompletionsAdapter,
  createProposalGatewayLlmHandler,
  startProposalGateway,
  type ProposalGatewayRoute,
} from '@dsh-rsi/proposer'
import { runDoctor } from './doctor.js'
import type { StableDemoConfig } from './config.js'
import type {
  BuiltCandidate,
  StableBuildInput,
  StableDemoCapabilities,
  StableEvaluationSpec,
  StableProposal,
  StableProposalInput,
} from './engine.js'
import { loadTrustedRoute } from './trusted-route.js'

const SOURCE_FILES = [
  'src/index.ts',
  'package.json',
  'candidate.json',
  'cordis.patch.yml',
  'tsconfig.json',
]

function sha256(bytes: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function exec(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return new Promise<{ stdout: string; stderr: string }>((done, reject) => {
    execFile(
      file,
      args,
      {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        error
          ? reject(new Error(`${basename(file)} failed: ${stderr}`, { cause: error }))
          : done({ stdout, stderr }),
    )
  })
}

async function writeExclusive(path: string, bytes: string): Promise<void> {
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(bytes)
    await file.sync()
  } finally {
    await file.close()
  }
}

async function prepareProposalRuntime(config: StableDemoConfig): Promise<string> {
  const runtimeRoot = join(config.stateDir, 'trusted-runtime', 'proposer')
  if ((await stat(join(runtimeRoot, 'node')).catch(() => null))?.isFile()) return runtimeRoot
  const staging = await mkdtemp(join(config.stateDir, '.proposer-runtime-'))
  try {
    const baselineRoot = join(config.repoRoot, 'packages', 'candidate-baseline')
    const receipt = await buildCandidate({
      sourceRoot: baselineRoot,
      sourceFiles: SOURCE_FILES,
      tscBin: join(config.repoRoot, 'node_modules', '.bin', 'tsc'),
    })
    const capsuleDir = join(staging, 'capsule')
    await packCapsule({
      outDir: capsuleDir,
      receipt,
      runnerOverlay: '\n',
      provenanceJson: JSON.stringify({ profile: 'stable-demo', model: config.model }),
      sbomJson: JSON.stringify({ spdxVersion: 'SPDX-2.3' }),
      runtimeClosure: {
        catalogRoots: [
          join(config.repoRoot, 'packages'),
          join(config.repoRoot, 'deepseek-harness', 'packages'),
          join(config.repoRoot, 'deepseek-harness', 'vendor'),
        ],
        seedPackages: [
          '@dsh-rsi/proposer',
          '@deepseek-ai/dsh-agent-spine-demo',
          '@deepseek-ai/dsh-agent-default-model',
        ],
        entryPackage: '@dsh-rsi/proposer',
        entryBin: 'lib/sandbox-worker.js',
      },
    })
    await mkdir(join(config.stateDir, 'trusted-runtime'), { recursive: true, mode: 0o700 })
    await cp(join(capsuleDir, 'runtime'), runtimeRoot, { recursive: true, errorOnExist: true })
    await chmod(runtimeRoot, 0o700)
    return runtimeRoot
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function realProposal(
  config: StableDemoConfig,
  input: StableProposalInput,
): Promise<StableProposal> {
  const artifactDir = join(config.stateDir, 'artifacts', `proposal-${input.generation}`)
  const outputPath = join(artifactDir, 'proposal.json')
  const existing = await readFile(outputPath, 'utf8').catch(() => null)
  if (existing !== null) return JSON.parse(existing) as StableProposal
  await mkdir(artifactDir, { recursive: true, mode: 0o700 })
  const runtimeRoot = await prepareProposalRuntime(config)
  const scratch = await mkdtemp(join(config.stateDir, `.proposal-${input.generation}-`))
  const route = await loadTrustedRoute()
  const lockedRoute: ProposalGatewayRoute = {
    provider: 'deepseek',
    endpoint: route.baseUrl,
    model: config.model.requested,
    reasoningEffort: config.model.reasoningEffort,
    maxTokens: config.model.maxOutputTokens,
  }
  const previousKey = process.env['RSI_PROVIDER_API_KEY']
  process.env['RSI_PROVIDER_API_KEY'] = route.apiKey
  try {
    const mounts = {
      parent: join(scratch, 'input', 'parent'),
      archive: join(scratch, 'input', 'archive'),
      evidence: join(scratch, 'input', 'evidence'),
      contracts: join(scratch, 'input', 'contracts'),
      childrenRoot: join(scratch, 'children'),
    }
    await Promise.all(Object.values(mounts).map((path) => mkdir(path, { recursive: true })))
    await mkdir(join(mounts.parent, 'src'), { recursive: true })
    await cp(
      join(input.parent.sourceRoot, 'src', 'index.ts'),
      join(mounts.parent, 'src', 'index.ts'),
    )
    await writeFile(
      join(mounts.archive, 'catalog.json'),
      JSON.stringify({
        schemaVersion: 1,
        sourceLabel: 'DEV_OBSERVED',
        parent: input.parent.candidateId,
      }) + '\n',
    )
    await writeFile(join(mounts.evidence, 'traces.txt'), input.evidenceRefs.join('\n') + '\n')
    await writeFile(
      join(mounts.contracts, 'request.json'),
      JSON.stringify({
        route: lockedRoute,
        parentDigest: input.parent.sourceDigest,
        candidateId: input.parent.candidateId,
        width: 3,
      }) + '\n',
    )
    const adapter = new TrustedChatCompletionsAdapter({
      route: lockedRoute,
      apiKeyEnv: 'RSI_PROVIDER_API_KEY',
      expectedResponseModel: config.model.effective,
      contextWindow: config.model.contextWindow,
      requestMaxRetries: 12,
      reasoningContinuationMaxTurns: 0,
    })
    const gateway = await startProposalGateway({
      socketPath: join(scratch, 'gateway', 'proposal.sock'),
      route: lockedRoute,
      handle: createProposalGatewayLlmHandler(adapter, lockedRoute),
    })
    try {
      const result = await runProposalSandbox({
        mounts,
        runtimeRoot,
        command: '/runtime/node',
        args: ['/runtime/node_modules/@dsh-rsi/proposer/lib/sandbox-worker.js'],
        timeoutMs: 600_000,
        maxOutputBytes: 2 * 1024 * 1024,
        gatewaySocket: gateway.socketPath,
      })
      if (result.exitCode !== 0) throw new Error(`real proposer failed: ${result.stderr}`)
      const output = JSON.parse(
        await readFile(join(mounts.childrenRoot, 'proposal-output.json'), 'utf8'),
      ) as {
        parsed: {
          accepted: Array<{
            proposalId: string
            hypothesis: string
            sourceDiff: string
            evidenceRefs: string[]
          }>
        }
      }
      const child = output.parsed.accepted[0]
      if (child === undefined) throw new Error('real proposer returned no admitted child')
      const proposal: StableProposal = {
        proposalId: child.proposalId,
        parentCandidateId: input.parent.candidateId,
        hypothesis: child.hypothesis,
        sourceDiff: child.sourceDiff,
        evidenceRefs: input.evidenceRefs,
        artifactDigest: sha256(JSON.stringify(child)),
      }
      await writeExclusive(outputPath, JSON.stringify(proposal, null, 2) + '\n')
      await writeExclusive(
        join(artifactDir, 'gateway-receipts.json'),
        JSON.stringify(gateway.receipts(), null, 2) + '\n',
      )
      return proposal
    } finally {
      await gateway.close()
    }
  } finally {
    if (previousKey === undefined) delete process.env['RSI_PROVIDER_API_KEY']
    else process.env['RSI_PROVIDER_API_KEY'] = previousKey
    await rm(scratch, { recursive: true, force: true })
  }
}

async function realBuild(
  config: StableDemoConfig,
  input: StableBuildInput,
): Promise<BuiltCandidate> {
  const candidateRoot = join(config.stateDir, 'candidates', `generation-${input.generation}`)
  const receiptPath = join(candidateRoot, 'stable-build.json')
  const existing = await readFile(receiptPath, 'utf8').catch(() => null)
  if (existing !== null) return JSON.parse(existing) as BuiltCandidate
  await mkdir(join(candidateRoot, 'src'), { recursive: true, mode: 0o700 })
  for (const relative of SOURCE_FILES) {
    if (relative === 'src/index.ts' || relative === 'tsconfig.json') continue
    await cp(join(input.parent.sourceRoot, relative), join(candidateRoot, relative))
  }
  await writeFile(
    join(candidateRoot, 'tsconfig.json'),
    JSON.stringify(
      {
        extends: join(config.repoRoot, 'tsconfig.json'),
        compilerOptions: {
          outDir: 'lib',
          rootDir: 'src',
          composite: true,
          tsBuildInfoFile: 'lib/.tsbuildinfo',
          baseUrl: config.repoRoot,
          paths: {
            '@deepseek-ai/cordis': ['deepseek-harness/vendor/cordis/lib/types/index.d.ts'],
            '@deepseek-ai/schemastery': [
              'deepseek-harness/vendor/schemastery/lib/types/index.d.ts',
            ],
            '@deepseek-ai/dsh-system-prompt': [
              'deepseek-harness/packages/core/system-prompt/lib/types/index.d.ts',
            ],
          },
        },
        include: ['src'],
      },
      null,
      2,
    ) + '\n',
  )
  const parentSource = await readFile(join(input.parent.sourceRoot, 'src', 'index.ts'), 'utf8')
  const close = parentSource.lastIndexOf('\n}')
  if (close === -1) throw new Error('real builder: parent candidate apply function is malformed')
  const behavior = [
    '',
    '  ctx.systemPrompt.section({',
    `    name: ${JSON.stringify(`candidate:generation-${input.generation}`)},`,
    `    order: ${100 + input.generation},`,
    `    text: ${JSON.stringify(`Candidate hypothesis: ${input.proposal.hypothesis}`)},`,
    '  })',
  ].join('\n')
  await writeFile(
    join(candidateRoot, 'src', 'index.ts'),
    parentSource.slice(0, close) + behavior + parentSource.slice(close),
  )
  const receipt = await buildCandidate({
    sourceRoot: candidateRoot,
    sourceFiles: SOURCE_FILES,
    tscBin: join(config.repoRoot, 'node_modules', '.bin', 'tsc'),
  })
  const identity = {
    sourceHash: receipt.sourceHash,
    bundleHash: receipt.bundleHash,
    capsuleHash: receipt.capsuleHash,
    proposalDigest: input.proposal.artifactDigest,
    parentCandidateId: input.parent.candidateId,
  }
  const built: BuiltCandidate = {
    candidateId: `sha256:${receipt.sourceHash}`,
    sourceDigest: `sha256:${receipt.sourceHash}`,
    capsuleDigest: `sha256:${receipt.capsuleHash}`,
    buildManifestDigest: sha256(JSON.stringify(identity)),
    sourceRoot: candidateRoot,
    evidenceRefs: input.proposal.evidenceRefs,
  }
  await writeExclusive(receiptPath, JSON.stringify(built, null, 2) + '\n')
  return built
}

function evaluatorRunId(config: StableDemoConfig, spec: StableEvaluationSpec): string {
  return `stable-${createHash('sha256').update(spec.idempotencyKey).digest('hex').slice(0, 24)}`
}

function summaryPath(config: StableDemoConfig, runId: string): string {
  return join(config.stateDir, 'external-evaluator', runId, 'summary.json')
}

function evaluationProvider(config: StableDemoConfig, spec: StableEvaluationSpec) {
  const runId = evaluatorRunId(config, spec)
  return {
    async inspect() {
      const summary = await stat(summaryPath(config, runId)).catch(() => null)
      if (summary?.isFile()) return { status: 'terminal' as const, externalJobId: runId }
      const directory = await stat(join(config.stateDir, 'external-evaluator', runId)).catch(
        () => null,
      )
      if (directory !== null)
        throw new Error(`real evaluator: incomplete prior external job ${runId}`)
      return { status: 'absent' as const }
    },
    async launch() {
      await mkdir(join(config.stateDir, 'external-evaluator'), { recursive: true, mode: 0o700 })
      await exec(
        join(config.repoRoot, 'node_modules', '.bin', 'tsx'),
        [join(config.repoRoot, 'scripts', 'run-gate5-real-calibration.ts')],
        {
          cwd: config.repoRoot,
          env: {
            ...process.env,
            GATE5_RUN_ID: runId,
            GATE5_TASK_IDS: spec.taskId,
            GATE5_ATTEMPTS: '1',
            GATE5_CONCURRENCY: '1',
            DSH_RSI_CANDIDATE_ROOT: spec.candidate.sourceRoot,
            DSH_RSI_EVALUATOR_ROOT: join(config.stateDir, 'external-evaluator'),
            TB21_DIR: config.terminalBenchRoot,
          },
        },
      )
      return { externalJobId: runId }
    },
    async collect(externalJobId: string): Promise<EvaluationObservation> {
      if (externalJobId !== runId) throw new Error('real evaluator: external job identity changed')
      const bytes = await readFile(summaryPath(config, runId), 'utf8')
      const summary = JSON.parse(bytes) as {
        normalized: Array<{
          status: 'PASS' | 'FAIL' | 'INVALID'
          reward: number | null
          costUsd: number
        }>
      }
      const row = summary.normalized[0]
      if (row === undefined || summary.normalized.length !== 1) {
        throw new Error('real evaluator: expected one normalized trial')
      }
      return {
        candidateId: spec.candidate.candidateId,
        taskId: spec.taskId,
        attemptIndex: 0,
        status: row.status === 'PASS' ? 'pass' : row.status === 'FAIL' ? 'fail' : 'invalid',
        reward: row.reward,
        costUsd: row.costUsd,
        rawEvidenceDigests: [sha256(bytes)],
      } as EvaluationObservation
    },
  }
}

export async function createRealCapabilities(
  config: StableDemoConfig,
): Promise<StableDemoCapabilities> {
  const baselineRoot = join(config.repoRoot, 'packages', 'candidate-baseline')
  const receipt = await buildCandidate({
    sourceRoot: baselineRoot,
    sourceFiles: SOURCE_FILES,
    tscBin: join(config.repoRoot, 'node_modules', '.bin', 'tsc'),
  })
  return {
    preflight: () => runDoctor(config),
    baseline: {
      candidateId: 'baseline',
      sourceDigest: `sha256:${receipt.sourceHash}`,
      capsuleDigest: `sha256:${receipt.capsuleHash}`,
      buildManifestDigest: sha256(
        JSON.stringify({
          sourceHash: receipt.sourceHash,
          bundleHash: receipt.bundleHash,
          capsuleHash: receipt.capsuleHash,
        }),
      ),
      sourceRoot: baselineRoot,
      evidenceRefs: [],
    },
    async observedTaskIds() {
      const split = JSON.parse(await readFile(config.splitCommitmentPath, 'utf8')) as {
        observedTaskIds?: unknown
      }
      if (
        !Array.isArray(split.observedTaskIds) ||
        split.observedTaskIds.some((id) => typeof id !== 'string')
      ) {
        throw new Error('real capabilities: observed split is invalid')
      }
      return split.observedTaskIds as string[]
    },
    propose: (input) => realProposal(config, input),
    build: (input) => realBuild(config, input),
    evaluationProvider: (spec) => evaluationProvider(config, spec),
    reserveUsd: () => config.limits.budgetUsd / 15,
  }
}
