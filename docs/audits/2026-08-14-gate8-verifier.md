# Gate 8 sealed/full/release verifier — 2026-08-14

**Status:** `BLOCKED_NOT_STARTED`
**Candidate lock:** absent for any formal run
**Reveal count:** zero
**Sealed/full trials:** zero

## Public acceptance boundary

Issue #111 established that the former `verifyGate8Evidence` accepted an entirely caller-authored envelope: hash-shaped
receipt references, signature/replay/reconciliation booleans, normalized rows and the envelope commitment could all be
fabricated and recomputed together without any artifact existing.

The public `verifyGate8Evidence` now always returns `PROTOCOL_INVALID` with all acceptance fields false. It remains
disabled until a real Gate 8 producer and verifier can read versioned receipt bytes from a trusted content-addressed
store, verify an external signature authority, and reconstruct journal/action/launch-manifest facts. No caller can mint
promotion, full-set or release status from the synthetic envelope.

## Synthetic consistency assessor

The previous matrix/statistics logic is retained only as `assessGate8EvidenceConsistency`, which is not exported from
the package root and cannot produce an acceptance verdict. It checks protocol math and malformed fixtures, including:

- a hash-shaped `SEARCH_COMPLETE` claim and positive development delta;
- a lock-shaped object binding candidate source/capsule/run manifest, baseline identity/capsule, model route,
  protocol, sealed plan, analysis container and split Merkle root, plus a caller-supplied signature flag;
- one reveal-shaped object asserting commitment verification and zero pre-lock sealed accesses;
- a complete 29-task paired matrix at the preregistered `k`, with distinct trial seeds, identical
  protocols, complete raw/normalized/cost evidence, unique randomized schedule indexes, terminal
  actions, journal replay, no intermediate feedback, and audit findings;
- a frozen analysis container/statistics hash, committed bootstrap seed, at least 100,000 paired
  task-cluster resamples, and the fixed 5pp/CI-lower-greater-than-zero promotion rule;
- only after `SEALED_PROMOTED`, a fixed-capsule 89-task matrix with at least five attempts per task;
  and
- hash-shaped fresh-profile pack/install/Loader, SBOM, provenance, checksums, reports, rollback and public leak-scan
  references before release.

These checks remain useful specifications for a later authentic verifier. They do not prove receipt existence,
provenance, signatures, journal replay or release execution.

## Verification and current boundary

The regression suite first proves that even a fully self-consistent synthetic envelope is rejected by the public
boundary, then exercises the consistency assessor's matrix/statistics and malformed-input rules. The real state is
recorded in `evidence/gate8/STATUS.json`: Gate 7 never started, no formal candidate was locked, no reveal occurred, no
sealed/full evaluation exists, and no release claim is permitted.
