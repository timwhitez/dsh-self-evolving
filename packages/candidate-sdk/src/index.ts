/**
 * @dsh-self-evolving/candidate-sdk — candidate contract SDK.
 *
 * The trusted surface candidates build against, and the builder/scanner/validator
 * the TCB uses to admit them. See specs/02 (candidate contract) and specs/07 §3.
 */
export {
  buildCanonicalArchive,
  candidateIdFromArchive,
  declareFiles,
  isValidCandidateId,
  DEFAULT_LIMITS,
  type CanonicalArchive,
  type CanonicalLimits,
  type DeclaredFile,
} from './identity/canonical-tar.js'

export {
  scanFiles,
  scanPaths,
  scanSource,
  DEFAULT_DSH_ALLOWLIST,
  DEFAULT_NODE_ALLOWLIST,
  type ScanHit,
  type ScanResult,
  type ScanOptions,
} from './scan/policy-scan.js'

export {
  validateManifest,
  validateManifestFile,
  type ManifestKind,
  type ValidationResult,
} from './validate/index.js'

export {
  diffBoundary,
  assertRegularFile,
  type DiffBoundaryResult,
  type DiffEntry,
} from './builder.js'

export {
  buildCandidate,
  type BuildInput,
  type BuildReceipt,
  type BuildArtifactFile,
} from './builder-sandbox.js'

export { packCapsule, type CapsuleInput, type CapsuleOutput } from './capsule.js'
export * from './v011/index.js'
