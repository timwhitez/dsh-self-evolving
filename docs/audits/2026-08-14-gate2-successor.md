# Gate 2 successor acceptance — 2026-08-14

**Predecessor audit:** `docs/audits/2026-08-14-gate-acceptance-audit.md`
**Status at acceptance:** `GATE_2_ACCEPTED`; later superseded by the Gate 3 successor
**Sealed access:** none
**Capability claim:** none; the deterministic mock trial received reward 0

## Successor changes

- Added deterministic `tar.gz` packaging for Harbor binary distributions. The archive has a
  root-level `dsh-rsi-acp`, fixed tar metadata, fixed ordering, and a computed SHA-256.
- Made the capsule runtime own its pinned Node executable; Harbor does not need to install or
  resolve Node from the task image.
- Added an immutable local HTTPS artifact path with an ephemeral test CA. Harbor downloads and
  verifies the exact archive checksum before extraction.
- Updated normalization to prefer Harbor's real `agent/` artifact layout and optionally require
  `trajectory.json`, `acp-events.jsonl`, and `acp-summary.json` together.
- Retained controller-written candidate/attempt attribution as a separate trusted sidecar.

## Acceptance evidence

The successor E2E built the baseline candidate, packed its full ACP runtime, and submitted one
real Harbor job through Harbor's generic `acp` agent. The trial completed ACP initialize and
prompt using the capsule-pinned deterministic mock adapter. Harbor then ran the task verifier and
recorded reward `0`, because the mock deliberately made no capability claim and did not write the
answer file.

The trial produced Harbor-native `agent/trajectory.json`, `agent/acp-events.jsonl`, and
`agent/acp-summary.json`. The normalizer required all three, verified candidate attribution,
returned an explicit valid `FAIL`, and produced the same content-addressed record on a second
parse. No script-generated trajectory stand-in was used.

Targeted verification passed:

- packed capsule offline/namespace/scratch ACP E2E: 3/3;
- deterministic archive/provider tests: 9/9;
- real packed-candidate Harbor ACP E2E: 1/1;
- normalizer real-layout tests: 10/10;
- TypeScript, ESLint, and Prettier checks.

## Current claim boundary

```text
GATE_0_ACCEPTED
GATE_1_ACCEPTED
GATE_2_ACCEPTED
GATE_3_ACCEPTANCE_FAILED
FORMAL_SEARCH_NOT_STARTED
SEALED_NOT_ACCESSED
NO_PERFORMANCE_CLAIM
```
