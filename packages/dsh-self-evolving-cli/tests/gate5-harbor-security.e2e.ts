/** Real Harbor proof that a candidate gets only a Unix model capability. */
import { execFile } from 'node:child_process'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { buildCandidate, packCapsule } from '@dsh-self-evolving/candidate-sdk'
import {
  buildJobConfig,
  buildRegistryEntry,
  jobConfigToYaml,
  packAcpBinaryArchive,
} from '../../../benchmark-adapters/terminal-bench/src/index.js'
import {
  GATE5_MODEL_SOCKET_TARGET,
  assertCompleteGate5BrokerEvidence,
  createGate5BrokerSigningAuthority,
  prepareGate5TaskOverlay,
  sanitizeGate5HarborEnvironment,
  startGate5CredentialBroker,
  type Gate5BrokerEvidence,
  type Gate5BrokerPolicy,
} from '../src/gate5-security.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const harborDir = join(repoRoot, 'harbor')
const harborBin = join(harborDir, '.venv', 'bin', 'harbor')
const fixtureDir = join(repoRoot, 'benchmark-adapters', 'terminal-bench', 'fixtures', 'smoke-task')
const baselineRoot = join(repoRoot, 'packages', 'candidate-baseline')
const dshRoot = join(repoRoot, 'deepseek-harness')
const tscBin = join(repoRoot, 'node_modules', '.bin', 'tsc')
const hostOnlyCredential = 'gate5-host-only-credential-sentinel'
const route = {
  provider: 'deepseek-official',
  endpoint: 'https://api.deepseek.com/v1',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  maxTokens: 32_768,
}
const policy: Gate5BrokerPolicy = {
  schemaVersion: 1,
  route,
  contextWindow: 1_048_576,
  socketTarget: GATE5_MODEL_SOCKET_TARGET,
  maxTransportRetries: 0,
  reasoningContinuationMaxTurns: 0,
  trialReservationUsdMicros: 1_000_000,
  pricingUnitTokens: 1_000_000,
  cacheHitInputUsdMicrosPerUnit: 2_800,
  cacheMissInputUsdMicrosPerUnit: 140_000,
  outputUsdMicrosPerUnit: 280_000,
  maxInputTokensPerRequest: 1_048_576,
  maxRequests: 4,
  maxRequestBytes: 1024 * 1024,
  maxPayloadBytesTotal: 4 * 1024 * 1024,
  maxReservedOutputTokens: 4 * 32_768,
  maxResponseBytes: 4 * 1024 * 1024,
  maxConnections: 4,
  idleTimeoutMs: 30_000,
  requestTimeoutMs: 120_000,
}
const sourceFiles = [
  'src/index.ts',
  'package.json',
  'candidate.json',
  'cordis.patch.yml',
  'tsconfig.json',
]

let scratch: string
let artifactServer: HttpsServer | undefined

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'gate5-harbor-security-'))
})

afterEach(async () => {
  if (artifactServer !== undefined) {
    await new Promise<void>((done) => artifactServer!.close(() => done()))
    artifactServer = undefined
  }
  await rm(scratch, { recursive: true, force: true })
})

function execResult(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((done, reject) => {
    execFile(
      file,
      args,
      {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        error ? reject(new Error(`${file} failed:\n${stderr}`, { cause: error })) : done(stdout),
    )
  })
}

async function dockerGateway(): Promise<string> {
  const gateway = (
    await execResult('/usr/bin/docker', [
      'network',
      'inspect',
      'bridge',
      '--format',
      '{{(index .IPAM.Config 0).Gateway}}',
    ])
  ).trim()
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(gateway)) {
    throw new Error(`unexpected Docker bridge gateway: ${gateway}`)
  }
  return gateway
}

async function startArtifactServer(
  archivePath: string,
  taskSource: string,
  gateway: string,
): Promise<string> {
  const keyPath = join(scratch, 'artifact.key')
  const certPath = join(scratch, 'artifact.crt')
  await execResult('/usr/bin/openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=dsh-self-evolving-gate5-security',
    '-addext',
    `subjectAltName=IP:${gateway}`,
  ])
  const cert = await readFile(certPath)
  const archive = await readFile(archivePath)
  await writeFile(join(taskSource, 'environment', 'dsh-self-evolving-local-ca.crt'), cert)
  await writeFile(
    join(taskSource, 'environment', 'Dockerfile'),
    [
      'FROM ubuntu:24.04',
      'COPY dsh-self-evolving-local-ca.crt /usr/local/share/ca-certificates/dsh-self-evolving-local-ca.crt',
      'RUN apt-get update && apt-get install -y bash ca-certificates curl && update-ca-certificates',
      'RUN curl -fsS --max-time 10 https://example.com/ -o /dev/null',
      'WORKDIR /app',
      '',
    ].join('\n'),
  )
  artifactServer = createHttpsServer(
    { key: await readFile(keyPath), cert },
    (request, response) => {
      if (request.method !== 'GET' || request.url !== '/dsh-self-evolving-acp.tar.gz') {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, {
        'content-type': 'application/gzip',
        'content-length': String(archive.byteLength),
      })
      response.end(archive)
    },
  )
  await new Promise<void>((done, reject) => {
    artifactServer!.once('error', reject)
    artifactServer!.listen(0, '0.0.0.0', done)
  })
  return `https://${gateway}:${(artifactServer.address() as AddressInfo).port}/dsh-self-evolving-acp.tar.gz`
}

