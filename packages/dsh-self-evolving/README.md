# @dsh-self-evolving/core

Trusted durable RSI controller for [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) (DSH):
content-addressed object store, hash-chain journal, pure state reducer + snapshot, action saga, and a
budget double-entry ledger. The filesystem is the source of truth; indexes are derived.

It is published as part of the [dsh-self-evolving](https://github.com/timwhitez/dsh-self-evolving) project and is
installable as a DSH profile bundle:

```bash
export DSH_SELF_EVOLVING_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/dsh-self-evolving/demo-1"
export DSH_SELF_EVOLVING_RUN_ID=demo-1
dsh plugin --profile headless add @dsh-self-evolving/core@0.2.2
```

The bundle fails Config validation when the state root or run id is omitted, by design.

Claim boundary: this package verifies stable iteration, crash recovery, and a fixed-replay engineering effect. It
does not claim a Terminal-Bench score improvement, sealed promotion, leaderboard result, or SOTA.
