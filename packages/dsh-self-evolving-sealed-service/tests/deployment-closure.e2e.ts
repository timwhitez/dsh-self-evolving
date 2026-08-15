import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { CeremonyRequest, CeremonyTask } from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const temporaryRoots: string[] = []
const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`

function invokeWorker(workerPath: string, request: CeremonyRequest): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('node', [workerPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8')
      if (code === 0) resolvePromise(output)
      else
        reject(
          new Error(
            `worker exited ${String(code)}: ${Buffer.concat(stderr).toString('utf8')}${output}`,
          ),
        )
    })
    child.stdin.end(JSON.stringify(request))
  })
}

function inventory(): CeremonyTask[] {
  return Array.from({ length: 89 }, (_, index) => ({
    taskId: `closure-${String(index).padStart(3, '0')}`,
    category: `category-${index % 9}`,
    difficulty: 'not-used',
    agentTimeoutSec: [900, 1800, 3600][index % 3]!,
    allowInternet: index % 2 === 0,
  }))
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('sealed-service production deployment closure', () => {
  it('boots from the minimal runtime closure without core or Cordis', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sealed-deployment-closure-'))
    temporaryRoots.push(root)
    await chmod(root, 0o755)
    const deployment = join(root, 'runtime')
    const searchPackage = join(deployment, 'node_modules', '@dsh-self-evolving', 'search')
    await mkdir(join(searchPackage, 'lib'), { recursive: true })
    await cp(
      join(repoRoot, 'packages', 'dsh-self-evolving-sealed-service', 'lib'),
      join(deployment, 'lib'),
      {
        recursive: true,
      },
    )
    await Promise.all(
      ['split.js', 'calibration.js', 'rng.js'].map((file) =>
        cp(
          join(repoRoot, 'packages', 'dsh-self-evolving-search', 'lib', file),
          join(searchPackage, 'lib', file),
        ),
      ),
    )
    await writeFile(join(deployment, 'package.json'), '{"type":"module"}\n')
    await writeFile(
      join(searchPackage, 'package.json'),
      JSON.stringify({
        name: '@dsh-self-evolving/search',
        type: 'module',
        exports: {
          './split': './lib/split.js',
          './calibration': './lib/calibration.js',
        },
      }) + '\n',
    )

    await expect(
      access(join(deployment, 'node_modules', '@dsh-self-evolving', 'core')),
    ).rejects.toThrow()
    const deployedService = await readFile(join(deployment, 'lib', 'service.js'), 'utf8')
    expect(deployedService).not.toContain('@dsh-self-evolving/core')
    expect(deployedService).not.toContain('@deepseek-ai/cordis')

    const request: CeremonyRequest = {
      operation: 'ceremony',
      ceremonyId: 'production-closure-e2e',
      privateDir: join(root, 'private'),
      publicDir: join(root, 'public'),
      tasks: inventory(),
      datasetDigest: digest('closure-dataset'),
      protocolHash: digest('closure-protocol'),
      splitterCodeHash: digest('closure-splitter'),
    }
    const stdout = await invokeWorker(join(deployment, 'lib', 'worker.js'), request)
    const response = JSON.parse(stdout) as {
      ok: boolean
      view: { observedTaskIds: string[]; guardHandles: string[]; sealedCount: number }
    }
    expect(response.ok).toBe(true)
    expect(response.view.observedTaskIds).toHaveLength(48)
    expect(response.view.guardHandles).toHaveLength(12)
    expect(response.view.sealedCount).toBe(29)
    expect(stdout).not.toContain('seedHex')
    expect(stdout).not.toContain('assignment')
  }, 30_000)
})
