/**
 * Capsule freshness and integrity-manifest contracts (issues #41, #42).
 *
 * - a capsule is assembled in private staging and published atomically: a
 *   pre-existing output directory fails closed and stale files from previous
 *   builds can never survive into a new capsule;
 * - SHA256SUMS commits to the complete typed tree: directories, normalized
 *   executable modes, file bytes and symlink targets are all bound.
 */
import { createHash } from 'node:crypto'
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildCandidate,
  packCapsule,
  verifyCapsuleTreeManifest,
  writeCapsuleTreeManifest,
} from '../src/index.js'
import { verifyV011CapsuleSums as verifyV011Sums } from '../src/v011/admission.js'

const here = dirname(fileURLToPath(import.meta.url))
const baselineRoot = resolve(here, '..', '..', 'candidate-baseline')
const tscBin = resolve(here, '..', '..', '..', 'node_modules', '.bin', 'tsc')

let scratch: string | undefined

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-capsule-integrity-'))
})

afterAll(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
})

let catalogCounter = 0

async function fixtureCatalog(): Promise<string> {
  const runtimeCatalog = join(scratch!, `runtime-catalog-${(catalogCounter += 1)}`)
  const runtimePackage = join(runtimeCatalog, 'fake-acp')
  await mkdir(join(runtimePackage, 'lib'), { recursive: true })
  await writeFile(
    join(runtimePackage, 'package.json'),
    JSON.stringify({ name: '@dsh-self-evolving/fake-acp', version: '1.0.0', type: 'module' }),
  )
  await writeFile(join(runtimePackage, 'lib', 'bin.js'), 'export const ready = true\n')
  // A safe package-internal symlink exercises the typed manifest entries.
  await symlink('bin.js', join(runtimePackage, 'lib', 'bin-link.js'))
  return runtimeCatalog
}

async function buildOnce(catalogRoot: string, outDir: string): Promise<string> {
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
  const out = await packCapsule({
    outDir,
    receipt,
    runnerOverlay: '- insert: []\n',
    runnerFiles: { 'fixture-launcher.sh': '#!/bin/sh\nexit 0\n' },
    provenanceJson: '{}',
    sbomJson: '{}',
    runtimeClosure: {
      catalogRoots: [catalogRoot],
      seedPackages: ['@dsh-self-evolving/fake-acp'],
      entryPackage: '@dsh-self-evolving/fake-acp',
      entryBin: 'lib/bin.js',
    },
  })
  return out.capsuleHash
}

describe('capsule freshness (#41)', () => {
  it('fails closed when the output directory already exists', async () => {
    const catalog = await fixtureCatalog()
    const outDir = join(scratch!, 'existing-capsule')
    await mkdir(outDir, { recursive: true })
    await writeFile(join(outDir, 'stale-from-previous-build'), 'legacy')
    await expect(buildOnce(catalog, outDir)).rejects.toThrow(/already exists/)
    await expect(readFile(join(outDir, 'stale-from-previous-build'), 'utf8')).resolves.toBe(
      'legacy',
    )
  })

  it('never packages stale files from a previous build at the same path', async () => {
    const catalog = await fixtureCatalog()
    const outDir = join(scratch!, 'rebuild-capsule')
    const first = await buildOnce(catalog, outDir)
    // Simulate a crashed/foreign prior generation: remove the published capsule
    // but leave debris where a naive rebuild would mix generations.
    await rm(outDir, { recursive: true, force: true })
    await mkdir(join(outDir, 'runtime'), { recursive: true })
    await writeFile(join(outDir, 'runtime', 'stale-runtime-file'), 'OLD')
    await expect(buildOnce(catalog, outDir)).rejects.toThrow(/already exists/)

    // A clean rebuild to a fresh path keeps the identity stable.
    const second = await buildOnce(catalog, join(scratch!, 'rebuild-capsule-2'))
    expect(second).toBe(first)
  }, 120_000)
})

