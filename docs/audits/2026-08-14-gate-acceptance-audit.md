# Gate acceptance audit — 2026-08-14

**Verdict:** `GATE_1_ACCEPTANCE_FAILED`  
**Audited commit:** `4cbd1b0fe0df80765c9e9292f174b8c5f47c1034`  
**Authority:** `specs/00–07`, with `specs/07-implementation-plan.md` as the gate plan  
**Effect:** the earlier `GATE 0 + … + 6 COMPLETE` wording is `SUPERSEDED`; existing
artifacts and commits remain immutable engineering evidence, but later gates cannot start
until the earliest failed gate has a versioned successor and acceptance evidence.

## Verified baseline at audit start

- Git worktree was clean on `master` at the audited commit.
- TypeScript build, ESLint, Prettier, 192 unit tests, provenance check, upstream-clean
  check, AGENTS/CLAUDE byte equality, and the UTF-8 replacement-character scan passed.
- These results establish an engineering baseline only. They do not waive a gate's real
  runtime or experiment acceptance requirements.

## Acceptance matrix

| Gate | Audit status        | Decisive evidence or gap                                                                                                                                                                                                                                                                     |
| ---- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | `ACCEPTED`          | Real Cordis Loader lifecycle and default-export negative fixture exist; pinned provenance and upstream-clean guards pass.                                                                                                                                                                    |
| 1    | `FAILED`            | `capsule.ts` writes a placeholder `runtime/INSTALL.md`; `capsule-offline-boot.e2e.ts` links packages from the source checkout and performs Loader boot only. It does not prove a self-contained production closure or real ACP initialize/session as required by spec 02 §12 and spec 07 §3. |
| 2    | `BLOCKED_BY_GATE_1` | Harbor smoke uses fixed `oracle`/`nop` scripts and writes a trajectory stand-in. It does not run the real DSH candidate through Harbor's ACP client as required by spec 07 §4.                                                                                                               |
| 3    | `BLOCKED_BY_GATE_1` | Durable primitives exist, but `@dsh-rsi/core` is not a DSH bundle, exposes no `ctx.rsi` service, and the current crash tests simulate replay rather than exercising a controller/provider process at every saga boundary.                                                                    |
| 4    | `BLOCKED_BY_GATE_1` | A real-model proposal E2E exists, but archive-catalog export from `DEV_OBSERVED` only is unchecked and the pure policy functions are not an OS sandbox boundary.                                                                                                                             |
| 5    | `BLOCKED_BY_GATE_1` | Algorithm tests and a three-task calibration artifact exist; the required 60-task × at least two-attempt development baseline does not. The checklist text explicitly defers it despite marking the item complete.                                                                           |
| 6    | `BLOCKED_BY_GATE_1` | The ten-candidate run uses deterministic stub capabilities, not the frozen real proposer/builder/Harbor path. Cost-prediction error and audit acceptance remain unchecked.                                                                                                                   |
| 7    | `NOT_STARTED`       | No signed formal manifest, fresh/exact-identity baseline, 80-candidate run, tournament lock, or pre-lock sealed-access audit.                                                                                                                                                                |
| 8    | `NOT_STARTED`       | No candidate lock, sealed reveal, paired evaluation, promotion decision, full-set run, release, or final report.                                                                                                                                                                             |

## Repair order

1. Build a genuinely self-contained stable ACP capsule and prove initialize/new/prompt/
   disconnect in an isolated install without source-checkout resolution.
2. Drive that capsule through the real Harbor ACP path and make normalization consume real
   ACP/ATIF/DSH evidence rather than a stand-in.
3. Finish the controller bundle/service and process-level saga recovery, then complete the
   label-safe archive catalog and real ten-candidate pilot.
4. Establish the complete development baseline and re-freeze calibration before any formal
   search spend.
5. Only after Gates 1–6 accept, mint a fresh Gate 7 run ID; Gate 8 remains one-shot and
   conditional on a valid development champion lock.

## Claim boundary

Until successor evidence closes the matrix, the strongest supported status is:

```text
GATE_0_ACCEPTED
GATE_1_ACCEPTANCE_FAILED
FORMAL_SEARCH_NOT_STARTED
SEALED_NOT_ACCESSED
NO_PERFORMANCE_CLAIM
```
