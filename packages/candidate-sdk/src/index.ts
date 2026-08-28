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
  CANDIDATE_BUILD_WRITABLE_MOUNTS_V1,
  type BuildInput,
  type BuildReceipt,
  type BuildArtifactFile,
} from './builder-sandbox.js'

export {
  CANDIDATE_BUILD_RESOURCE_POLICY_V1,
  CANDIDATE_TEST_RESOURCE_POLICY_V1,
  CANDIDATE_RUNTIME_RESOURCE_POLICY_V1,
  assertCompletedResourceDomainReceipt,
  resourcePolicyDigest,
  validateResourcePolicy,
  type CompletedResourceReceiptExpectation,
  type ResourceDomainReceipt,
  type ResourceEvents,
  type ResourcePolicyV1,
  type ResourceTerminationCause,
  type ResourceUsage,
} from './resource-domain.js'

export {
  spawnResourceBoundSandbox,
  type ResourceSandboxFile,
  type ResourceSandboxProcess,
  type ResourceSandboxResult,
  type WritableSandboxMount,
} from './resource-sandbox.js'

export { packCapsule, type CapsuleInput, type CapsuleOutput } from './capsule.js'
export * from './v011/index.js'
export { canonicalV011, digestV011 } from './v011/contract.js'
