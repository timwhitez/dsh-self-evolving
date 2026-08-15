import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  readSourceArchiveIdentity,
  verifySourceArchiveIdentity,
  type SourceArchiveIdentity,
} from '../src/source-identity.js'

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

describe('source archive identity', () => {
  it('accepts exact source and rejects tampering or unexpected code files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-source-identity-'))
    await mkdir(join(root, 'packages', 'example', 'src'), { recursive: true })
    await writeFile(join(root, 'packages', 'example', 'src', 'index.ts'), 'export const x = 1\n')
    const identity: SourceArchiveIdentity = {
      schemaVersion: 1,
      commit: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      files: {
        'packages/example/src/index.ts': digest('export const x = 1\n'),
      },
    }
    await writeFile(
      join(root, '.dsh-self-evolving-source-identity.json'),
      JSON.stringify(identity) + '\n',
    )
    const loaded = await readSourceArchiveIdentity(root)
    expect(loaded).toEqual(identity)
    await expect(verifySourceArchiveIdentity(root, identity)).resolves.toMatchObject({
      valid: true,
    })

    await writeFile(join(root, 'packages', 'example', 'src', 'index.ts'), 'export const x = 2\n')
    await expect(verifySourceArchiveIdentity(root, identity)).resolves.toMatchObject({
      valid: false,
      detail: expect.stringContaining('hash mismatch'),
    })
    await writeFile(join(root, 'packages', 'example', 'src', 'index.ts'), 'export const x = 1\n')
    await writeFile(join(root, 'packages', 'example', 'src', 'extra.ts'), 'export {}\n')
    await expect(verifySourceArchiveIdentity(root, identity)).resolves.toMatchObject({
      valid: false,
      detail: expect.stringContaining('inventory'),
    })
  })
})
