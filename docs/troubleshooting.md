# Troubleshooting

## `doctor` reports `FAIL`

Fix the named prerequisite and rerun `doctor`. It performs no paid model or solver request. Credential values are
never printed.

## `run: durable state already exists`

Use `resume` with the same state directory. `run` intentionally refuses to replace or fork an existing lineage.

## `journal: already locked`

Another controller with the same state directory is alive. Confirm its PID before stopping it. If the owner was
killed, the next `resume` preserves the stale lock as evidence and acquires a new lock.

## `real evaluator: incomplete prior external job`

The Harbor wrapper created an external run directory but did not produce a terminal `summary.json`. Preserve that
directory and inspect its job/trial logs. Do not delete it and retry under the same idempotency key; repair the cause
and create a successor run if reconciliation cannot prove whether the provider launched.

## All 12 baseline tasks pass

The terminal status is `NO_REAL_FAILURE_SIGNAL`. This is a valid fail-closed stop, not a stable-iteration proof. Use
a new preregistered observed panel in a successor run; do not pick tasks from candidate outcomes.

## Audit reports a missing crash receipt

Normal runs do not manufacture crash evidence. For the release acceptance exercise only, start a fresh run with
`--inject-crash-after-first-candidate`, verify the process is killed, then use `resume` exactly once.