async function findSingleTrial(jobDir: string): Promise<string> {
  const entries = await readdir(jobDir, { withFileTypes: true })
  const trials = entries.filter((entry) => entry.isDirectory() && entry.name.includes('__'))
  if (trials.length !== 1) throw new Error(`expected one trial; got ${trials.length}`)
  return join(jobDir, trials[0]!.name)
}

class HostOnlyAdapter extends LlmAdapter {
  hostCredentialObserved = false
  lastFetchAttempts = [
    {
      attemptIndex: 0,
      status: 200,
      retryable: false,
      ambiguous: false,
      discardedUsage: null,
      responseId: null,
    },
  ]

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (process.env['DEEPSEEK_API_KEY'] !== hostOnlyCredential) {
      throw new Error('trusted fixture adapter did not receive its host credential')
    }
    this.hostCredentialObserved = true
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'BROKERED MODEL OK' }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: 'BROKERED MODEL OK' },
    }
    yield {
      type: 'usage',
      usage: { inputTokens: 13, outputTokens: 5, cacheReadTokens: 2, reasoningTokens: 1 },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function probePluginSource(): string {
  return [
    "import { mkdir, readFile, writeFile } from 'node:fs/promises'",
    'async function directNetworkProbe() {',
    '  try {',
    "    const response = await fetch('https://example.com/', { signal: AbortSignal.timeout(5000) })",
    '    await response.arrayBuffer()',
    '    return response.ok',
    '  } catch { return false }',
    '}',
    "export const name = 'gate5-adversarial-probe'",
    'export async function apply() {',
    "  const envSecretPresent = typeof process.env.DEEPSEEK_API_KEY === 'string'",
    '  let fileSecretPresent = false',
    "  try { fileSecretPresent = (await readFile('/run/dsh-self-evolving/provider.secret')).length > 0 } catch {}",
    '  const directNetworkConnected = await directNetworkProbe()',
    "  await mkdir('/logs/agent', { recursive: true })",
    "  await writeFile('/logs/agent/security-probe.json', JSON.stringify({ envSecretPresent, fileSecretPresent, directNetworkConnected }) + '\\n')",
    '}',
    '',
  ].join('\n')
}

describe.skipIf(
  !(await stat(harborBin)
    .then(() => true)
    .catch(() => false)),
)('Gate 5 — real Harbor credential isolation', () => {
  it(
    'denies env/file/direct HTTPS access while allowing the fixed Unix broker and signed accounting',
    { timeout: 480_000 },
    async () => {
      const gateway = await dockerGateway()
      const receipt = await buildCandidate({
        sourceRoot: baselineRoot,
        sourceFiles,
        tscBin,
      })
      const capsuleDir = join(scratch, 'capsule')
      await packCapsule({
        outDir: capsuleDir,
        receipt,
        runnerOverlay: [
          '- id: brokered-responses',
          "  name: '@dsh-self-evolving/llm-responses'",
          '  config:',
          `    gatewaySocketPath: ${GATE5_MODEL_SOCKET_TARGET}`,
          '    reasoningEffort: high',
          '    contextWindow: 1048576',
          '    maxTokens: 32768',
          '    requestDeadlineMs: 120000',
          '- id: adversarial-probe',
          "  name: './adversarial-probe.mjs'",
          '- id: acp-agent',
          "  name: '@deepseek-ai/dsh-acp-demo'",
          '  config:',
          '    provider: deepseek-official',
          '    model: deepseek-v4-flash',
          "    persona: 'Call the model once and finish.'",
          '    workspaceContext: false',
          '    skills:',
          '      enabled: false',
          '    toolJobs: false',
          '    goals: false',
          '- id: self-evolving-candidate',
          "  name: '@dsh-self-evolving/candidate-baseline'",
          '  config:',
          `    candidateId: ${receipt.candidateId}`,
          '    mode: solve',
          '',
        ].join('\n'),
        runnerFiles: {
          'adversarial-probe.mjs': probePluginSource(),
        },
        provenanceJson: '{"protocol":"gate5-credential-broker-v2"}',
        sbomJson: '{"spdxVersion":"SPDX-2.3"}',
        runtimeClosure: {
          catalogRoots: [
            join(repoRoot, 'packages'),
            join(dshRoot, 'packages'),
            join(dshRoot, 'vendor'),
          ],
          seedPackages: ['@deepseek-ai/dsh-acp-demo', '@dsh-self-evolving/llm-responses'],
          entryPackage: '@deepseek-ai/dsh-acp-demo',
          entryBin: 'lib/bin.js',
        },
      })
      const packed = await packAcpBinaryArchive(
        join(capsuleDir, 'runtime'),
        join(scratch, 'dsh-self-evolving-acp.tar.gz'),
      )
      expect((await readFile(packed.archivePath)).includes(Buffer.from(hostOnlyCredential))).toBe(
        false,
      )

      const taskSource = join(scratch, 'task-source')
      const taskDir = join(scratch, 'task-overlay')
      await cp(fixtureDir, taskSource, { recursive: true })
      const archiveUrl = await startArtifactServer(packed.archivePath, taskSource, gateway)
      await prepareGate5TaskOverlay({ sourceDir: taskSource, destinationDir: taskDir })

      const identity = {
        runId: 'gate5-harbor-security-e2e',
        candidateId: receipt.candidateId,
        trialId: 'trial-0000-security',
        taskId: 'smoke',
        attemptIndex: 0,
      }
      const authority = createGate5BrokerSigningAuthority()
      const trustedAdapter = new HostOnlyAdapter()
      const broker = await startGate5CredentialBroker({
        socketPath: join(scratch, 'model.sock'),
        stateDir: join(scratch, 'broker-state'),
        identity,
        policy,
        adapter: trustedAdapter,
        authority,
      })
      const registry = buildRegistryEntry({
        candidateId: receipt.candidateId,
        agentName: 'dsh-self-evolving-gate5-security',
        version: receipt.candidateId,
        archiveUrl,
        archiveSha256: packed.sha256,
        cmd: './dsh-self-evolving-acp',
      })
      const jobsDir = join(scratch, 'jobs')
      const jobName = `gate5-security-${receipt.candidateId.slice(0, 12)}`
      const config = buildJobConfig({
        jobName,
        registryEntry: registry,
        modelName: '',
        tasks: [{ taskId: 'smoke', path: taskDir }],
        nAttempts: 1,
        nConcurrentTrials: 1,
        verifier: { timeoutSec: 120, agentTimeoutSec: 120 },
        idempotencyKey: `gate5-security/${receipt.candidateId}/smoke/0`,
        jobsDir,
        environment: {
          mounts: [
            {
              type: 'bind',
              source: broker.socketPath,
              target: GATE5_MODEL_SOCKET_TARGET,
              read_only: true,
            },
          ],
        },
      })
      const configPath = join(scratch, 'job.yaml')
      const yaml = jobConfigToYaml(config)
      expect(yaml).not.toContain('credential-launcher')
      expect(yaml).not.toContain('provider.secret')
      expect(yaml).not.toContain(hostOnlyCredential)
      await writeFile(configPath, yaml)

      const previousCredential = process.env['DEEPSEEK_API_KEY']
      let evidence: Gate5BrokerEvidence
      process.env['DEEPSEEK_API_KEY'] = hostOnlyCredential
      try {
        const childEnv = sanitizeGate5HarborEnvironment(process.env)
        expect(childEnv['DEEPSEEK_API_KEY']).toBeUndefined()
        await execResult(harborBin, ['job', 'start', '-c', configPath], {
          cwd: harborDir,
          env: childEnv,
        })
      } finally {
        if (previousCredential === undefined) delete process.env['DEEPSEEK_API_KEY']
        else process.env['DEEPSEEK_API_KEY'] = previousCredential
        evidence = await broker.complete()
      }

      expect(trustedAdapter.hostCredentialObserved).toBe(true)
      const trialDir = await findSingleTrial(join(jobsDir, jobName))
      const probe = JSON.parse(
        await readFile(join(trialDir, 'agent', 'security-probe.json'), 'utf8'),
      ) as Record<string, unknown>
      expect(probe).toEqual({
        envSecretPresent: false,
        fileSecretPresent: false,
        directNetworkConnected: false,
      })
      expect(
        assertCompleteGate5BrokerEvidence(evidence, {
          identity,
          policy,
          publicKeySpki: authority.publicKeySpki,
        }).usage,
      ).toEqual({
        inputTokens: 13,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 0,
        reasoningTokens: 1,
        events: 1,
      })
      const summary = JSON.parse(
        await readFile(join(trialDir, 'agent', 'acp-summary.json'), 'utf8'),
      ) as Record<string, unknown>
      expect(summary['error'], JSON.stringify(summary)).toBeUndefined()
      expect(summary['prompt_response']).toBeDefined()
    },
  )
})
