# Gate 5 real smoke security incident — 2026-08-14

**Status:** `QUARANTINED_SECURITY_SUCCESSORS_REQUIRED`; `GATE_5_NOT_ACCEPTED`
**Accepted real trials:** 0
**Sealed access count:** 0

## Successor sequence

Three one-task `fix-git` DEV_OBSERVED smoke attempts were bounded to one trial each. v1 failed
before environment creation because it used the reference checkout's legacy `task.yaml` layout
instead of the fixed TB 2.1 `task.toml` materialization. v2 reached Harbor but the pinned Loader
rejected `workspaceContext: true`; it made no provider call. Both are infrastructure failures and
remain quarantined.

v3 passed Loader initialization and reached the real Zen-compatible ACP path. During a read-only
host process inspection, Harbor was found to expand `agent.env` into `docker compose exec -e`
arguments. This made the bearer value visible through the host process table. The trial and its
container were immediately stopped. It has no terminal normalized result and is permanently
`ABORTED_CREDENTIAL_EXPOSURE`, regardless of any partial task work.

Content-addressed run dispositions are recorded in
[`evidence/gate5/real-smoke-incidents.json`](../../evidence/gate5/real-smoke-incidents.json).
The preserved run roots are under `/var/lib/dsh-rsi-controller/gate5-real/`.

## Containment and remediation

- The Harbor process and exact `fix-git` container were stopped; no Gate 5 process/container remains.
- A byte scan using the current credential found zero persisted matches below the Gate 5 run root.
- The provider now rejects every sensitive `agentEnv` key, even if its value is a Harbor host
  template, because templates are expanded before the Docker CLI invocation.
- The successor capsule uses a tiny trusted launcher that reads a mode-0600, read-only mounted
  credential file inside the container and exports it only there. Job YAML and host process
  arguments contain only the mount path.
- The runner is still restricted to published DEV_OBSERVED IDs and refuses guard/sealed IDs.

## Rotation boundary

A read-only audit of CPA on `64.186.236.156` found one configured client API key and a mode-0644
`/root/cliproxyapi/config.yaml`. CPA was not changed. Removing/replacing its only client key can
interrupt other active clients, so rotation requires an explicit operator decision. No further
real provider call is permitted with the exposed credential.

After rotation, a new run ID must first repeat exactly one observed-task smoke and prove: no secret
in persisted bytes or host process arguments, real ACP initialize/prompt/tool calls, complete raw
evidence, normalized result, and usage reconciliation. Only then may the 60x2 baseline begin.
