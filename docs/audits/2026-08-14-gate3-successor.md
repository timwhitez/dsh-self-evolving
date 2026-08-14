# Gate 3 successor acceptance — 2026-08-14

**Predecessor audit:** `docs/audits/2026-08-14-gate-acceptance-audit.md`
**Status:** `GATE_3_ACCEPTED`; Gate 4 is the earliest failed gate
**Sealed access:** none

## Successor changes

- Converted `@dsh-rsi/core` into a namespace-form Cordis bundle that mounts exactly one
  lifecycle-owned `ctx.rsi` service. Its profile patch requires explicit state-root/run-id
  deployment inputs.
- Made journal locking atomic with `O_EXCL`, PID start-identity verification, stale-owner evidence
  preservation, and fail-closed ownership checks on release.
- Fsynced each journal event before atomically publishing HEAD and made replay verify that HEAD
  exactly matches the durable chain tail.
- Serialized concurrent service writes and budget mutations. Budget reserve/spend/release is
  receipt-idempotent, rejects conflicting replay and overspend, and cannot oversell under
  concurrent reservations.
- Added the real provider action saga: durable intent, inspect-by-idempotency-key before launch,
  terminal reconciliation, one observation, one cost settlement, residual reservation release,
  and one commit.
- Added a read-only `dsh-rsi-status` command that validates and replays the journal without taking
  or mutating the writer lock.

## Acceptance evidence

The successor passes a Cordis lifecycle E2E that mounts `ctx.rsi`, writes and replays durable
state, serializes 16 concurrent records, runs the read-only status command, unloads with no new
active handle, releases the writer lock, and starts a successor service over the same run.

A process-level fault-injection E2E launches a real Node controller process four times, killing it
with `SIGKILL` immediately after each durable `intent`, `launch`, `collect`, and `commit` boundary.
Each successor verifies the dead PID/start identity, preserves `lock.stale-*` evidence, reconciles
the same provider job, and terminates cleanly. Every case ends with exactly one external launch,
one observation, one spend, one residual release, one commit, and zero remaining reservation.

Additional acceptance includes 64 generated valid event sequences, concurrent-lock and
concurrent-budget adversarial tests, bad-HEAD/hash-chain/object/snapshot fail-closed tests, and
snapshot/full-replay equivalence.

Full repository verification at this successor passed:

- TypeScript, ESLint, and Prettier;
- 200/200 unit tests;
- 16/16 executed E2E tests; one real-model Gate 4 test explicitly skipped because the process had
  no provider credential;
- provenance, upstream-clean, AGENTS/CLAUDE equality, and U+FFFD guards.

## Current claim boundary

```text
GATE_0_ACCEPTED
GATE_1_ACCEPTED
GATE_2_ACCEPTED
GATE_3_ACCEPTED
GATE_4_ACCEPTANCE_FAILED
FORMAL_SEARCH_NOT_STARTED
SEALED_NOT_ACCESSED
NO_PERFORMANCE_CLAIM
```
