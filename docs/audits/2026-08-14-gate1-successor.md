# Gate 1 successor acceptance — 2026-08-14

**Predecessor audit:** `docs/audits/2026-08-14-gate-acceptance-audit.md`  
**Status at acceptance:** `GATE_1_ACCEPTED`; later superseded by the Gate 2 successor
**Sealed access:** none

## Successor changes

- Replaced the placeholder `runtime/INSTALL.md` with a recursively resolved, pinned package
  closure under `runtime/node_modules` plus `runtime/package-closure.json`.
- Added an immutable `runtime/bin/dsh-rsi-acp` entry and mirrored runner configuration inside
  the closure; no source-checkout resolution is needed at runtime.
- Added a root-level launcher and bundled Node runtime so Harbor's binary installer does not rely
  on Node being present in the task image.
- Generated a content-bound SPDX 2.3 package inventory from the actual closure rather than
  trusting caller-provided placeholder JSON.
- Removed the `SHA256SUMS` self-reference/capsule-manifest cycle. Data files are covered by
  `SHA256SUMS`; manifest and sums bytes are jointly bound by the returned capsule hash.
- Limited pinned DSH packages to their declared published surface; package-internal `src/` and
  `tests/` directories are excluded from the runtime closure.

## Acceptance evidence

The current successor passed:

- deterministic double capsule build and byte verification of every `SHA256SUMS` entry;
- real Cordis Loader boot of the packed candidate;
- ACP initialize, session/new, prompt, committed response, and teardown from the packed closure;
- an isolated Linux network namespace run with a different `/proc/.../ns/net` identity;
- a fresh `FROM scratch` Docker image with `ReadonlyRootfs=true`, `NetworkMode=none`, no source
  mount, and a successful ACP prompt using the deterministic mock adapter;
- TypeScript, ESLint, Prettier, 192/192 unit tests;
- 9/9 executed E2E tests; one Gate 4 real-model test was explicitly skipped because no provider
  credential was injected into the audit process;
- provenance, upstream-clean, AGENTS/CLAUDE byte equality, and UTF-8 replacement-character
  guards.

The Harbor script-agent smoke was Gate 2 engineering evidence only. Gate 2 was later closed by
`docs/audits/2026-08-14-gate2-successor.md` using a real packed candidate and Harbor ACP client.

## Current claim boundary

```text
GATE_0_ACCEPTED
GATE_1_ACCEPTED
GATE_2_ACCEPTANCE_FAILED
FORMAL_SEARCH_NOT_STARTED
SEALED_NOT_ACCESSED
NO_PERFORMANCE_CLAIM
```
