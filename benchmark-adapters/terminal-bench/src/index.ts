/**
 * @dsh-self-evolving/terminal-bench-adapter — Terminal-Bench provider for Harbor.
 *
 * Policy-free TypeScript provider (spec 01): generates Harbor JobConfig YAML
 * with an inline ACP binary registry entry for a DSH candidate capsule, plus a
 * fail-closed per-trial normalizer and idempotency key store. Driven by the
 * trusted controller; never sees sealed labels or scores.
 */
export {
  buildRegistryEntry,
  type AcpRegistryEntry,
  type AcpBinaryTarget,
  type RegistryEntryInput,
} from './acp-registry.js'
export {
  buildJobConfig,
  jobConfigToYaml,
  type HarborJobConfig,
  type JobConfigInput,
  type TBTaskSpec,
  type TBVerifierConfig,
} from './job-config.js'
export {
  normalizeTrial,
  assertTrialDirExists,
  type NormalizedTrial,
  type RawTrialArtifacts,
  type TrialStatus,
  type InfraClass,
} from './normalizer.js'
export {
  reserveKey,
  isReserved,
  idempotencyKey,
  type IdempotencyStore,
  type IdempotencyRecord,
} from './idempotency.js'
export { reconcileCost, type ReconciledCost, type HarborUsage } from './reconcile.js'
export { packAcpBinaryArchive, type PackedAcpBinaryArchive } from './artifact.js'
