/**
 * Adapter unit tests: registry entry, job config, idempotency.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildRegistryEntry,
  buildJobConfig,
  jobConfigToYaml,
  idempotencyKey,
  reserveKey,
  isReserved,
  packAcpBinaryArchive,
} from '../src/index.js'

const sha = 'a'.repeat(64)

describe('ACP registry entry', () => {
  it('packs a deterministic tar.gz whose root contains the Harbor launcher', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-acp-archive-'))
    try {
      const runtime = join(dir, 'runtime')
      await mkdir(join(runtime, 'node_modules'), { recursive: true })
      await writeFile(join(runtime, 'dsh-self-evolving-acp'), '#!/usr/bin/env node\n')
      await chmod(join(runtime, 'dsh-self-evolving-acp'), 0o755)
      await writeFile(join(runtime, 'package-closure.json'), '{}\n')
      const first = await packAcpBinaryArchive(runtime, join(dir, 'first.tar.gz'))
      const second = await packAcpBinaryArchive(runtime, join(dir, 'second.tar.gz'))
      expect(first.sha256).toBe(second.sha256)
      expect(await readFile(first.archivePath)).toEqual(await readFile(second.archivePath))
      expect((await readFile(first.archivePath)).subarray(0, 2).toString('hex')).toBe('1f8b')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('builds a linux-x86_64 entry with HTTPS + sha256 checksum', () => {
    const entry = buildRegistryEntry({
      candidateId: 'c_abc123',
      agentName: 'dsh-self-evolving',
      version: 'c_abc123',
      archiveUrl: 'https://artifacts.example/dsh-self-evolving-c_abc123.tar.gz',
      archiveSha256: sha,
      cmd: './dsh-self-evolving-acp',
    })
    expect(entry.id).toBe('dsh-self-evolving-c_abc123')
    expect(entry.distribution.binary!['linux-x86_64']!.checksum).toBe(sha)
    expect(entry.distribution.binary!['linux-x86_64']!.archive).toMatch(/^https:\/\//)
  })

  it('rejects a non-HTTPS archive URL', () => {
    expect(() =>
      buildRegistryEntry({
        candidateId: 'c_x',
        agentName: 'dsh-self-evolving',
        version: 'c_x',
        archiveUrl: 'http://insecure.example/x.tar.gz',
        archiveSha256: sha,
        cmd: './x',
      }),
    ).toThrow(/HTTPS/)
  })

  it('rejects a malformed checksum', () => {
    expect(() =>
      buildRegistryEntry({
        candidateId: 'c_x',
        agentName: 'dsh-self-evolving',
        version: 'c_x',
        archiveUrl: 'https://x.example/x.tar.gz',
        archiveSha256: 'tooshort',
        cmd: './x',
      }),
    ).toThrow(/sha256/)
  })
})

describe('job config generation', () => {
  const entry = buildRegistryEntry({
    candidateId: 'c_abc',
    agentName: 'dsh-self-evolving',
    version: 'c_abc',
    archiveUrl: 'https://x.example/x.tar.gz',
    archiveSha256: sha,
    cmd: './dsh-self-evolving-acp',
  })

  it('emits a Harbor JobConfig with inline registry entry + idempotency metadata', () => {
    const cfg = buildJobConfig({
      jobName: 'dsh-self-evolving-run-001',
      registryEntry: entry,
      modelName: 'dsh-self-evolving-provider/deepseek-v4-flash',
      tasks: [{ taskId: 'extract-elf', path: '/tb/original-tasks/extract-elf' }],
      nAttempts: 3,
      nConcurrentTrials: 1,
      verifier: { timeoutSec: 180, agentTimeoutSec: 900 },
      idempotencyKey: 'dsh-self-evolving-key-001',
      jobsDir: 'jobs',
      agentEnv: { RSI_TRACE_MODE: 'content-free' },
      environment: {
        env: { CURL_CA_BUNDLE: '/run/dsh-self-evolving/artifact-ca.crt' },
        mounts: [
          {
            type: 'bind',
            source: '/trusted/artifact-ca.crt',
            target: '/run/dsh-self-evolving/artifact-ca.crt',
            read_only: true,
          },
        ],
      },
    })
    expect(cfg.agents[0]!.name).toBe('acp')
    expect(cfg.agents[0]!.kwargs.registry_entry).toBe(entry)
    expect(cfg.n_attempts).toBe(3)
    expect(cfg.tasks[0]!.path).toBe('/tb/original-tasks/extract-elf')
    expect(cfg.agents[0]!.env).toEqual({ RSI_TRACE_MODE: 'content-free' })
    expect(cfg.environment.mounts).toHaveLength(1)
    expect(jobConfigToYaml(cfg)).not.toMatch(/sk-[A-Za-z0-9]/)
    expect((cfg.metadata['dsh-self-evolving'] as Record<string, unknown>)['idempotency_key']).toBe(
      'dsh-self-evolving-key-001',
    )
  })

  it('serializes to YAML deterministically', () => {
    const cfg = buildJobConfig({
      jobName: 'dsh-self-evolving-run-001',
      registryEntry: entry,
      modelName: 'm',
      tasks: [{ taskId: 't', path: '/t' }],
      nAttempts: 1,
      nConcurrentTrials: 1,
      verifier: { timeoutSec: 60, agentTimeoutSec: 60 },
      idempotencyKey: 'k',
      jobsDir: 'jobs',
    })
    const yaml1 = jobConfigToYaml(cfg)
    const yaml2 = jobConfigToYaml(cfg)
    expect(yaml1).toBe(yaml2)
    expect(yaml1).toContain('name: acp')
    expect(yaml1).toContain('idempotency_key: k')
  })

  it('rejects an empty task list', () => {
    expect(() =>
      buildJobConfig({
        jobName: 'x',
        registryEntry: entry,
        modelName: 'm',
        tasks: [],
        nAttempts: 1,
        nConcurrentTrials: 1,
        verifier: { timeoutSec: 60, agentTimeoutSec: 60 },
        idempotencyKey: 'k',
        jobsDir: 'jobs',
      }),
    ).toThrow(/no tasks/)
  })

  it('rejects sensitive agent environment values, including host templates', () => {
    expect(() =>
      buildJobConfig({
        jobName: 'x',
        registryEntry: entry,
        modelName: 'm',
        tasks: [{ taskId: 't', path: '/t' }],
        nAttempts: 1,
        nConcurrentTrials: 1,
        verifier: { timeoutSec: 60, agentTimeoutSec: 60 },
        idempotencyKey: 'k',
        jobsDir: 'jobs',
        agentEnv: { DEEPSEEK_API_KEY: 'literal-secret' },
      }),
    ).toThrow(/sensitive agent env.*process arguments/)
  })
})

describe('idempotency store', () => {
  let dir: string | undefined
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-idem-'))
  })
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('reserves a key once and refuses the second', async () => {
    const store = { ledgerDir: dir! }
    const key = idempotencyKey('c_abc', 'extract-elf', 0)
    const rec = {
      key,
      candidateId: 'c_abc',
      taskId: 'extract-elf',
      attemptIndex: 0,
      submittedAt: 't',
    }
    expect(await reserveKey(store, rec)).toBe(true)
    expect(await reserveKey(store, rec)).toBe(false)
    expect(await isReserved(store, key)).toBe(true)
  })

  it('produces the same key for the same (candidate, task, attempt)', () => {
    expect(idempotencyKey('c_a', 'extract-elf', 0)).toBe(idempotencyKey('c_a', 'extract-elf', 0))
    expect(idempotencyKey('c_a', 'extract-elf', 0)).not.toBe(
      idempotencyKey('c_a', 'extract-elf', 1),
    )
  })
})
