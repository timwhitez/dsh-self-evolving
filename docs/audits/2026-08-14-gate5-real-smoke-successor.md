# Gate 5 real observed smoke successor — 2026-08-14

**Status:** `REAL_OBSERVED_SMOKE_ACCEPTED_NOT_GATE5`
**Run:** `gate5-real-smoke-v5`
**Sealed access count:** 0

The user explicitly directed continued use of the existing CPA client key after the v3 exposure
incident. The successor does not place it in Harbor `agent.env`: a mode-0600 file is mounted
read-only and read inside the disposable container. Live host checks found zero credential matches
in process command lines or environments; the post-run byte scan found zero persisted matches.

The fixed capsule adds the pinned DSH sandbox policy, subprocess executor, sandboxed bash executor,
and never-approval policy before the ACP app. A structural CPA probe independently proved that the
Zen compatible Chat Completions route returns `finish_reason=tool_calls` when required. This
separated the route from the v4 failure, whose capsule had registered a model-facing bash surface
without an executor.

v5 completed `fix-git` through real Harbor/ACP/DSH with reward 1, no exception, 12 bash calls, and
10 DSH usage events. Total usage was 12,060 uncached input, 68,392 cache-read, and 4,367 output
tokens over 112.853 seconds. Raw Harbor and DSH hashes are frozen in
[`evidence/gate5/real-smoke-successor.json`](../../evidence/gate5/real-smoke-successor.json).

This is one DEV_OBSERVED engineering smoke, not Gate 5 acceptance or a performance claim. CPA and
Harbor do not supply a USD price, so the trial is explicitly `priced=false`; the 60x2 matrix and
three-candidate strata calibration have not started. A concealed guard-handle evaluation broker is
also required before the 12 DEV_GUARD tasks can be evaluated without revealing their assignment.
