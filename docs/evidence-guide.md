# Evidence interpretation

| Artifact                          | What it proves                                        | What it does not prove              |
| --------------------------------- | ----------------------------------------------------- | ----------------------------------- |
| `config.json`                     | frozen route/profile/limits for one run               | provider availability               |
| journal + `HEAD`                  | ordered, tamper-evident durable controller events     | external job correctness alone      |
| `budget.jsonl`                    | idempotent USD reservations, spend and release        | market price beyond frozen schedule |
| `failure-pool.json`               | tasks frozen before candidate rewards                 | representative benchmark score      |
| external evaluator `summary.json` | normalized one-trial reward, usage and raw job path   | official leaderboard result         |
| proposal gateway receipts         | locked request/response identity without model text   | proposal quality                    |
| candidate build receipt           | source/build/capsule content identities               | improvement                         |
| crash-resume receipt              | one launch/observation/commit after real process kill | all possible crash timings          |
| `audit` result                    | stable-demo invariants at the final state             | sealed promotion or SOTA            |

Per-run state is private and is not committed. A public release audit records hashes and aggregate facts without
publishing credentials, concealed assignments, model reasoning, task trajectories or private provider responses.
