# Research basis and design synthesis

**Snapshot date:** 2026-08-14  
**Purpose:** distinguish source-backed ideas from this project's engineering decisions

## 1. Sources and how they are used

| Source                                                                                                                                                  | Evidence adopted                                                                                                                                      | Project adaptation                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| DeepSeek Harness source/docs + `/root/paper.pdf`                                                                                                        | Cordis reversible effects, reactive dependencies, Fibers, Loader/HMR and native agent/tool/session seams make a plugin-native RSI design possible     | Controller and candidates are DSH plugins; untrusted candidates still run out of process because lifecycle isolation is not security isolation       |
| [Lilian Weng, Harness Engineering for Self-Improvement](https://lilianweng.github.io/posts/2026-07-04-harness/)                                         | simple/generic mechanisms, filesystem persistent state, explicit workflows/background work, optimization moving from prompt to harness/optimizer code | raw evidence is file-addressable; hard-coded heuristics are minimized; infrastructure/policy remains deterministic                                   |
| [DGM](https://arxiv.org/abs/2505.22954) and [code](https://github.com/jennyzzt/dgm)                                                                     | growing archive preserves diverse stepping stones and outperforms single-path greedy evolution                                                        | all safe runnable candidates remain; no score-based pruning                                                                                          |
| [HGM](https://arxiv.org/abs/2510.21614) and [code](https://github.com/metauto-ai/HGM)                                                                   | clade outcome aggregation, Thompson sampling, single task-pair evaluations, UCB-Air expand/evaluate split, async scheduling                           | canonical-parent tree + donor provenance; wave-synchronous pending-aware scheduler; `alpha=0.6`; default no cooling until TB ablation                |
| [Meta-Harness](https://arxiv.org/abs/2603.28052) and [code](https://github.com/stanford-iris-lab/meta-harness)                                          | agentic proposer can inspect all historical source/scores/traces via filesystem; Pareto views; end-to-end harness-code search                         | proposer gets label-filtered raw evidence exports and archive catalog; cost/time are Pareto constraints, not a hidden weighted reward                |
| [SICA](https://github.com/MaximeRobeyns/self_improving_coding_agent)                                                                                    | a compact editable agent and empirical utility can bootstrap self-improvement                                                                         | preserve a small candidate surface, but add archive, independent verifier and crash-safe control around it                                           |
| [Self-Harness](https://arxiv.org/abs/2606.09498)                                                                                                        | weakness mining, diverse/minimal proposals, fixed model/evaluator, regression validation; held-in evidence separated from held-out traces             | keep mechanism-grounded proposal/preservation; do not reuse the 29 sealed set on every candidate, because repeated gating makes it adaptive feedback |
| [Omnigent](https://www.databricks.com/blog/introducing-omnigent-meta-harness-combine-control-and-share-your-agents)                                     | policies, spend limits and sandboxing should be enforced in a stateful control layer rather than prompts                                              | enforce these outside candidate code, but do not add Omnigent as a second runtime because DSH already supplies the project's core composition layer  |
| [Terminal-Bench 2.1 release](https://www.tbench.ai/news/terminal-bench-2-1) and [official repo](https://github.com/harbor-framework/terminal-bench-2-1) | 89 tasks, corrected task set, Harbor execution, ≥5 attempts for leaderboard, trajectory review                                                        | pin dataset digest; separate search/sealed/full protocols; never call a local search score an official result                                        |

## 2. DSH paper implications

`/root/paper.pdf`, _A Programming Paradigm for Spatiotemporal Composability_, motivates the core choice:

- self-evolving harness modifications are dynamic composition events;
- temporal composability requires component effects to undo on removal;
- spatial composability requires dependencies to appear/disappear reactively;
- Cordis implements these ideas with Fiber lifecycle, configuration reconciliation and HMR;
- a failed Fiber can be isolated from siblings, and quiescent composition should match a static final assembly.

This supports native candidate plugins and rollback tests. It does **not** establish malicious-code containment,
benchmark validity or that any generated edit is beneficial. Those require process isolation and empirical gates.

Paper artifact used for design: `sha256:4d48478dc0b6222d9f74d7db10ee776449b1209eb112632336544d32a49db97f`.

## 3. Algorithm fidelity versus adaptation

### HGM elements used directly

```text
S_C(a) = sum of successes in the canonical clade
F_C(a) = sum of failures in the canonical clade
CMP_hat(a) = S_C(a) / (S_C(a) + F_C(a))
parent draw ~ Beta(1 + S_C(a), 1 + F_C(a))
node-eval draw ~ Beta(1 + s(a), 1 + f(a))
expand when N^alpha >= |T|, alpha=0.6
```

HGM's true CMP is a future-policy expectation; the count ratio is only its estimator. The public implementation's
default is `cool_down=false`, although the paper describes a monotone temperature schedule. This project fixes
`tau=1` for the primary run and treats cooling as a development-only ablation, rather than presenting
`tau=B/b` as an unquestioned fact.

### Engineering adaptations

- canonical parent stays a tree for unambiguous clade counts; crossover is recorded as donor evidence, not a
  second parent edge;
- concurrent decisions use frozen waves and pending reservations to avoid favoring fast tasks;
- missing/corrupt results count as failures unless an outcome-blind infrastructure classifier applies;
- final choice uses a fixed tournament and task-weighted paired comparison, not a partially observed mean alone;
- sealed evaluation is outside the selector and cannot update the archive.

These are project decisions that need ablation/validation; they are not claims made by HGM.

## 4. Held-out validity

Self-Harness's published algorithm evaluates each proposal on held-in and held-out splits and accepts only
non-regressing edits. This is useful regression control, and its held-out traces are not proposer inputs. However,
the held-out outcomes influence every acceptance decision. Under 80 adaptive iterations, that set becomes part of
the optimization loop even if traces remain hidden.

For a credible “unseen-task +5pp” result, this project instead uses:

- 48 observed development tasks for proposal evidence;
- 12 hidden-identity development guard tasks for adaptive regression/selection;
- 29 sealed tasks with no identity, trace, outcome or aggregate feedback until one candidate is locked.

The trade-off is less search feedback and lower final statistical power. The benefit is a clear generalization
estimand. A single fixed 60/29 split is still only one benchmark partition; full 89-task evaluation and external
benchmarks are needed before claiming broad transfer.

## 5. Evidence over prompt compression

Weng and Meta-Harness converge on a useful pattern: long-horizon state should live in files, while the model gets a
small index and standard tools to retrieve what matters. This project therefore stores:

- immutable source, diffs, manifests, raw trajectories and results as content-addressed objects;
- a compact archive catalog for discovery;
- label-filtered read-only exports per proposer action;
- deterministic summaries only as derived views, never as the sole evidence.

The model can use `rg`, read manifests and inspect selected traces. A deterministic controller enforces labels,
budget and output schemas; it does not manually decide failure clusters or prescribe fixes.

## 6. Cost evidence

The Meta-Harness public TerminalBench-2 example currently documents an 89-task × 2-attempt search evaluation with
high concurrency as roughly 4–6 hours and about USD 500 **per iteration** for its stated model. That does not
predict this project's fixed model cost, but it invalidates the previous draft's unsupported `~$0.20/candidate`
assumption.

Consequences:

- `$500`/16h is a calibration gate, not a promise made before baseline;
- HGM-style partial task allocation is essential;
- formal 89×5 evaluation is budgeted separately and never silently reduced;
- all auxiliary model calls count.

## 7. Safety evidence and limitations

The earlier documents cited arXiv `2510.15972` as an “AHE safety” source. The arXiv record is actually _Quantum
NLP models on Natural Language Inference_. That citation is removed. The safety design here is grounded in the
actual DSH/Harbor trust contracts, standard isolation/integrity principles, benchmark policy and explicit threat
analysis; it is a project specification, not borrowed authority from that paper number.

Residual limitations that documentation and tests cannot erase:

- TB 2.1 tasks/instructions are public; task-agnostic scans cannot prove the base model never memorized them;
- no sandbox proves absence of every escape;
- 29 sealed tasks give limited power and one partition;
- verifier mode changes can break official comparability;
- a high TB score can be model/harness-specific and does not imply general intelligence or safe deployment;
- SOTA and leaderboard availability move over time and must be refreshed at run start.

## 8. Reference source snapshots

The design inspection used these code snapshots (not vendored dependencies):

```text
deepseek-harness  47f943859bef60e4160492346772ded9b24f765a
harbor            ac398bbda7c4c1073461797d3b95c2455cc671b5
terminal-bench    d28711d0da2675d0bb1d56de45ae5df6082438a3 (legacy reference)
terminal-bench-2-1 7131e4375048a0e408a8fb404b5f499d726b695b
HGM               013872d95da978483f5b540e531db063d23890da
DGM               a565fd2d1dca504ef5104a7cc0f3bdc4ab9b4fd2
Meta-Harness      44b9942127847f7421db70d8c7e48407f09a3c70
SICA              ed8275dca4d3c5dbf77229964351fe9b424797dc
```

Implementation must create a new machine-readable lock from live inputs; this list is historical design evidence.
