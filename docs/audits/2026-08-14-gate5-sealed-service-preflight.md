# Gate 5 sealed-service engineering preflight — 2026-08-14

**Status:** `ENGINEERING_PREFLIGHT_PASSED`; `GATE_5_NOT_ACCEPTED`
**Scope:** synthetic 89-task inventory only
**Formal split minted:** no
**Sealed outcomes accessed:** no

## Implemented boundary

`@dsh-rsi/sealed-service` runs the ceremony as a separate one-shot Node worker. The worker creates
a mode-0700 private directory and mode-0600 hash-bound state. Its public directory contains only a
split commitment/controller view and, later, a candidate-lock receipt. The request protocol has no
operation that returns the seed, complete mapping, sealed identities, or sealed outcomes.

The ceremony uses 256 random bits generated inside the worker. Its seed commitment binds the seed,
dataset digest, and protocol hash. Split strata use public category, fixed timeout class, network
flag, and optional mechanically supplied TB2.1 modification flag. Difficulty is explicitly
`OMITTED`; the historical public-seed split is not reused.

The controller view contains 48 observed task IDs, 12 opaque guard handles, a sealed count of 29,
the Merkle commitment, input/splitter hashes, and worker/process/store identity. It contains neither
the seed nor the guard/sealed mapping.

Candidate lock atomically binds run, candidate, source, capsule, run-manifest, baseline candidate/
capsule, model route, evaluation protocol, sealed plan, analysis container, ceremony, and split
Merkle identities. Repeating the same lock is idempotent; a different identity is rejected. Once
the private lock is durable, all subsequent proposer/selector authorization requests are rejected.
Missing public receipts are reconstructed from private state; conflicting public bytes and symlinks
are never overwritten.

## Verification

- 5 unit tests: concealment/counts/ACL, exact idempotence, public-receipt recovery/no-replace,
  candidate-lock refusal/mismatch, and private-state tamper detection.
- 2 process E2E tests: real child worker boundary, public-response non-disclosure, an unprivileged
  UID denied access to private state, lock-bound mutation refusal, and absence of dump/reveal API.
- TypeScript, ESLint, and formatting checks pass for the successor.
- Gate 5 acceptance now requires content-addressed ceremony/service/lock receipts, principal
  separation, 48/12/29 counts, information-flow fixtures, split-bound lock refusal, and zero sealed
  access in addition to the real baseline/calibration/budget evidence.

## Remaining acceptance boundary

This preflight does not deploy a durable dedicated service account/volume, mint the formal split,
or run the missing real 60x2 baseline and 3-candidate calibration. The E2E uses synthetic task IDs
and a temporary root-owned service store while verifying that UID 65534 cannot read it. Therefore it
must not be cited as Gate 5 acceptance or as evidence about Terminal-Bench outcomes.
