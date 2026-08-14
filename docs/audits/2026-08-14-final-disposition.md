# Final disposition — 2026-08-14

## Outcome

The safe, credential-free engineering scope is complete. The project is not a completed RSI
experiment and has no performance, promotion, full-set, leaderboard, or release claim.

| Gate | Current status        | Evidence boundary                                                                     |
| ---- | --------------------- | ------------------------------------------------------------------------------------- |
| 0    | `ACCEPTED`            | pinned provenance and real Cordis Loader lifecycle                                    |
| 1    | `ACCEPTED`            | self-contained deterministic capsule; offline ACP in namespace/scratch container      |
| 2    | `ACCEPTED`            | packed candidate through real Harbor ACP with native trajectory/events/summary        |
| 3    | `ACCEPTED`            | DSH service, durable journal/budget/provider saga, real SIGKILL recovery              |
| 4    | `ACCEPTANCE_FAILED`   | model-free real DSH sandbox/gateway topology passes; no current real-provider receipt |
| 5    | `NOT_ACCEPTED`        | historical nop calibration quarantined; sealed service is synthetic preflight only    |
| 6    | `NOT_ACCEPTED`        | historical stub/Math.random pilot quarantined; no real K=10 successor                 |
| 7    | `BLOCKED_NOT_STARTED` | signed preflight verifier exists; no formal run directory/search                      |
| 8    | `BLOCKED_NOT_STARTED` | evidence verifier exists; no lock/reveal/sealed/full/release evidence                 |

## Successor commits

- `2744ab4` — self-contained Gate 1 ACP capsule.
- `610c5aa` — packed candidate through Harbor ACP.
- `3e27015` — durable Cordis controller recovery.
- `fd62874` — concurrent capsule-build serialization and byte snapshot hardening.
- `891819e`, `ce4ad2b`, `8a4282c` — proposer evidence/process isolation, fixed gateway, and real DSH
  topology inside Bubblewrap.
- `860d1cb` — Gate 5/6 artifact quarantine and fail-closed acceptance verifiers.
- `2e157b4` — separate-process sealed ceremony/candidate-lock engineering preflight.
- `4638e36` — signed Gate 7 pre-start verifier and `BLOCKED_NOT_STARTED` disposition.
- `1920d66` — Gate 8 sealed/full/release verifier and zero-reveal disposition.

## Identity and evidence state

- DSH: `47f943859bef60e4160492346772ded9b24f765a`.
- Harbor: `ac398bbda7c4c1073461797d3b95c2455cc671b5`.
- Terminal-Bench source: `d28711d0da2675d0bb1d56de45ae5df6082438a3`.
- Designed TB 2.1 dataset digest:
  `sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a`.
- Historical public-seed split/calibration and `pilot-001` bytes remain unchanged and carry
  `QUARANTINED_NOT_ACCEPTED` sidecars.
- No formal split was minted, no formal run directory was created, and sealed access/reveal counts
  remain zero.

## Verification

- TypeScript, ESLint, Prettier, provenance, upstream-clean, AGENTS/CLAUDE byte equality, and U+FFFD
  scans pass.
- Unit suite: 224/224 pass after the Gate 8 and candidate-lock successor.
- Sealed-service process E2E: 2/2 pass after the complete lock-identity successor.
- The most recent complete E2E suite before final documentation passed every executed test; the
  real-model proposal test was skipped because no provider credential was available. A final
  exact-HEAD complete E2E rerun is required before handoff and is recorded in the final response.

## Required resume order

1. Supply a current provider credential through the trusted host boundary and rerun Gate 4's exact
   Bubblewrap/fixed-gateway topology without exposing the credential to the sandbox or logs.
2. Deploy the sealed service under a durable separate principal/volume, mint a fresh formal split,
   then run the real 60x2 baseline and 3-candidate strata calibration.
3. Only after Gate 5 acceptance, run a fresh real K=10 Gate 6 pilot with process crash/reconcile,
   raw-evidence, audit, and measured cost-error receipts.
4. Only after signed Gate 7 preflight may the 80-candidate run start. Gate 8 may reveal once only
   after a positive champion is atomically locked.

No real orders, external deployment, paid formal search, or sealed evaluation was authorized or
performed.
