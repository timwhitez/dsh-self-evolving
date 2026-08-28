import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recoverIncompleteStableProposalPublication } from '../src/real-capabilities.js'

let root: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'stable-proposal-publication-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('stable proposal publication recovery', () => {
  const publicationFiles = [
    'gateway-receipts.json',
    'idempotency-key.json',
    'proposal.json',
    'sandbox-resource.json',
  ] as const

  it.each(publicationFiles)(
    'quarantines a crash after publishing %s while preserving durable gateway requests',
    async (lastPublished) => {
      const artifactDir = join(root!, 'artifacts', 'proposal-1-1')
      const gatewayStateDir = join(root!, 'proposal-gateway-requests', 'proposal-1-1')
      const legacyGatewayState = join(artifactDir, 'gateway-requests')
      await mkdir(legacyGatewayState, { recursive: true })
      await writeFile(join(legacyGatewayState, 'request-a.json'), 'DURABLE\n')
      for (const name of publicationFiles) {
        await writeFile(join(artifactDir, name), `${name}\n`)
        if (name === lastPublished) break
      }

      const result = await recoverIncompleteStableProposalPublication({
        stateDir: root!,
        artifactDir,
        gatewayStateDir,
      })

      expect(result.quarantined).toBe(true)
      expect(await stat(artifactDir).catch(() => null)).toBeNull()
      expect(await readFile(join(gatewayStateDir, 'request-a.json'), 'utf8')).toBe('DURABLE\n')
      expect(await readFile(join(result.quarantinePath!, lastPublished), 'utf8')).toBe(
        `${lastPublished}\n`,
      )
      expect(
        await stat(join(result.quarantinePath!, 'gateway-requests')).catch(() => null),
      ).toBeNull()
    },
  )

  it('keeps the already-migrated durable request store when recovery resumes', async () => {
    const artifactDir = join(root!, 'artifacts', 'proposal-2-1')
    const gatewayStateDir = join(root!, 'proposal-gateway-requests', 'proposal-2-1')
    await mkdir(artifactDir, { recursive: true })
    await writeFile(join(artifactDir, 'gateway-receipts.json'), 'PARTIAL\n')
    await mkdir(gatewayStateDir, { recursive: true })
    await writeFile(join(gatewayStateDir, 'request-b.json'), 'REPLAY\n')

    const result = await recoverIncompleteStableProposalPublication({
      stateDir: root!,
      artifactDir,
      gatewayStateDir,
    })

    expect(result.quarantined).toBe(true)
    expect(await readFile(join(gatewayStateDir, 'request-b.json'), 'utf8')).toBe('REPLAY\n')
    expect(await readFile(join(result.quarantinePath!, 'gateway-receipts.json'), 'utf8')).toBe(
      'PARTIAL\n',
    )
  })
})
