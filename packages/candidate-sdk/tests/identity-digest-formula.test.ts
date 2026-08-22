import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildCanonicalArchive,
  candidateIdFromArchive,
  declareFiles,
} from '../src/index.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function base32Prefix(bytes: Uint8Array, length = 26): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let value = 0
  let bits = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5 && output.length < length) {
      bits -= 5
      output += alphabet[(value >>> bits) & 31]!
    }
    if (output.length === length) break
  }
  if (bits > 0 && output.length < length) {
    output += alphabet[(value << (5 - bits)) & 31]!
  }
  return output.slice(0, length)
}

function expectedCandidateId(bytes: Uint8Array): string {
  const digest = createHash('sha256').update(bytes).digest()
  return `c_${base32Prefix(digest)}`
}

async function archiveWithContent(content: string) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-candidate-id-formula-'))
  roots.push(root)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'src.ts'), content)
  return buildCanonicalArchive(declareFiles(root, ['src.ts']))
}

describe('candidate ID digest formula', () => {
  it('matches base32(sha256(canonical archive)) exactly', async () => {
    const archive = await archiveWithContent('export const value = 1\n')

    expect(archive.candidateId).toBe(expectedCandidateId(archive.bytes))
    expect(archive.candidateId).toBe(
      `c_${base32Prefix(Buffer.from(archive.hash, 'hex'))}`,
    )
    expect(candidateIdFromArchive(archive.bytes)).toEqual({
      hash: archive.hash,
      candidateId: archive.candidateId,
    })
  })

  it('does not alias archives with the same tar header but different content', async () => {
    const first = await archiveWithContent('export const value = 1\n')
    const second = await archiveWithContent('export const value = 2\n')

    expect(Buffer.from(first.bytes).subarray(0, 512)).toEqual(
      Buffer.from(second.bytes).subarray(0, 512),
    )
    expect(first.hash).not.toBe(second.hash)
    expect(first.candidateId).not.toBe(second.candidateId)
  })
})
