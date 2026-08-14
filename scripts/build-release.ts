#!/usr/bin/env tsx
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface LicensePackage {
  name: string
  versions?: string[]
  license?: string
}

export function normalizeGitCommit(stdout: string): string {
  const commit = stdout.trim()
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error('release: invalid Git commit identity')
  return commit
}

export function buildSpdxSbom(
  commit: string,
  licenses: Record<string, LicensePackage[]>,
): Record<string, unknown> {
  const packages = Object.entries(licenses)
    .flatMap(([license, entries]) =>
      entries.flatMap((entry) =>
        (entry.versions ?? ['NOASSERTION']).map((version) => ({
          SPDXID: `SPDXRef-Package-${createHash('sha256').update(`${entry.name}@${version}`).digest('hex').slice(0, 20)}`,
          name: entry.name,
          versionInfo: version,
          downloadLocation: 'NOASSERTION',
          filesAnalyzed: false,
          licenseConcluded: 'NOASSERTION',
          licenseDeclared: entry.license ?? license,
          copyrightText: 'NOASSERTION',
        })),
      ),
    )
    .sort((left, right) =>
      `${left.name}@${left.versionInfo}`.localeCompare(`${right.name}@${right.versionInfo}`),
    )
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `dsh-rsi-v0.1.0-rc.1-${commit.slice(0, 12)}`,
    documentNamespace: `https://dsh-rsi.invalid/spdx/${commit}`,
    creationInfo: {
      created: new Date().toISOString(),
      creators: ['Tool: dsh-rsi-release-builder-v1'],
    },
    packages,
  }
}

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

function exec(
  file: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    execFile(
      file,
      args,
      { cwd: options.cwd ?? repoRoot, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) =>
        error
          ? reject(new Error(`${basename(file)} ${args[0]} failed: ${stderr}`, { cause: error }))
          : done({ stdout, stderr }),
    )
  })
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

export async function assertTrackedTextSafe(): Promise<{ trackedFiles: number }> {
  const { stdout } = await exec('/usr/bin/git', ['ls-files', '-z'])
  const files = stdout.split('\0').filter(Boolean)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bsk-[A-Za-z0-9_-]{20,}\b/,
    /(?:password|passwd)\s*[:=]\s*["'][^"']{8,}["']/i,
  ]
  for (const relative of files) {
    const bytes = await readFile(join(repoRoot, relative))
    if (bytes.includes(0)) continue
    const text = decoder.decode(bytes)
    if (text.includes('\uFFFD')) throw new Error(`release: replacement character in ${relative}`)
    if (secretPatterns.some((pattern) => pattern.test(text))) {
      throw new Error(`release: possible secret in tracked file ${relative}`)
    }
  }
  return { trackedFiles: files.length }
}

async function main(): Promise<void> {
  const index = process.argv.indexOf('--out-dir')
  const rawOut = index === -1 ? undefined : process.argv[index + 1]
  if (rawOut === undefined) throw new Error('usage: build-release --out-dir <new-directory>')
  const outDir = resolve(rawOut)
  if ((await stat(outDir).catch(() => null)) !== null)
    throw new Error('release: output directory exists')
  const status = (await exec('/usr/bin/git', ['status', '--porcelain'])).stdout
  if (status.length !== 0) throw new Error('release: worktree must be clean')
  const commit = normalizeGitCommit((await exec('/usr/bin/git', ['rev-parse', 'HEAD'])).stdout)
  const safety = await assertTrackedTextSafe()
  await mkdir(outDir, { recursive: false, mode: 0o755 })

  const sourceName = 'dsh-rsi-v0.1.0-rc.1-source.tar.gz'
  await exec('/usr/bin/git', [
    'archive',
    '--format=tar.gz',
    '--prefix=dsh-rsi-v0.1.0-rc.1/',
    '-o',
    join(outDir, sourceName),
    'HEAD',
  ])
  await exec('pnpm', ['--filter', '@dsh-rsi/cli', 'pack', '--pack-destination', outDir])
  const licensesRaw = (await exec('pnpm', ['licenses', 'list', '--json'])).stdout
  const licenses = JSON.parse(licensesRaw) as Record<string, LicensePackage[]>
  const sbom = buildSpdxSbom(commit, licenses)
  await writeFile(join(outDir, 'sbom.spdx.json'), JSON.stringify(sbom, null, 2) + '\n')
  await writeFile(
    join(outDir, 'dependency-licenses.json'),
    JSON.stringify(licenses, null, 2) + '\n',
  )
  await copyFile(join(repoRoot, 'provenance.lock.json'), join(outDir, 'provenance.lock.json'))

  const primaryArtifacts = (await readdir(outDir))
    .filter((name) => name !== 'SHA256SUMS' && name !== 'release-receipt.json')
    .sort()
  const receipt = {
    schemaVersion: 1,
    status: 'OPEN_SOURCE_V0_1_RELEASE_CANDIDATE',
    commit,
    artifacts: [...primaryArtifacts, 'release-receipt.json', 'SHA256SUMS'],
    trackedUtf8AndSecretScan: { ...safety, passed: true },
    benchmarkClaim: 'NONE',
  }
  const receiptFile = await open(join(outDir, 'release-receipt.json'), 'wx', 0o644)
  try {
    await receiptFile.writeFile(JSON.stringify(receipt, null, 2) + '\n')
  } finally {
    await receiptFile.close()
  }
  const checksumArtifacts = (await readdir(outDir)).filter((name) => name !== 'SHA256SUMS').sort()
  const sums = await Promise.all(
    checksumArtifacts.map(async (name) => `${await sha256File(join(outDir, name))}  ${name}`),
  )
  await writeFile(join(outDir, 'SHA256SUMS'), sums.join('\n') + '\n')
  process.stdout.write(JSON.stringify(receipt) + '\n')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
