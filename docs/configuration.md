# Configuration

`dsh-rsi init` writes a private, no-replace `config.json` with schema version 4. The file contains no credential.
Changing an identity or limit requires a new state directory and run ID.

| Field                      | Stable-demo value                       |
| -------------------------- | --------------------------------------- |
| profile                    | `stable-demo`                           |
| admitted children          | 3                                       |
| baseline failure discovery | at most 12, in fixed batches of 6       |
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

The provider URL is read from `[model_providers.deepseek]` in private `~/.codex/config.toml`; the bearer is read
from private `~/.codex/auth.json`. `doctor` fails before a paid request if either file, Docker, Harbor, task material,
state permissions or budget is unavailable.
