import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, chmod, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { invokeSealedWorker, type CeremonyRequest, type CeremonyTask } from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const workerPath = join(here, '..', 'lib', 'worker.js')
const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`

function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    execFile(command, args, (error) => resolve(error ? Number(error.code ?? 1) : 0))
  })
}

function taskInventory(): CeremonyTask[] {
  return Array.from({ length: 89 }, (_, index) => ({
    taskId: `synthetic-${String(index).padStart(3, '0')}`,
    category: `category-${index % 9}`,
    difficulty: 'not-used',
    agentTimeoutSec: [900, 1800, 3600][index % 3]!,
    allowInternet: index % 2 === 0,
  }))
}

describe('sealed worker OS/process boundary', () => {
  it('keeps private state outside the public worker response and locks mutation', async () => {
    await access(workerPath)
    const root = await mkdtemp(join(tmpdir(), 'sealed-worker-e2e-'))
    await chmod(root, 0o755)
    const privateDir = join(root, 'sealed-private')
    const publicDir = join(root, 'controller-public')
    const request: CeremonyRequest = {
      operation: 'ceremony',
      ceremonyId: 'synthetic-worker-e2e',
      privateDir,
      publicDir,
      tasks: taskInventory(),
      datasetDigest: digest('dataset-e2e'),
      protocolHash: digest('protocol-e2e'),
      splitterCodeHash: digest('worker-e2e'),
    }
    const ceremony = await invokeSealedWorker(workerPath, request)
    expect(ceremony.operation).toBe('ceremony')
    expect(JSON.stringify(ceremony)).not.toContain('seedHex')
    expect(JSON.stringify(ceremony)).not.toContain('assignment')

    if (process.getuid?.() === 0) {
      const status = await run('/usr/bin/setpriv', [
        '--reuid=65534',
        '--regid=65534',
        '--clear-groups',
        '/usr/bin/test',
        '-r',
        join(privateDir, 'ceremony-state.json'),
      ])
      expect(status).not.toBe(0)
    }

    const identity = {
      runId: 'synthetic-run-e2e',
      candidateId: digest('candidate-e2e'),
      sourceDigest: digest('source-e2e'),
      capsuleDigest: digest('capsule-e2e'),
      runManifestDigest: digest('manifest-e2e'),
      baselineCandidateId: digest('baseline-candidate-e2e'),
      baselineCapsuleDigest: digest('baseline-capsule-e2e'),
      modelRouteHash: digest('model-route-e2e'),
      protocolHash: digest('protocol-e2e'),
      sealedPlanHash: digest('sealed-plan-e2e'),
      analysisContainerHash: digest('analysis-container-e2e'),
    }
    await invokeSealedWorker(workerPath, {
      operation: 'lock',
      privateDir,
      publicDir,
      identity,
    })
    await expect(
      invokeSealedWorker(workerPath, {
        operation: 'authorize',
        privateDir,
        principal: 'proposer',
        requestedOperation: 'propose',
      }),
    ).rejects.toThrow(/LOCKED/)
    const lockReceipt = JSON.parse(await readFile(join(publicDir, 'candidate-lock.json'), 'utf8'))
    expect(lockReceipt.identity).toEqual(identity)
    expect(lockReceipt.splitMerkleRoot).toBe(
      ceremony.operation === 'ceremony' ? ceremony.view.commitment.merkleRoot : '',
    )
    expect(lockReceipt.lockHash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('has no sealed dump/reveal operation in the worker protocol', async () => {
    await expect(
      invokeSealedWorker(workerPath, { operation: 'read-sealed' } as never),
    ).rejects.toThrow(/unsupported operation/)
  })
})
