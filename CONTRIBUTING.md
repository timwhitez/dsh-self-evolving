# Contributing to dsh-self-evolving

Thank you for improving the project. Contributions are welcome when they preserve the evidence, isolation, and
claim boundaries that make self-evolution auditable.

## Before you start

1. Read [AGENTS.md](AGENTS.md), [PROJECT_STATUS.md](PROJECT_STATUS.md), and the specification that owns the surface
   you plan to change.
2. Open an issue for a substantial protocol, architecture, or public-interface change.
3. Create a focused branch from `main`; do not combine unrelated refactors with a behavior change.
4. Keep `deepseek-harness/`, `harbor/`, and `tb/` at their pinned commits and unmodified.

Use the [security policy](SECURITY.md), not a public issue, for credential exposure, sandbox escape, sealed-data
disclosure, or provider replay vulnerabilities.

## Development setup

The project is source-archive-first and uses a pinned multi-repository closure:

```bash
corepack enable
pnpm setup:source
```

The supported host and tool versions are listed in [docs/quickstart.md](docs/quickstart.md). Do not put API keys in
`.env`, fixtures, issue text, snapshots, or logs.

## Change contract

- Add or update a failing contract test before changing behavior.
- DSH plugins require both unit coverage and a real Cordis Loader E2E.
- State-machine changes require crash, resume, and deterministic replay coverage.
- Adapter changes require route-lock, secret-boundary, retry, and normalized-usage tests.
- Protocol, trust-boundary, model-route, split, metric, retry, or cost changes require an ADR and a fresh run lineage.
- Never rewrite accepted evidence. Produce a versioned successor and keep the predecessor quarantined or superseded.

A passing engineering test does not establish benchmark improvement. Keep claims no broader than the committed
artifact supports.

## Required checks

Run the complete local gate before requesting review:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
env -u DEEPSEEK_API_KEY pnpm test:e2e
pnpm provenance:check
pnpm upstream:check
pnpm byteequal:check
pnpm release:check
```

Credential-gated tests incur API cost and are not a routine PR requirement. If a change touches the official
provider or effectiveness path, record whether these were run and never publish their credential:

```bash
pnpm test:provider:official
pnpm effectiveness:official
```

## Pull request checklist

- The change has one clear objective and an evidence-backed acceptance condition.
- Tests cover the failure first and the repair second.
- Public docs, schemas, changelog, and migration notes are updated where relevant.
- No generated candidate, private state, reasoning text, credential, concealed assignment, or paid-provider body is
  included.
- Git status, staged diff, upstream cleanliness, UTF-8, and `AGENTS.md`/`CLAUDE.md` equality were checked.
- The PR states exactly what was verified, skipped, quarantined, and not claimed.

## Style

- TypeScript stays strict and uses the existing formatter and linter.
- Cordis bundles use namespace-form exports and are exercised through the real Loader.
- Unknown or incomplete evidence fails closed; do not replace it with zero or infer a successful outcome.
- Documentation should be direct, reproducible, and explicit about security and benchmark boundaries.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
