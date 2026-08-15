/** Gate 2: a packed DSH candidate runs through Harbor's real generic ACP agent. */
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:https'
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildCandidate, packCapsule } from '@dsh-self-evolving/candidate-sdk'
import {
  buildJobConfig,
  buildRegistryEntry,
  jobConfigToYaml,
  normalizeTrial,
  packAcpBinaryArchive,
} from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const harborDir = join(repoRoot, 'harbor')
const harborBin = join(harborDir, '.venv', 'bin', 'harbor')
const fixtureDir = join(here, '..', 'fixtures', 'smoke-task')
const baselineRoot = join(repoRoot, 'packages', 'candidate-baseline')
const dshRoot = join(repoRoot, 'deepseek-harness')
const tscBin = join(repoRoot, 'node_modules', '.bin', 'tsc')
const sourceFiles = [
  'src/index.ts',
  'package.json',
  'candidate.json',
  'cordis.patch.yml',
  'tsconfig.json',
]

const mockAdapterSource = [
  "import { LlmAdapter } from '@deepseek-ai/dsh-llm'",
  'class Gate2Mock extends LlmAdapter {',
  '  async * stream() {',
  "    yield { type: 'block-start', index: 0, blockType: 'text' }",
  "    yield { type: 'text-delta', index: 0, text: 'GATE2 ACP OK' }",
  "    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'GATE2 ACP OK' } }",
  "    yield { type: 'finish', reason: { kind: 'stop' } }",
  '  }',
  '}',
  "export const name = 'gate2-mock'",
  "export const inject = ['llm']",
  "export function apply(ctx) { ctx.llm.registerAdapter(['gate2-mock'], new Gate2Mock()) }",
  '',
].join('\n')

let scratch: string | undefined
let artifactServer: Server | undefined

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-harbor-acp-'))
})

afterEach(async () => {
  if (artifactServer !== undefined) {
    await new Promise<void>((done, reject) =>
      artifactServer!.close((error) => (error ? reject(error) : done())),
    )
    artifactServer = undefined
  }
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
  scratch = undefined
})

function execResult(file: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((done, reject) => {
    execFile(
      file,
      args,
      { ...(cwd === undefined ? {} : { cwd }), maxBuffer: 20 * 1024 * 1024 },
      (error, stdout, stderr) =>
        error ? reject(new Error(`${file} failed:\n${stderr}`, { cause: error })) : done(stdout),
    )
  })
}

async function makeTrustedHttpsArtifact(archivePath: string, taskDir: string): Promise<string> {
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
  const keyPath = join(scratch!, 'artifact.key')
  const certPath = join(scratch!, 'artifact.crt')
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
    '/CN=dsh-self-evolving-gate2-artifact',
    '-addext',
    `subjectAltName=IP:${gateway}`,
  ])
  const cert = await readFile(certPath)
  const archive = await readFile(archivePath)
  await writeFile(join(taskDir, 'environment', 'dsh-self-evolving-local-ca.crt'), cert)
  await writeFile(
    join(taskDir, 'environment', 'Dockerfile'),
    [
      'FROM ubuntu:24.04',
      'COPY dsh-self-evolving-local-ca.crt /usr/local/share/ca-certificates/dsh-self-evolving-local-ca.crt',
      'RUN apt-get update && apt-get install -y bash ca-certificates && update-ca-certificates',
      'WORKDIR /app',
      '',
    ].join('\n'),
  )

  artifactServer = createServer({ key: await readFile(keyPath), cert }, (request, response) => {
    if (request.method !== 'GET' || request.url !== '/dsh-self-evolving-acp.tar.gz') {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, {
      'content-type': 'application/gzip',
      'content-length': String(archive.byteLength),
      'cache-control': 'public, max-age=31536000, immutable',
    })
    response.end(archive)
  })
  await new Promise<void>((done, reject) => {
    artifactServer!.once('error', reject)
    artifactServer!.listen(0, '0.0.0.0', done)
  })
  const address = artifactServer.address() as AddressInfo
  return `https://${gateway}:${address.port}/dsh-self-evolving-acp.tar.gz`
}

async function findSingleTrial(jobDir: string): Promise<string> {
  const entries = await readdir(jobDir, { withFileTypes: true })
  const trials = entries.filter((entry) => entry.isDirectory() && entry.name.includes('__'))
  if (trials.length !== 1)
    throw new Error(`expected one trial under ${jobDir}; got ${trials.length}`)
  return join(jobDir, trials[0]!.name)
}

