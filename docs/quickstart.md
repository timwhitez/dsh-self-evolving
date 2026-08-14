# Quickstart

## Supported environment

- Ubuntu 24.04 x86_64
- Node.js 22.19+ or 24+
- pnpm 11.7.0
- Docker with a working daemon
- Python 3.12, `uv`, and the pinned Harbor virtual environment
- Bubblewrap (`/usr/bin/bwrap`)

The stable demo uses the existing root-only Codex DeepSeek credential and provider section. Credentials are never
copied into the repository, config, candidate, command line, or durable evidence.

## Install from a source checkout

The v0.1 release is source-archive-first. It does not publish a standalone npm package; the CLI depends on the
pinned DSH and local workspace closure bootstrapped below.

```bash
corepack enable
pnpm setup:source
```

`setup:source` clones the three public upstream repositories at the commits in `provenance.lock.json`, installs and
builds DSH, creates the pinned Harbor environment, installs and builds the local workspace, then checks provenance.
It refuses an existing upstream checkout with a different remote or dirty worktree.

## Create and inspect a stable demo

```bash
pnpm dsh-rsi init \
  --run-id stable-demo-local-1 \
  --state-dir /var/lib/dsh-rsi-controller/stable-demo-local-1 \
  --repo-root "$PWD" \
  --budget-usd 5

pnpm dsh-rsi doctor \
  --state-dir /var/lib/dsh-rsi-controller/stable-demo-local-1

pnpm dsh-rsi run \
  --state-dir /var/lib/dsh-rsi-controller/stable-demo-local-1
```

The development profile evaluates at most 12 baseline tasks in two fixed batches, then at most three candidates.
It never accesses the sealed split. Run `resume` after an interruption; do not run `run` again on existing state.

For the v0.1.1 multi-file successor, add `--profile v011-stable-demo` to `init`. It requires a fresh state directory
and run ID; schema-10 state is never upgraded in place. Schema 11 freezes a public-metadata hard-task order and
stops baseline discovery at the first attributable reward-zero non-pass, up to 12 trials.

```bash
pnpm dsh-rsi resume --state-dir /var/lib/dsh-rsi-controller/stable-demo-local-1
pnpm dsh-rsi status --state-dir /var/lib/dsh-rsi-controller/stable-demo-local-1
pnpm dsh-rsi audit  --state-dir /var/lib/dsh-rsi-controller/stable-demo-local-1
```

`STABLE_ITERATION_VERIFIED` proves generation, build, evaluation, persistence, lineage and recovery. It is not a
Terminal-Bench improvement or leaderboard claim.
