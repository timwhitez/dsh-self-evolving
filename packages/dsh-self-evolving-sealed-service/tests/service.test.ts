import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  handleServiceRequest,
  type CandidateLockIdentity,
  type CeremonyRequest,
  type CeremonyTask,
} from '../src/service.js'

const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`

function tasks(): CeremonyTask[] {
  return Array.from({ length: 89 }, (_, index) => ({
    taskId: `task-${String(index).padStart(3, '0')}`,
    category: `category-${index % 7}`,
    difficulty: index % 2 === 0 ? 'SHOULD_NOT_APPEAR_EASY' : 'SHOULD_NOT_APPEAR_HARD',
    agentTimeoutSec: [900, 1800, 3600][index % 3]!,
    allowInternet: index % 2 === 0,
    modifiedInTb21: index % 5 === 0,
  }))
}

async function fixture(): Promise<{
  root: string
  privateDir: string
  publicDir: string
  request: CeremonyRequest
}> {
  const root = await mkdtemp(join(tmpdir(), 'sealed-service-unit-'))
  await chmod(root, 0o755)
  return {
    root,
    privateDir: join(root, 'private'),
    publicDir: join(root, 'public'),
    request: {
      operation: 'ceremony',
      ceremonyId: 'synthetic-ceremony-unit',
      privateDir: join(root, 'private'),
      publicDir: join(root, 'public'),
      tasks: tasks(),
      datasetDigest: digest('dataset'),
      protocolHash: digest('protocol'),
      splitterCodeHash: digest('splitter-code'),
    },
  }
}

function lockIdentity(): CandidateLockIdentity {
  return {
    runId: 'synthetic-run',
    candidateId: digest('candidate'),
    sourceDigest: digest('source'),
    capsuleDigest: digest('capsule'),
    runManifestDigest: digest('manifest'),
    baselineCandidateId: digest('baseline-candidate'),
    baselineCapsuleDigest: digest('baseline-capsule'),
    modelRouteHash: digest('model-route'),
    protocolHash: digest('protocol'),
    sealedPlanHash: digest('sealed-plan'),
    analysisContainerHash: digest('analysis-container'),
  }
}

describe('sealed ceremony service', () => {
  it('keeps seed/mapping private and emits only the prescribed controller view', async () => {
    const f = await fixture()
    const response = await handleServiceRequest(f.request)
    expect(response.operation).toBe('ceremony')
    if (response.operation !== 'ceremony') throw new Error('unexpected response')
    expect(response.view.observedTaskIds).toHaveLength(48)
    expect(response.view.guardHandles).toHaveLength(12)
    expect(response.view.sealedCount).toBe(29)
    expect(response.view.difficultyDimension).toBe('OMITTED')

    const privateRaw = await readFile(join(f.privateDir, 'ceremony-state.json'), 'utf8')
    const publicRaw = await readFile(join(f.publicDir, 'split-commitment.json'), 'utf8')
    const privateState = JSON.parse(privateRaw) as {
      seedHex: string
      assignment: Array<{ taskId: string; label: string }>
    }
    const sealedIds = privateState.assignment
      .filter((entry) => entry.label === 'sealed')
      .map((entry) => entry.taskId)
    expect(privateState.seedHex).toMatch(/^[0-9a-f]{64}$/)
    expect(sealedIds).toHaveLength(29)
    expect(publicRaw).not.toContain(privateState.seedHex)
    for (const sealedId of sealedIds) expect(publicRaw).not.toContain(`"${sealedId}"`)
    expect(publicRaw).not.toContain('SHOULD_NOT_APPEAR')
    expect((await stat(f.privateDir)).mode & 0o777).toBe(0o700)
    expect((await stat(join(f.privateDir, 'ceremony-state.json'))).mode & 0o777).toBe(0o600)
  })

  it('is idempotent only for the exact immutable ceremony identity and inventory', async () => {
    const f = await fixture()
    await handleServiceRequest(f.request)
    const second = await handleServiceRequest(f.request)
    expect(second.operation === 'ceremony' && second.idempotent).toBe(true)
    const changed = structuredClone(f.request)
    changed.tasks[0]!.category = 'changed'
    await expect(handleServiceRequest(changed)).rejects.toThrow(/immutable identity mismatch/)
  })

  it('recovers a missing public receipt but never overwrites conflicting public bytes', async () => {
    const f = await fixture()
    await handleServiceRequest(f.request)
    const receiptPath = join(f.publicDir, 'split-commitment.json')
    await rm(receiptPath)
    await handleServiceRequest(f.request)
    await expect(readFile(receiptPath, 'utf8')).resolves.toContain(f.request.ceremonyId)
    await writeFile(receiptPath, '{"status":"conflict"}\n')
    await expect(handleServiceRequest(f.request)).rejects.toThrow(/PUBLIC_RECEIPT_CONFLICT/)
  })

  it('commits one candidate identity and permanently rejects selector/proposer operations', async () => {
    const f = await fixture()
    await handleServiceRequest(f.request)
    await expect(
      handleServiceRequest({
        operation: 'authorize',
        privateDir: f.privateDir,
        principal: 'proposer',
        requestedOperation: 'propose',
      }),
    ).resolves.toMatchObject({ allowed: true })
    const identity = lockIdentity()
    const first = await handleServiceRequest({
      operation: 'lock',
      privateDir: f.privateDir,
      publicDir: f.publicDir,
      identity,
    })
    expect(first.operation === 'lock' && first.idempotent).toBe(false)
    const second = await handleServiceRequest({
      operation: 'lock',
      privateDir: f.privateDir,
      publicDir: f.publicDir,
      identity,
    })
    expect(second.operation === 'lock' && second.idempotent).toBe(true)
    await expect(
      handleServiceRequest({
        operation: 'authorize',
        privateDir: f.privateDir,
        principal: 'selector',
        requestedOperation: 'select',
      }),
    ).rejects.toThrow(/LOCKED/)
    await expect(
      handleServiceRequest({
        operation: 'lock',
        privateDir: f.privateDir,
        publicDir: f.publicDir,
        identity: { ...identity, candidateId: digest('other') },
      }),
    ).rejects.toThrow(/identity mismatch/)
    await expect(
      handleServiceRequest({
        operation: 'lock',
        privateDir: f.privateDir,
        publicDir: join(f.root, 'other-public'),
        identity,
      }),
    ).rejects.toThrow(/does not match ceremony layout/)
  })

  it('binds the candidate lock to the protocol sealed by the ceremony', async () => {
  const f = await fixture()
  await handleServiceRequest(f.request)
  const statePath = join(f.privateDir, 'ceremony-state.json')
  const receiptPath = join(f.publicDir, 'candidate-lock.json')
  const stateBefore = await readFile(statePath, 'utf8')
  const foreignProtocolIdentity = {
    ...lockIdentity(),
    protocolHash: digest('foreign-protocol'),
  }

  await expect(
    handleServiceRequest({
      operation: 'lock',
      privateDir: f.privateDir,
      publicDir: f.publicDir,
      identity: foreignProtocolIdentity,
    }),
  ).rejects.toThrow(/protocolHash does not match sealed ceremony/)

  await expect(readFile(statePath, 'utf8')).resolves.toBe(stateBefore)
  await expect(readFile(receiptPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(
    handleServiceRequest({
      operation: 'lock',
      privateDir: f.privateDir,
      publicDir: f.publicDir,
      identity: lockIdentity(),
    }),
  ).resolves.toMatchObject({ operation: 'lock', idempotent: false })
})

  it('rejects private-state tampering before authorization', async () => {
    const f = await fixture()
    await handleServiceRequest(f.request)
    const statePath = join(f.privateDir, 'ceremony-state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { seedHex: string }
    state.seedHex = '0'.repeat(64)
    await writeFile(statePath, JSON.stringify(state) + '\n')
    await expect(
      handleServiceRequest({
        operation: 'authorize',
        privateDir: f.privateDir,
        principal: 'proposer',
        requestedOperation: 'propose',
      }),
    ).rejects.toThrow(/EVIDENCE_CORRUPT/)
  })
})
