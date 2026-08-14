# Gate 5/6 evidence audit — 2026-08-14

**Status:** `GATE_5_NOT_ACCEPTED`; `GATE_6_NOT_ACCEPTED`
**Effect:** historical artifacts are preserved and quarantined; no result bytes were overwritten
**Sealed access:** none observed; historical public split seed invalidates that split for formal use

## Gate 5 findings

- `calibration-samples.jsonl` contains three baseline rows, one attempt each. The runner used
  Harbor `nop`, not the packed DSH baseline/model path, and recorded `costUsd=0`.
- The required development baseline is 60 tasks × at least two attempts (at least 120 attributable
  real trials). It is absent.
- The required real 3-candidate × task-strata calibration is absent.
- The `$41.96`/2.38-hour projection is deterministic over the three pipeline-overhead samples but
  is not an accepted cost/capacity estimate for real model trials.
- The ceremony seed is a source-code constant. Anyone with the public inventory can reconstruct
  all labels, so that assignment cannot be reused as a concealed formal split.

`evidence/calibration/STATUS.json` now marks the preserved artifacts
`QUARANTINED_NOT_ACCEPTED`. `verifyGate5Acceptance` rejects incomplete, nop/stub, unpriced,
unnormalized, exposed-split, sealed-accessed, or infeasible evidence.

## Gate 6 findings

- `scripts/run-pilot.ts` injects synthetic propose/build/evaluate capabilities; it does not call the
  frozen real proposer, builder, or Harbor path.
- Rewards use `Math.random`; the 0.001-second, 39-observation result has no normalized Harbor
  trajectory, provider cost receipt, or real process reconciliation lineage.
- No raw historical evidence citation audit, real crash receipt, critical-finding audit, or measured
  cost-prediction error exists.

`evidence/pilot/STATUS.json` now marks the preserved artifact `QUARANTINED_NOT_ACCEPTED`.
`verifyGate6Acceptance` requires K=10 full immutable identities, real capabilities, normalized/raw
evidence, reconciled actions/journal, real crash, required failure fixtures, zero critical findings,
and cost error within ±20%.

The two legacy runners were also made fail-safe: `run-pilot.ts` now emits only deterministic stub
output under `evidence/fixtures/pilot-loop`, while `run-calibration.ts` emits only Harbor-nop
pipeline-overhead output under `evidence/fixtures/calibration-overhead`. Neither writes Gate 5/6
acceptance directories.

## Safe resume order

1. Complete Gate 4's sandboxed real-provider successor with an injected credential.
2. Create a new sealed-service ceremony with a non-public seed and new split commitment.
3. Run the complete 60×2 baseline and real 3-candidate calibration through packed ACP/Harbor.
4. Freeze a feasible budget, then mint a fresh real K=10 pilot run; never resume `pilot-001`.