describe('capsule integrity manifest (#42)', () => {
  it('labels legacy byte manifests as predecessor evidence instead of upgrading them', async () => {
    const outDir = join(scratch!, 'legacy-capsule')
    await mkdir(join(outDir, 'runtime'), { recursive: true })
    const runtimeBytes = 'legacy\n'
    await writeFile(join(outDir, 'runtime', 'file.txt'), runtimeBytes)
    const sums = `${createHash('sha256').update(runtimeBytes).digest('hex')}  runtime/file.txt\n`
    await writeFile(join(outDir, 'SHA256SUMS'), sums)
    await writeFile(
      join(outDir, 'capsule.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        sha256sums: {
          ref: 'SHA256SUMS',
          hash: createHash('sha256').update(sums).digest('hex'),
        },
      })}\n`,
    )
    await expect(verifyCapsuleTreeManifest(outDir)).resolves.toMatchObject({
      format: 'dsh-capsule-files-v1',
    })
    await expect(verifyV011Sums(outDir)).rejects.toThrow(/requires dsh-capsule-tree-v2/i)
    const noncanonicalSums = `${sums}\n`
    await writeFile(join(outDir, 'SHA256SUMS'), noncanonicalSums)
    await writeFile(
      join(outDir, 'capsule.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        sha256sums: {
          ref: 'SHA256SUMS',
          hash: createHash('sha256').update(noncanonicalSums).digest('hex'),
        },
      })}\n`,
    )
    await expect(verifyCapsuleTreeManifest(outDir)).rejects.toThrow(/not canonical LF-delimited/i)
  })

  it('publishes the versioned complete-tree format', async () => {
    const catalog = await fixtureCatalog()
    const outDir = join(scratch!, 'tree-format-capsule')
    await buildOnce(catalog, outDir)
    const manifest = JSON.parse(await readFile(join(outDir, 'capsule.json'), 'utf8')) as {
      schemaVersion?: unknown
      sha256sums?: { format?: unknown }
    }
    const sums = await readFile(join(outDir, 'SHA256SUMS'), 'utf8')
    expect(manifest.schemaVersion).toBe(2)
    expect(manifest.sha256sums?.format).toBe('dsh-capsule-tree-v2')
    expect(sums).toMatch(/ {2}directory:0755:runtime\n/)
    expect(sums).toMatch(/ {2}file:0755:runtime\/dsh-self-evolving-acp\n/)
    expect(sums).toMatch(/ {2}file:0755:runtime\/fixture-launcher\.sh\n/)
    expect(sums).toMatch(/ {2}file:0644:runtime\/cordis.yml\n/)
    expect(sums).toMatch(/ {2}symlink:0755:runtime\/node_modules\/.+\/bin-link\.js\n/)
  }, 120_000)

  it('commits to symlink targets and rejects tampering', async () => {
    const catalog = await fixtureCatalog()
    const outDir = join(scratch!, 'symlink-capsule')
    await buildOnce(catalog, outDir)
    const linkPath = join(
      outDir,
      'runtime',
      'node_modules',
      '@dsh-self-evolving',
      'fake-acp',
      'lib',
      'bin-link.js',
    )
    await expect(readlink(linkPath)).resolves.toBe('bin.js')
    await verifyV011Sums(outDir)

    // Repoint the symlink: no file content changed, but the manifest must
    // detect the new target.
    await rm(linkPath)
    await symlink('package.json', linkPath)
    await expect(verifyV011Sums(outDir)).rejects.toThrow(/checksum mismatch/)
  }, 120_000)

  it('rejects hard-linked symlink inodes', async () => {
    const catalog = await fixtureCatalog()
    const outDir = join(scratch!, 'hard-linked-symlink-capsule')
    await buildOnce(catalog, outDir)
    const linkPath = join(
      outDir,
      'runtime',
      'node_modules',
      '@dsh-self-evolving',
      'fake-acp',
      'lib',
      'bin-link.js',
    )
    await link(linkPath, join(dirname(linkPath), 'second-link.js'))
    await expect(verifyV011Sums(outDir)).rejects.toThrow(/hard-linked capsule entry/i)
  }, 120_000)

  it('rejects control characters and non-UTF-8 bytes before writing checksum text', async () => {
    for (const [label, name] of [
      ['carriage-return', 'bad\rname'],
      ['tab', 'bad\tname'],
    ] as const) {
      const root = join(scratch!, `unsafe-path-${label}`)
      await mkdir(join(root, 'runtime'), { recursive: true })
      await writeFile(join(root, 'runtime', name), 'unsafe\n')
      await expect(writeCapsuleTreeManifest(root, join(root, 'SHA256SUMS'))).rejects.toThrow(
        /unsafe entry path/i,
      )
    }

    const nonUtf8Root = join(scratch!, 'unsafe-path-non-utf8')
    await mkdir(join(nonUtf8Root, 'runtime'), { recursive: true })
    await writeFile(
      Buffer.concat([Buffer.from(join(nonUtf8Root, 'runtime') + '/'), Buffer.from([0xff])]),
      'unsafe\n',
    )
    await expect(
      writeCapsuleTreeManifest(nonUtf8Root, join(nonUtf8Root, 'SHA256SUMS')),
    ).rejects.toThrow(/invalid UTF-8 entry name/i)
  })

  it('hashes literal symlink-target bytes without UTF-8 replacement aliases', async () => {
    const root = join(scratch!, 'literal-symlink-target-bytes')
    await mkdir(join(root, 'runtime'), { recursive: true })
    const linkPath = join(root, 'runtime', 'link')
    await symlink(Buffer.from([0xff]), linkPath)
    const { hash } = await writeCapsuleTreeManifest(root, join(root, 'SHA256SUMS'))
    await writeFile(
      join(root, 'capsule.json'),
      `${JSON.stringify({
        schemaVersion: 2,
        sha256sums: { ref: 'SHA256SUMS', hash, format: 'dsh-capsule-tree-v2' },
      })}\n`,
    )
    await expect(verifyCapsuleTreeManifest(root)).resolves.toMatchObject({
      format: 'dsh-capsule-tree-v2',
    })

    await rm(linkPath)
    await symlink('\ufffd', linkPath)
    await expect(verifyCapsuleTreeManifest(root)).rejects.toThrow(/checksum mismatch/i)
  })

  it('rejects non-UTF-8 checksum bytes instead of hashing replacement text', async () => {
    const root = join(scratch!, 'literal-checksum-bytes')
    await mkdir(join(root, 'runtime'), { recursive: true })
    await writeFile(join(root, 'runtime', '\ufffd'), 'content\n')
    const { hash } = await writeCapsuleTreeManifest(root, join(root, 'SHA256SUMS'))
    await writeFile(
      join(root, 'capsule.json'),
      `${JSON.stringify({
        schemaVersion: 2,
        sha256sums: { ref: 'SHA256SUMS', hash, format: 'dsh-capsule-tree-v2' },
      })}\n`,
    )
    const valid = await readFile(join(root, 'SHA256SUMS'))
    const encodedReplacement = Buffer.from('\ufffd')
    const offset = valid.indexOf(encodedReplacement)
    expect(offset).toBeGreaterThanOrEqual(0)
    await writeFile(
      join(root, 'SHA256SUMS'),
      Buffer.concat([
        valid.subarray(0, offset),
        Buffer.from([0xff]),
        valid.subarray(offset + encodedReplacement.length),
      ]),
    )
    await expect(verifyCapsuleTreeManifest(root)).rejects.toThrow(/invalid UTF-8 checksum text/i)
  })

  it('rejects unlisted extra entries added to the runtime tree', async () => {
    const catalog = await fixtureCatalog()
    const outDir = join(scratch!, 'extra-capsule')
    await buildOnce(catalog, outDir)
    await verifyV011Sums(outDir)
    await writeFile(join(outDir, 'runtime', 'unlisted-intruder.js'), 'export const x = 1\n')
    await expect(verifyV011Sums(outDir)).rejects.toThrow(/unlisted capsule entry/)
  }, 120_000)

  it('rejects an unlisted empty directory', async () => {
    const catalog = await fixtureCatalog()
    const outDir = join(scratch!, 'empty-directory-capsule')
    await buildOnce(catalog, outDir)
    await mkdir(join(outDir, 'runtime', 'unlisted-empty-directory'))
    await expect(verifyV011Sums(outDir)).rejects.toThrow(/unlisted capsule entry.*directory/i)
  }, 120_000)

  it('rejects executable-mode drift without a content change', async () => {
    const catalog = await fixtureCatalog()
    const outDir = join(scratch!, 'mode-drift-capsule')
    await buildOnce(catalog, outDir)
    await chmod(join(outDir, 'runtime', 'cordis.yml'), 0o755)
    await expect(verifyV011Sums(outDir)).rejects.toThrow(
      /unlisted capsule entry.*file:0755:runtime\/cordis\.yml/i,
    )
    await chmod(join(outDir, 'runtime', 'cordis.yml'), 0o4755)
    await expect(verifyV011Sums(outDir)).rejects.toThrow(/special file mode.*cordis\.yml/i)
  }, 120_000)

  it('rejects executable control files whose mode is outside the checksum cycle', async () => {
    const catalog = await fixtureCatalog()
    const outDir = join(scratch!, 'control-mode-drift-capsule')
    await buildOnce(catalog, outDir)
    const manifestPath = join(outDir, 'capsule.json')
    await chmod(manifestPath, 0o755)
    await expect(verifyV011Sums(outDir)).rejects.toThrow(/control path.*0644.*capsule\.json/i)
    await chmod(manifestPath, 0o644)
    await chmod(join(outDir, 'SHA256SUMS'), 0o755)
    await expect(verifyV011Sums(outDir)).rejects.toThrow(/control path.*0644.*SHA256SUMS/i)
  }, 120_000)

  it('rejects a listed-but-missing entry', async () => {
    const catalog = await fixtureCatalog()
    const outDir = join(scratch!, 'missing-capsule')
    await buildOnce(catalog, outDir)
    const entry = join(outDir, 'runtime', 'package-closure.json')
    await rm(entry)
    await expect(verifyV011Sums(outDir)).rejects.toThrow(/missing entry/)
  }, 120_000)
})
