import {
  copyFile,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCandidate } from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const baselineRoot = join(repoRoot, 'packages', 'candidate-baseline')
const tscBin = join(repoRoot, 'node_modules', '.bin', 'tsc')
const sourceFiles = [
  'src/index.ts',
  'package.json',
  'candidate.json',
  'cordis.patch.yml',
  'tsconfig.json',
]

const scratchRoots: string[] = []

async function fixture(name: string): Promise<string> {
  const root = join(tmpdir(), `dsh-builder-contract-${process.pid}-${Date.now()}-${name}`)
  scratchRoots.push(root)
  for (const path of sourceFiles) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await copyFile(join(baselineRoot, path), join(root, path))
  }
  return root
}

afterEach(async () => {
  await Promise.all(
    scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

function sameArtifacts(
  left: { path: string; bytes: Uint8Array }[],
  right: { path: string; bytes: Uint8Array }[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (file, index) =>
        file.path === right[index]?.path && Buffer.from(file.bytes).equals(right[index]!.bytes),
    )
  )
}

describe('trusted builder source snapshot and compiler sandbox', () => {
  const unsafeConfigs: Array<[string, (config: Record<string, unknown>, escape: string) => void]> =
    [
      [
        'outDir',
        (config, escape) => {
          ;(config['compilerOptions'] as Record<string, unknown>)['outDir'] = escape
        },
      ],
      [
        'tsBuildInfoFile',
        (config, escape) => {
          ;(config['compilerOptions'] as Record<string, unknown>)['tsBuildInfoFile'] = escape
        },
      ],
      [
        'declarationDir',
        (config, escape) => {
          ;(config['compilerOptions'] as Record<string, unknown>)['declarationDir'] = escape
        },
      ],
      [
        'outFile',
        (config, escape) => {
          ;(config['compilerOptions'] as Record<string, unknown>)['outFile'] = escape
        },
      ],
      [
        'mapRoot',
        (config, escape) => {
          ;(config['compilerOptions'] as Record<string, unknown>)['mapRoot'] = escape
        },
      ],
      [
        'sourceRoot',
        (config, escape) => {
          ;(config['compilerOptions'] as Record<string, unknown>)['sourceRoot'] = escape
        },
      ],
      [
        'baseUrl/paths',
        (config, escape) => {
          const options = config['compilerOptions'] as Record<string, unknown>
          options['baseUrl'] = escape
          options['paths'] = { '*': ['*'] }
        },
      ],
      [
        'rootDirs',
        (config, escape) => {
          ;(config['compilerOptions'] as Record<string, unknown>)['rootDirs'] = ['src', escape]
        },
      ],
      [
        'rootDir',
        (config, escape) => {
          ;(config['compilerOptions'] as Record<string, unknown>)['rootDir'] = escape
        },
      ],
      [
        'typeRoots',
        (config, escape) => {
          ;(config['compilerOptions'] as Record<string, unknown>)['typeRoots'] = [escape]
        },
      ],
      [
        'plugins',
        (config, escape) => {
          ;(config['compilerOptions'] as Record<string, unknown>)['plugins'] = [
            { name: join(escape, 'plugin.js') },
          ]
        },
      ],
      [
        'extends',
        (config, escape) => {
          config['extends'] = join(escape, 'tsconfig.json')
        },
      ],
      [
        'references',
        (config, escape) => {
          config['references'] = [{ path: escape }]
        },
      ],
      [
        'include',
        (config, escape) => {
          config['include'] = [join(escape, '**/*.ts')]
        },
      ],
      [
        'files',
        (config, escape) => {
          config['files'] = [join(escape, 'input.ts')]
        },
      ],
      [
        'exclude',
        (config, escape) => {
          config['exclude'] = [escape]
        },
      ],
    ]

  it.each(unsafeConfigs)(
    'rejects candidate-controlled %s before it can write outside the build sandbox',
    async (_name, mutate) => {
      const root = await fixture(`unsafe-${_name.replaceAll('/', '-')}`)
      const escape = join(dirname(root), `escaped-${_name.replaceAll('/', '-')}`)
      scratchRoots.push(escape)
      await rm(escape, { recursive: true, force: true })
      const config = JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8')) as Record<
        string,
        unknown
      >
      mutate(config, escape)
      await writeFile(join(root, 'tsconfig.json'), JSON.stringify(config) + '\n')

      await expect(
        buildCandidate({ sourceRoot: root, sourceFiles, tscBin, toolchainRoot: repoRoot }),
      ).rejects.toThrow(/trusted TypeScript configuration/)
      await expect(stat(escape)).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it('rejects an intermediate symlink through descriptor-anchored traversal', async () => {
    const root = await fixture('intermediate-symlink')
    const outside = await fixture('intermediate-symlink-outside')
    await rm(join(root, 'src'), { recursive: true })
    await symlink(join(outside, 'src'), join(root, 'src'), 'dir')

    await expect(
      buildCandidate({ sourceRoot: root, sourceFiles, tscBin, toolchainRoot: repoRoot }),
    ).rejects.toThrow(/source snapshot: intermediate component/)
  })

  it('rejects a hard-linked declared file during descriptor capture', async () => {
    const root = await fixture('hardlink')
    const outside = join(dirname(root), `${process.pid}-hardlink-index.ts`)
    scratchRoots.push(outside)
    await copyFile(join(root, 'src', 'index.ts'), outside)
    await rm(join(root, 'src', 'index.ts'))
    await link(outside, join(root, 'src', 'index.ts'))

    await expect(
      buildCandidate({ sourceRoot: root, sourceFiles, tscBin, toolchainRoot: repoRoot }),
    ).rejects.toThrow(/source snapshot: hard-linked file rejected/)
  })

  it('cannot read a host-only absolute TypeScript reference from the compiler sandbox', async () => {
    const root = await fixture('absolute-reference')
    const outside = join(dirname(root), `${process.pid}-host-only-secret.d.ts`)
    scratchRoots.push(outside)
    await writeFile(outside, "declare const hostOnlySecret: 'must-not-be-visible'\n")
    const source = await readFile(join(root, 'src', 'index.ts'), 'utf8')
    await writeFile(
      join(root, 'src', 'index.ts'),
      `/// <reference path=${JSON.stringify(outside)} />\n${source}`,
    )

    await expect(
      buildCandidate({ sourceRoot: root, sourceFiles, tscBin, toolchainRoot: repoRoot }),
    ).rejects.toThrow(/trusted TypeScript compiler failed/)
    expect(await readFile(outside, 'utf8')).toBe(
      "declare const hostOnlySecret: 'must-not-be-visible'\n",
    )
  })

  it('binds identity, scan, schema and emitted bundle to bytes captured before mutation', async () => {
    const stableRoot = await fixture('stable')
    const mutableRoot = await fixture('mutable')
    const expected = await buildCandidate({
      sourceRoot: stableRoot,
      sourceFiles,
      tscBin,
      toolchainRoot: repoRoot,
    })
    let mutationRan = false
    const rejectedSecretPrefix = ['s', 'k', '-'].join('')
    const input = {
      sourceRoot: mutableRoot,
      sourceFiles,
      tscBin,
      toolchainRoot: repoRoot,
      testingAfterSnapshot: async () => {
        mutationRan = true
        await Promise.all([
          writeFile(
            join(mutableRoot, 'src', 'index.ts'),
            `const apiKey = '${rejectedSecretPrefix}synthetic-mutated-value'\nexport default apiKey\n`,
          ),
          writeFile(join(mutableRoot, 'candidate.json'), '{"schemaVersion":999}\n'),
        ])
      },
    }

    const actual = await buildCandidate(input)

    expect(mutationRan).toBe(true)
    expect(actual.sourceHash).toBe(expected.sourceHash)
    expect(actual.candidateId).toBe(expected.candidateId)
    expect(actual.bundleHash).toBe(expected.bundleHash)
    expect(actual.capsuleHash).toBe(expected.capsuleHash)
    expect(actual.scan).toEqual(expected.scan)
    expect(actual.schemaValidation).toEqual(expected.schemaValidation)
    expect(sameArtifacts(actual.sourceFiles, expected.sourceFiles)).toBe(true)
    expect(sameArtifacts(actual.bundleFiles, expected.bundleFiles)).toBe(true)
  })

  it(
    'remains internally identical while the live source file is continuously replaced',
    { timeout: 120_000 },
    async () => {
      const mutableRoot = await fixture('continuous-race')
      const indexPath = join(mutableRoot, 'src', 'index.ts')
      const variantA = await readFile(indexPath)
      const variantB = Buffer.from(
        variantA
          .toString('utf8')
          .replace(
            "export const name = 'self-evolving-candidate'",
            "export const name = 'self-evolving-candidate-race'",
          ),
      )
      expect(variantB.equals(variantA)).toBe(false)
      let running = true
      let swaps = 0
      const mutationLoop = (async () => {
        while (running) {
          const temporary = join(dirname(mutableRoot), `${process.pid}-candidate-race-${swaps}.ts`)
          scratchRoots.push(temporary)
          await writeFile(temporary, swaps % 2 === 0 ? variantA : variantB)
          await rename(temporary, indexPath)
          swaps += 1
          await new Promise<void>((done) => setImmediate(done))
        }
      })()
      while (swaps < 4) await new Promise<void>((done) => setImmediate(done))

      let raced: Awaited<ReturnType<typeof buildCandidate>> | undefined
      let rejection: unknown
      try {
        raced = await buildCandidate({
          sourceRoot: mutableRoot,
          sourceFiles,
          tscBin,
          toolchainRoot: repoRoot,
        })
      } catch (error) {
        rejection = error
      } finally {
        running = false
        await mutationLoop
      }

      expect(swaps).toBeGreaterThan(4)
      if (raced === undefined) {
        expect(rejection).toBeInstanceOf(Error)
        expect((rejection as Error).message).toMatch(/source snapshot:/)
        return
      }

      const replayRoot = await fixture('continuous-race-replay')
      for (const file of raced.sourceFiles) {
        await mkdir(dirname(join(replayRoot, file.path)), { recursive: true })
        await writeFile(join(replayRoot, file.path), file.bytes)
      }
      const replayed = await buildCandidate({
        sourceRoot: replayRoot,
        sourceFiles,
        tscBin,
        toolchainRoot: repoRoot,
      })

      expect(raced.sourceHash).toBe(replayed.sourceHash)
      expect(raced.candidateId).toBe(replayed.candidateId)
      expect(raced.bundleHash).toBe(replayed.bundleHash)
      expect(raced.capsuleHash).toBe(replayed.capsuleHash)
      expect(raced.scan).toEqual(replayed.scan)
      expect(raced.schemaValidation).toEqual(replayed.schemaValidation)
      expect(sameArtifacts(raced.bundleFiles, replayed.bundleFiles)).toBe(true)
    },
  )
})
