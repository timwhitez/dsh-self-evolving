/**
 * ACP binary registry entry builder (spec 07 §4 Build; Harbor AcpRegistryEntry).
 *
 * Harbor's generic ACP adapter accepts an inline registry entry describing how
 * to install and launch an ACP-speaking agent binary inside the task
 * environment. The entry pins an HTTPS archive + SHA-256 checksum per platform,
 * which Harbor verifies in-env before running. This module builds that entry for
 * a DSH candidate capsule.
 *
 * Per spec 01, this adapter contains NO RSI policy: it is a pure provider that
 * the trusted controller drives. It never sees sealed labels or scores.
 */

/** One platform-keyed binary target. Matches Harbor's AcpBinaryTarget. */
export interface AcpBinaryTarget {
  /** HTTPS URL to a tar.gz/tgz/tar.bz2/zip archive (immutable artifact endpoint). */
  archive: string
  /** Command name inside the archive, e.g. "./dsh-self-evolving-acp". */
  cmd: string
  args?: string[]
  env?: Record<string, string>
  /** sha256 hex of the downloaded archive; Harbor verifies before install. */
  checksum?: string
}

export interface AcpPackageDistribution {
  package: string
  args?: string[]
  env?: Record<string, string>
}

export interface AcpDistribution {
  /** Map of platform id ("linux-x86_64", "darwin-aarch64", ...) to a binary target. */
  binary?: Record<string, AcpBinaryTarget>
  npx?: AcpPackageDistribution
  uvx?: AcpPackageDistribution
}

/** Harbor's AcpRegistryEntry schema. */
export interface AcpRegistryEntry {
  id: string
  name: string
  version: string
  description: string
  distribution: AcpDistribution
  repository?: string
  authors?: string[]
  license?: string
  website?: string
  icon?: string
}

export interface RegistryEntryInput {
  /** Candidate identity (from the capsule build receipt). */
  candidateId: string
  /** Semantic name for the ACP agent. */
  agentName: string
  /** Version string; for a candidate, the short candidate id prefix. */
  version: string
  /** Immutable HTTPS URL where the capsule's ACP launcher archive is published. */
  archiveUrl: string
  /** sha256 of the published archive (hex). */
  archiveSha256: string
  /** Command inside the archive that launches the ACP server. */
  cmd: string
  /** Optional fixed args/env for the launcher. */
  args?: string[]
  env?: Record<string, string>
}

/**
 * Build an inline AcpRegistryEntry for a DSH candidate capsule. The entry is
 * platform-pinned to linux-x86_64 (TB task environments are linux docker); a
 * full multi-platform distribution is produced when the caller supplies per-
 * platform archives.
 */
export function buildRegistryEntry(input: RegistryEntryInput): AcpRegistryEntry {
  if (!input.archiveUrl.startsWith('https://')) {
    throw new Error(
      `acp registry: archive URL must be HTTPS (immutable endpoint): ${input.archiveUrl}`,
    )
  }
  if (!/^[0-9a-f]{64}$/.test(input.archiveSha256)) {
    throw new Error(
      `acp registry: archive checksum must be sha256 hex (64 chars): ${input.archiveSha256}`,
    )
  }
  return {
    id: `dsh-self-evolving-${input.candidateId}`,
    name: input.agentName,
    version: input.version,
    description: `DSH RSI candidate ${input.candidateId} ACP launcher (Terminal-Bench).`,
    distribution: {
      binary: {
        'linux-x86_64': {
          archive: input.archiveUrl,
          cmd: input.cmd,
          ...(input.args ? { args: input.args } : {}),
          ...(input.env ? { env: input.env } : {}),
          checksum: input.archiveSha256,
        },
      },
    },
    repository: 'https://github.com/deepseek-ai/deepseek-harness',
    authors: ['dsh-self-evolving'],
    license: 'MIT',
  }
}
