import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateV011TypeScriptSyntax } from '../src/v011-tools.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('v0.1.1 validate_child TypeScript syntax preflight', () => {
  it('rejects a generated source syntax error before trusted build admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-v011-syntax-'))
    roots.push(root)
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src/index.ts'), 'export const text = "user\'s first push")\n')
    await expect(validateV011TypeScriptSyntax(root, ['src/index.ts'])).rejects.toThrow(
      /src\/index\.ts.*expected/s,
    )
    await writeFile(join(root, 'src/index.ts'), 'export const text = "valid"\n')
    await expect(validateV011TypeScriptSyntax(root, ['src/index.ts'])).resolves.toBeUndefined()
  })
})
