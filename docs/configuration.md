# Configuration

`dsh-rsi init` writes a private, no-replace `config.json`. `stable-demo` uses schema 10; the v0.1.1 successor
`v011-stable-demo` uses schema 11 and protocol `dsh-rsi-candidate-tree-v2`. The file contains no credential.
Changing an identity, profile or limit requires a new state directory and run ID.

| Field                      | Stable-demo value                       |
| -------------------------- | --------------------------------------- |
| profile                    | `stable-demo`                           |
| code identity              | full Git commit captured by `init`      |
| admitted children          | 3                                       |
| baseline failure discovery | at most 12, in fixed batches of 6       |
| observed task order        | shortest timeout, then task ID          |
| candidate trials           | 3                                       |
| total solver trials        | at most 15                              |
| evaluator concurrency      | 1                                       |
| requested model            | `deepseek-v4-flash-zen`                 |
| effective provider model   | `deepseek-v4-flash`                     |
| reasoning                  | `high`                                  |
| context                    | 1,048,576 tokens                        |
| output ceiling             | 32,768 tokens                           |
| wire API                   | compatible Chat Completions             |
| candidate feedback         | frozen `DEV_OBSERVED` baseline failures |
| sealed access              | forbidden; required count is 0          |

`v011-stable-demo` keeps the same K=3/task/budget/model limits while replacing the single-file patch proposal with
the bounded multi-file candidate-tree protocol, exact-parent Loader proposal mode, raw evidence citations,
candidate-owned tests, admission receipts and mechanism-outcome feedback. Its failure-discovery order is frozen
outcome-blind from published inventory metadata: `hard` before `medium` before `easy`, then shortest timeout and task
ID. This increases the chance of finding a real failed task without reading candidate rewards or sealed data.

The provider URL is read from `[model_providers.deepseek]` in private `~/.codex/config.toml`; the bearer is read
from private `~/.codex/auth.json`. `doctor` fails before a paid request if either file, Docker, Harbor, task material,
state permissions or budget is unavailable.
