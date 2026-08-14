# Gate 8 sealed/full/release verifier — 2026-08-14

**Status:** `BLOCKED_NOT_STARTED`
**Candidate lock:** absent for any formal run
**Reveal count:** zero
**Sealed/full trials:** zero

## Fail-closed evidence verifier

`verifyGate8Evidence` recomputes rather than trusts the promotion label. It requires:

- an accepted `SEARCH_COMPLETE` receipt and positive development champion;
- a signed lock binding candidate source/capsule/run manifest, baseline identity/capsule, model route,
  protocol, sealed plan, analysis container, and split Merkle root;
- exactly one verified reveal after zero pre-lock sealed accesses;
- a complete 29-task paired matrix at the preregistered `k`, with distinct trial seeds, identical
  protocols, complete raw/normalized/cost evidence, unique randomized schedule indexes, terminal
  actions, journal replay, no intermediate feedback, and audit findings;
- a frozen analysis container/statistics hash, committed bootstrap seed, at least 100,000 paired
  task-cluster resamples, and the fixed 5pp/CI-lower-greater-than-zero promotion rule;
- only after `SEALED_PROMOTED`, a fixed-capsule 89-task matrix with at least five attempts per task;
  and
- fresh-profile pack/install/Loader, SBOM, provenance, checksums, reports, rollback, and public leak
  scan receipts before release.

`FULL_SET_VERIFIED_LOCAL` remains distinct from `LEADERBOARD_VERIFIED`; the latter additionally
requires an official maintainer receipt.

## Verification and current boundary

Three synthetic tests cover a complete promoted 29x5 + 89x5 + release envelope, an incomplete
paired matrix that becomes `PROTOCOL_INVALID`, and an honest sealed rejection that cannot support a
full-set claim. The real state is recorded in `evidence/gate8/STATUS.json`: Gate 7 never started, no
formal candidate was locked, no reveal occurred, no sealed/full evaluation exists, and no release
claim is permitted.
