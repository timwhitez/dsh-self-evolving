# Contributing

Use a focused branch and keep the three upstream checkouts unmodified. Before changing behavior, add a failing test
for the contract. Run:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm provenance:check
pnpm upstream:check
pnpm byteequal:check
```

Never commit credentials, private run state, model reasoning, Terminal-Bench concealed assignments or generated
candidate artifacts. Protocol, trust-boundary, model-route, split, metric or retry changes require an ADR and a fresh
run lineage. A green engineering test is not a benchmark claim.

Changes should preserve TypeScript strictness, namespace-form Cordis bundles, real Loader coverage, fail-closed
normalization and exactly-once recovery.
