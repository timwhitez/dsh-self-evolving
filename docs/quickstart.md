# Quickstart

## Supported environment

- Ubuntu 24.04 x86_64
- Node.js 22.19+ or 24+
- pnpm 11.7.0
- Docker with a working daemon
- Python 3.12, `uv`, and the pinned Harbor virtual environment
- Bubblewrap (`/usr/bin/bwrap`)

The stable demo uses `DEEPSEEK_API_KEY` only in the trusted host process and calls the DeepSeek official Responses
route. It does not read Codex credentials and does not default to CPA. Credentials are never copied into the
repository, config, candidate, command line, or durable evidence.

During Harbor evaluation, one host-side broker owns the key for each trial. The candidate container receives only
`/run/dsh-self-evolving/model.sock`; its agent phase has no direct Internet access and has neither a credential env
nor a secret-file mount. Use a fresh run ID: pre-broker Gate 5 state is deliberately not resumed or migrated.

## Install the controller bundle from npm

The controller bundle is published as `@dsh-self-evolving/core`. Provide an explicit state root and run id before
installing into a headless profile, because omission fails Config validation by design:

```bash
export DSH_SELF_EVOLVING_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/dsh-self-evolving/demo-1"
export DSH_SELF_EVOLVING_RUN_ID=demo-1
dsh plugin --profile headless add @dsh-self-evolving/core@0.2.3
```

## Install from a source checkout

Use the source checkout when you need the pinned DSH and the local workspace closure for development or
self-hosting:

```bash
corepack enable
pnpm setup:source
```

`setup:source` clones the three public upstream repositories at the commits in `provenance.lock.json`, installs and
builds DSH, creates the pinned Harbor environment, installs and builds the local workspace, then checks provenance.
It refuses an existing upstream checkout with a different remote or dirty worktree.

## Create and inspect a stable demo

Set the credential in the current shell without writing it to a project file:

```bash
export DEEPSEEK_API_KEY='...'
```

```bash
pnpm dsh-self-evolving init \
  --run-id stable-demo-local-1 \
  --state-dir /var/lib/dsh-self-evolving-controller/stable-demo-local-1 \
  --repo-root "$PWD" \
  --budget-usd 5

pnpm dsh-self-evolving doctor \
  --state-dir /var/lib/dsh-self-evolving-controller/stable-demo-local-1

pnpm dsh-self-evolving run \
  --state-dir /var/lib/dsh-self-evolving-controller/stable-demo-local-1
```

The development profile evaluates at most 12 baseline tasks in two fixed batches, then at most three candidates.
It never accesses the sealed split. Run `resume` after an interruption; do not run `run` again on existing state.

For the multi-file successor, add `--profile v011-stable-demo` to `init`. It requires a fresh state directory
and run ID; predecessor state is never upgraded in place. Schema 13 freezes a public-metadata hard-task order and
stops baseline discovery at the first attributable reward-zero non-pass, up to 12 trials.

```bash
pnpm dsh-self-evolving resume --state-dir /var/lib/dsh-self-evolving-controller/stable-demo-local-1
pnpm dsh-self-evolving status --state-dir /var/lib/dsh-self-evolving-controller/stable-demo-local-1
pnpm dsh-self-evolving audit  --state-dir /var/lib/dsh-self-evolving-controller/stable-demo-local-1
```

`STABLE_ITERATION_VERIFIED` proves generation, build, evaluation, persistence, lineage and recovery. It is not a
Terminal-Bench improvement or leaderboard claim.

## Run the low-cost effectiveness check

```bash
export DSH_SELF_EVOLVING_EFFECT_RUN_ID='effect-local-1'
export DSH_SELF_EVOLVING_EFFECT_RECEIPT_PATH="$PWD/evidence/effectiveness/effect-local-1.json"
pnpm effectiveness:official
```

Success is `ENGINEERING_EFFECT_VERIFIED`: the admitted child changes the preregistered solve-mode fixed replay while
the propose-mode control replay remains unchanged. The receipt records hashes, usage and estimated cost but no key,
reasoning text, model body or private trajectory.
