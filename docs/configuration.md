# Configuration

`dsh-self-evolving init` writes a private, no-replace `config.json`. `stable-demo` uses schema 12; the multi-file
`v011-stable-demo` profile uses schema 13 and protocol `dsh-self-evolving-candidate-tree-v2`. The file contains no credential.
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
| requested model            | `deepseek-v4-flash`                     |
| effective provider model   | `deepseek-v4-flash`                     |
| reasoning                  | `high`                                  |
| context                    | 1,048,576 tokens                        |
| output ceiling             | 32,768 tokens                           |
| endpoint                   | `https://api.deepseek.com/v1`           |
| wire API                   | official Responses                      |
| credential                 | trusted-host broker `DEEPSEEK_API_KEY`  |
| response storage           | disabled (`store=false`)                |
| candidate feedback         | frozen `DEV_OBSERVED` baseline failures |
| sealed access              | forbidden; required count is 0          |

`v011-stable-demo` keeps the same K=3/task/budget/model ceilings while replacing the single-file patch proposal with
the bounded multi-file candidate-tree protocol, exact-parent Loader proposal mode, raw evidence citations,
candidate-owned tests, admission receipts and mechanism-outcome feedback. Its failure-discovery order is frozen
outcome-blind from published inventory metadata: `hard` before `medium` before `easy`, then shortest timeout and task
ID. This increases the chance of finding a real failed task without reading candidate rewards or sealed data.
The pool accepts `fail/0` and attributable `invalid/0` non-passes; `invalid/null` and any unknown reward remain
excluded. The evaluator's retry/reconciliation layer settles retryable infrastructure outcomes before this filter.
Unlike schema 10's six-task batches, schema 11 evaluates the frozen order sequentially and stops baseline discovery
as soon as the first eligible non-pass is committed, with a hard ceiling of 12 baseline trials.

The bearer is read only from `DEEPSEEK_API_KEY` in the trusted host process. Codex `auth.json`, Codex `config.toml`
and CPA are not part of the default route. `doctor` probes the official `/models` endpoint and fails before a paid
request if the credential, exact route, model, Docker, Harbor, task material, state permissions or budget is unavailable.

Evaluation uses `gate5-credential-broker-v2`: each `(task, attempt)` receives a distinct host broker and only the
fixed `/run/dsh-self-evolving/model.sock` Unix socket. The candidate-facing Responses bundle is a gateway client;
`DEEPSEEK_API_KEY`, `provider.secret`, arbitrary URLs and authorization headers never enter its process. The controller
sanitizes the Harbor subprocess environment, forces the copied task's agent phase to `no-network`, and records both
the original and overlay digests. The socket source is protected by a host-private temporary directory; provider
retry/continuation counts are frozen and output-reserved; the artifact TLS private key is temporary. Signed broker
evidence must match the DSH session usage before normalization, and the task hashes/network policy are revalidated
after execution.

Runs created by the retired credential-launcher protocol are historical evidence only. They are not upgraded in
place and cannot support a current credential-isolation or official benchmark claim; use a fresh run ID for broker-v2.

For the low-consumption effectiveness gate, set a fresh run ID and no-replace receipt path, then run:

```bash
export DEEPSEEK_API_KEY='...'
export DSH_SELF_EVOLVING_EFFECT_RUN_ID='effect-local-1'
export DSH_SELF_EVOLVING_EFFECT_RECEIPT_PATH="$PWD/evidence/effectiveness/effect-local-1.json"
pnpm effectiveness:official
```

The gate preregisters target and preserved modes, admits both baseline and child, then compares fixed Loader replay
digests. It proves a measurable runtime behavior delta only; it does not prove a Terminal-Bench score improvement.

## Profile bundle runtime variables

When the controller is installed as a profile bundle (`@dsh-self-evolving/core` via `dsh plugin add`), the bundle
requires these environment variables before the profile starts; omission fails Config validation by design:

| Variable                      | Purpose                        |
| ----------------------------- | ------------------------------ |
| `DSH_SELF_EVOLVING_STATE_DIR` | Private, no-replace state root |
| `DSH_SELF_EVOLVING_RUN_ID`    | Unique identity of the run     |

State directories are private evidence and must not be committed.