describe.skipIf(
  !(await stat(harborBin)
    .then(() => true)
    .catch(() => false)),
)('Gate 2 — packed DSH candidate through real Harbor ACP', () => {
  it(
    'produces Harbor-native trajectory, ACP events, summary, and an attributable result',
    { timeout: 300_000 },
    async () => {
      const receipt = await buildCandidate({
        sourceRoot: baselineRoot,
        sourceFiles,
        tscBin,
      })
      const capsuleDir = join(scratch!, 'capsule')
      await packCapsule({
        outDir: capsuleDir,
        receipt,
        runnerOverlay: [
          '- id: mock-llm',
          "  name: './mock-llm.mjs'",
          '- id: acp-agent',
          "  name: '@deepseek-ai/dsh-acp-demo'",
          '  config:',
          '    provider: gate2-mock',
          '    model: gate2-mock',
          "    persona: 'Gate 2 Harbor acceptance agent.'",
          '    workspaceContext: false',
          '- id: self-evolving-candidate',
          "  name: '@dsh-self-evolving/candidate-baseline'",
          '  config:',
          `    candidateId: ${receipt.candidateId}`,
          '    mode: solve',
          '',
        ].join('\n'),
        provenanceJson: '{"dsh":"pinned"}',
        sbomJson: '{"spdxVersion":"SPDX-2.3"}',
        runnerFiles: { 'mock-llm.mjs': mockAdapterSource },
        runtimeClosure: {
          catalogRoots: [join(dshRoot, 'packages'), join(dshRoot, 'vendor')],
          seedPackages: ['@deepseek-ai/dsh-acp-demo'],
          entryPackage: '@deepseek-ai/dsh-acp-demo',
          entryBin: 'lib/bin.js',
        },
      })
      const packed = await packAcpBinaryArchive(
        join(capsuleDir, 'runtime'),
        join(scratch!, 'dsh-self-evolving-acp.tar.gz'),
      )
      const taskDir = join(scratch!, 'smoke-task')
      await cp(fixtureDir, taskDir, { recursive: true })
      const archiveUrl = await makeTrustedHttpsArtifact(packed.archivePath, taskDir)
      const registry = buildRegistryEntry({
        candidateId: receipt.candidateId,
        agentName: 'dsh-self-evolving',
        version: receipt.candidateId,
        archiveUrl,
        archiveSha256: packed.sha256,
        cmd: './dsh-self-evolving-acp',
      })
      const jobsDir = join(scratch!, 'jobs')
      const jobName = `dsh-self-evolving-gate2-${receipt.candidateId.slice(0, 12)}`
      const config = buildJobConfig({
        jobName,
        registryEntry: registry,
        // The capsule pins its provider/model. Leaving Harbor's optional model
        // route empty avoids an unrelated session/set_model override.
        modelName: '',
        tasks: [{ taskId: 'smoke', path: taskDir }],
        nAttempts: 1,
        nConcurrentTrials: 1,
        verifier: { timeoutSec: 120, agentTimeoutSec: 120 },
        idempotencyKey: `gate2/${receipt.candidateId}/smoke/0`,
        jobsDir,
      })
      const configPath = join(scratch!, 'job.yaml')
      await writeFile(configPath, jobConfigToYaml(config))
      await execResult(harborBin, ['job', 'start', '-c', configPath], harborDir)

      const trialDir = await findSingleTrial(join(jobsDir, jobName))
      await writeFile(
        join(trialDir, 'attribution.json'),
        JSON.stringify({ candidate_id: receipt.candidateId, attempt_index: 0 }) + '\n',
      )
      const summary = JSON.parse(
        await readFile(join(trialDir, 'agent', 'acp-summary.json'), 'utf8'),
      ) as Record<string, unknown>
      expect(summary['registry_entry_id']).toBe(registry.id)
      expect(summary['initialize']).toBeDefined()
      expect(summary['error'], JSON.stringify(summary)).toBeUndefined()
      expect(summary['prompt_response']).toBeDefined()

      const normalized = await normalizeTrial({
        trialDir,
        expectedCandidateId: receipt.candidateId,
        taskId: 'smoke',
        requireAcpEvidence: true,
      })
      expect(normalized.status).toBe('fail')
      expect(normalized.reward).toBe(0)
      expect(normalized.trajectoryHash).not.toBeNull()
      expect(normalized.acpEventsHash).not.toBeNull()
      expect(normalized.acpSummaryHash).not.toBeNull()
      expect(
        await normalizeTrial({
          trialDir,
          expectedCandidateId: receipt.candidateId,
          taskId: 'smoke',
          requireAcpEvidence: true,
        }),
      ).toEqual(normalized)
    },
  )
})
