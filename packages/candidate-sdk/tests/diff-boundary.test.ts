/**
 * Diff boundary + capsule packing tests (spec 02 §11 step 3, §12).
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { diffBoundary, packCapsule } from '../src/index.js'
import { buildCandidate } from '../src/index.js'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const baselineRoot = resolve(here, '..', '..', 'candidate-baseline')
const tscBin = resolve(here, '..', '..', '..', 'node_modules', '.bin', 'tsc')

let scratch: string | undefined

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dsh-rsi-diff-'))
})

afterEach(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
  scratch = undefined
})

describe('diff boundary', () => {
  it('flags a modification outside the editable surface', async () => {
    const parentDir = join(scratch!, 'parent')
    const childDir = join(scratch!, 'child')
    await mkdir(join(parentDir, 'src'), { recursive: true })
    await mkdir(join(childDir, 'src'), { recursive: true })
    // shared file
    await writeFile(join(parentDir, 'src/shared.ts'), 'export const a = 1\n')
    await writeFile(join(childDir, 'src/shared.ts'), 'export const a = 2\n')
    // candidate-only new file
    await writeFile(join(childDir, 'src/new.ts'), 'export const b = 2\n')

    const parentFiles = new Map([['src/shared.ts', join(parentDir, 'src/shared.ts')]])
    const childFiles = new Map([
      ['src/shared.ts', join(childDir, 'src/shared.ts')],
      ['src/new.ts', join(childDir, 'src/new.ts')],
    ])
    const editable = new Set(['src/shared.ts', 'src/new.ts'])
    const res = await diffBoundary(parentFiles, childFiles, editable)
    expect(res.withinBoundary).toBe(true)
    expect(res.entries.length).toBe(2)
  })

  it('rejects a change to a non-editable file (TCB)', async () => {
    const parentDir = join(scratch!, 'parent')
    const childDir = join(scratch!, 'child')
    await mkdir(parentDir, { recursive: true })
    await mkdir(childDir, { recursive: true })
    await writeFile(join(parentDir, 'verifier.ts'), 'export const v = 1\n')
    await writeFile(join(childDir, 'verifier.ts'), 'export const v = 999\n') // tampered

    const parentFiles = new Map([['verifier.ts', join(parentDir, 'verifier.ts')]])
    const childFiles = new Map([['verifier.ts', join(childDir, 'verifier.ts')]])
    const editable = new Set<string>([]) // candidate may not touch verifier.ts
    const res = await diffBoundary(parentFiles, childFiles, editable)
    expect(res.withinBoundary).toBe(false)
    expect(res.violations.some((v) => v.includes('verifier.ts'))).toBe(true)
  })
})

describe('capsule packing', () => {
  it('packs a complete capsule with SHA256SUMS and capsule.json', async () => {
    const runtimeCatalog = join(scratch!, 'runtime-catalog')
    const runtimePackage = join(runtimeCatalog, 'fake-acp')
    await mkdir(join(runtimePackage, 'lib'), { recursive: true })
    await writeFile(
      join(runtimePackage, 'package.json'),
      JSON.stringify({ name: '@dsh-rsi/fake-acp', version: '1.0.0', type: 'module' }),
    )
    await writeFile(join(runtimePackage, 'lib', 'bin.js'), 'export const ready = true\n')
    const runtimeClosure = {
      catalogRoots: [runtimeCatalog],
      seedPackages: ['@dsh-rsi/fake-acp'],
      entryPackage: '@dsh-rsi/fake-acp',
      entryBin: 'lib/bin.js',
    }
    const receipt = await buildCandidate({
      sourceRoot: baselineRoot,
      sourceFiles: [
        'src/index.ts',
        'package.json',
        'candidate.json',
        'cordis.patch.yml',
        'tsconfig.json',
      ],
      tscBin,
    })
    const capsuleDir = join(scratch!, 'capsule')
    const out = await packCapsule({
      outDir: capsuleDir,
      receipt,
      runnerOverlay: '- insert: []\n',
      provenanceJson: '{}',
      sbomJson: '{}',
      runtimeClosure,
    })
    expect(out.capsuleHash).toMatch(/^[0-9a-f]{64}$/)
    expect(out.capsuleManifestPath.endsWith('capsule.json')).toBe(true)
    const sumsBytes = await readFile(out.sha256sumsPath)
    const sums = sumsBytes.toString('utf8').trim().split('\n')
    expect(sums.some((line) => line.endsWith('  SHA256SUMS'))).toBe(false)
    expect(sums.some((line) => line.endsWith('  capsule.json'))).toBe(false)
    for (const line of sums) {
      const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line)
      expect(match).not.toBeNull()
      const actual = createHash('sha256')
        .update(await readFile(join(capsuleDir, match![2]!)))
        .digest('hex')
      expect(actual).toBe(match![1])
    }
    const manifestBytes = await readFile(out.capsuleManifestPath)
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
      sha256sums: { hash: string }
    }
    expect(manifest.sha256sums.hash).toBe(createHash('sha256').update(sumsBytes).digest('hex'))
    expect(out.capsuleHash).toBe(
      createHash('sha256').update(manifestBytes).update(sumsBytes).digest('hex'),
    )
    const sbom = JSON.parse(await readFile(join(capsuleDir, 'sbom.spdx.json'), 'utf8')) as {
      spdxVersion?: string
      packages?: Array<{ name: string }>
    }
    expect(sbom.spdxVersion).toBe('SPDX-2.3')
    expect(sbom.packages?.map((pkg) => pkg.name)).toEqual(
      expect.arrayContaining(['@dsh-rsi/fake-acp', '@dsh-rsi/candidate-baseline']),
    )

    // A second pack from identical inputs must produce the same capsule hash.
    const out2 = await packCapsule({
      outDir: join(scratch!, 'capsule2'),
      receipt,
      runnerOverlay: '- insert: []\n',
      provenanceJson: '{}',
      sbomJson: '{}',
      runtimeClosure,
    })
    expect(out2.capsuleHash).toBe(out.capsuleHash)
  })
}, 120_000)
