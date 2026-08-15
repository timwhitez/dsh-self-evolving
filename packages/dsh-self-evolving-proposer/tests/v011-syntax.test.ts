import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { snapshotV011Tree } from '@dsh-self-evolving/candidate-sdk'
import { validateV011CandidatePolicy, validateV011TypeScriptSyntax } from '../src/v011-tools.js'

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

  it('rejects NodeNext extension drift and nonexistent Cordis disposal APIs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-v011-static-contract-'))
    roots.push(root)
    await mkdir(join(root, 'src'))
    await writeFile(
      join(root, 'src/index.ts'),
      "import * as Child from './child'\nexport function apply(ctx: { onDispose: () => void }) { ctx.onDispose(); return Child }\n",
    )
    await expect(validateV011TypeScriptSyntax(root, ['src/index.ts'])).rejects.toThrow(
      /must end in \.js.*onDispose/s,
    )
    await writeFile(
      join(root, 'src/index.ts'),
      "import * as Child from './child.js'\nexport function apply() { return Child }\n",
    )
    await expect(validateV011TypeScriptSyntax(root, ['src/index.ts'])).resolves.toBeUndefined()
  })

  it('rejects comment-sensitive source-reading candidate tests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-v011-test-contract-'))
    roots.push(root)
    await mkdir(join(root, 'tests'))
    await writeFile(
      join(root, 'tests/mechanism.spec.ts'),
      "import { readFile } from 'node:fs/promises'\nimport { expect, it } from 'vitest'\nit('checks text', async () => { const source = await readFile('src/index.ts', 'utf8'); expect(source).not.toContain('export default') })\n",
    )
    await expect(validateV011TypeScriptSyntax(root, ['tests/mechanism.spec.ts'])).rejects.toThrow(
      /reads source files.*comment-sensitive/s,
    )
    await writeFile(
      join(root, 'tests/mechanism.spec.ts'),
      "import { expect, it } from 'vitest'\nit('checks behavior', () => { expect({ apply() {} }).toHaveProperty('apply') })\n",
    )
    await expect(
      validateV011TypeScriptSyntax(root, ['tests/mechanism.spec.ts']),
    ).resolves.toBeUndefined()
  })

  it('runs the trusted admission import policy before proposal finish', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-v011-policy-'))
    roots.push(root)
    await Promise.all([mkdir(join(root, 'src')), mkdir(join(root, 'tests'))])
    await writeFile(join(root, 'src/index.ts'), 'export const value = 1\n')
    await writeFile(
      join(root, 'tests/mechanism.spec.ts'),
      "import { existsSync } from 'node:fs'\nimport { expect, it } from 'vitest'\nit('checks', () => expect(existsSync('.')).toBe(true))\n",
    )
    await expect(validateV011CandidatePolicy(await snapshotV011Tree(root))).rejects.toThrow(
      /tests\/mechanism\.spec\.ts:1 import-node-disallowed node:fs/,
    )
    await writeFile(
      join(root, 'tests/mechanism.spec.ts'),
      "import { expect, it } from 'vitest'\nit('checks', () => expect(1).toBe(1))\n",
    )
    await expect(validateV011CandidatePolicy(await snapshotV011Tree(root))).resolves.toBeUndefined()
  })
})
