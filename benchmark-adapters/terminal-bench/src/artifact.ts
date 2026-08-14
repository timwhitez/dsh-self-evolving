/** Deterministic Harbor ACP binary artifact packaging. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface PackedAcpBinaryArchive {
  archivePath: string
  sha256: string
  size: number
}

/**
 * Pack a capsule runtime as a byte-reproducible tar.gz for Harbor's ACP
 * binary installer. The executable must be at the archive root because
 * Harbor invokes the basename of the registry command after extraction.
 */
export async function packAcpBinaryArchive(
  runtimeDir: string,
  archivePath: string,
): Promise<PackedAcpBinaryArchive> {
  const runtime = resolve(runtimeDir)
  const output = resolve(archivePath)
  const launcher = await stat(join(runtime, 'dsh-rsi-acp'))
  if (!launcher.isFile() || (launcher.mode & 0o111) === 0) {
    throw new Error('runtime/dsh-rsi-acp must be an executable regular file')
  }

  await mkdir(dirname(output), { recursive: true })
  const stagingDir = await mkdtemp(join(dirname(output), '.dsh-rsi-acp-archive-'))
  const tarPath = join(stagingDir, 'runtime.tar')
  const gzipPath = join(stagingDir, 'runtime.tar.gz')

  try {
    await execFileAsync('/usr/bin/tar', [
      '--sort=name',
      '--mtime=@0',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '--mode=u=rwX,go=rX',
      '--format=ustar',
      '-cf',
      tarPath,
      '-C',
      runtime,
      '.',
    ])
    const compressed = gzipSync(await readFile(tarPath), { level: 9 })
    await writeFile(gzipPath, compressed, { mode: 0o644 })
    await rename(gzipPath, output)
    return {
      archivePath: output,
      sha256: createHash('sha256').update(compressed).digest('hex'),
      size: compressed.byteLength,
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}
