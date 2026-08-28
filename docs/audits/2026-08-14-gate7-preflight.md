# Gate 7 formal preflight audit — 2026-08-14

**Status:** `BLOCKED_NOT_STARTED`
**Formal run directory:** not created
**80-candidate search:** not started
**Sealed access:** zero

## Fail-closed preflight

`verifyFormalPreflight` now requires a trusted caller-owned signer registry supplied outside the
manifest and evidence. `signatureKeyId` must select a registered PEM whose derived SPKI hash matches
that id before the detached Ed25519 signature is checked; evidence cannot carry its own trust anchor.
The canonical manifest binds:

- reviewed Git commit/tag/tree and provenance identities;
- self-track solver/proposer routes, request defaults, and the exact
  requested `deepseek-v4-flash-zen` / effective `deepseek-v4-flash` / `high` /
  1,048,576-token context identity;
- exact Terminal-Bench 2.1 registry/dataset/source/inventory identities;
- controller, candidate SDK, evaluator, statistics, protocol, and sealed-service hashes;
- split commitment, search parameters, master-seed commitment, budget limits/reserve; and
- an HTTPS leaderboard snapshot, capture time, and target-row hash.

The runtime evidence side must independently prove clean/tagged Git state; Gate 4/5/6 acceptance
receipts; a real, exact-identity 60-task baseline with at least two attempts; the frozen provider
route smoke; separate/concealed split with zero sealed access; formal budget reservation; fresh run
directory; all four operator procedures; and pre-reveal statistics publication.

Seven unit tests cover a complete registered envelope, post-signature mutation, evidence-commitment
mutation, the current multi-blocker state, an unregistered self-signed envelope, and a registry
key-id/PEM mismatch, plus rejection of a registered non-Ed25519 signer with a valid signature. These
are verifier tests only and do not mint a formal manifest or acceptance receipt.

## Current blockers

The authoritative blocker list is preserved in `evidence/formal/STATUS.json`. Gate 4 now has an
accepted real-provider status receipt. Gate 5 still lacks formal split/baseline/calibration/budget
acceptance; Gate 6 lacks a real K=10 pilot; and no tagged, reviewed, signed manifest, current
leaderboard snapshot, formal budget reservation, operator-procedure receipt, or deployed trusted
signer registry exists.

Starting a paid 80-candidate search in this state would violate gate ordering. No run directory was
created and no sealed assignment or outcome was accessed.
