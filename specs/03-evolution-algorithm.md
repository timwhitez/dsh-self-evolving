# 03 — Evolution and search algorithm

**Status:** normative draft  
**Primary algorithm:** archive search with HGM-style clade Thompson sampling and UCB-Air scheduling

## 1. Design goals

搜索必须同时解决四个问题：

1. 保留分数暂时不高但可能产生优秀后代的 stepping stones；
2. 在昂贵且有噪声的 task evaluation 上按不确定性分配预算；
3. 让模型读取丰富历史证据并提出 executable changes；
4. 在异步执行时仍有可审计、无“快者偏差”的决策序列。

因此使用 growing archive，不做 greedy overwrite；使用 HGM 的 clade statistics 选择 parent；使用
UCB-Air 在“生成新 arm”和“继续测量 arm”之间调度；使用文件系统 evidence + agentic proposer 生成
候选。所有算法只消费 development 数据。

## 2. Search unit and budgets

Run manifest 在启动前固定：

| Symbol          | Meaning                                        |           Initial default |
| --------------- | ---------------------------------------------- | ------------------------: |
| `K`             | admitted non-baseline candidates target        |                         3 |
| `B_eval`        | completed development agent-task trials budget | Gate 5 calibration output |
| `B_prop`        | proposal model token/USD budget                | Gate 5 calibration output |
| `W_p`           | independent children requested per expansion   |                         3 |
| `q0`            | forced cold-start trials per admitted node     |                         1 |
| `alpha`         | UCB-Air exponent                               |                       0.6 |
| `waveSize`      | decisions made from one frozen state           |    available worker slots |
| `shortlistSize` | final development tournament candidates        |                         2 |

默认 `stable-demo` 的 `K=3/q0=1/shortlistSize=2` 只证明稳定迭代，不执行 champion tournament。可选
`terminal-bench-formal` profile 使用 `K=80/q0=3/shortlistSize=5`。K 始终指通过完整 build/admission
pipeline 的唯一 artifacts；被拒 proposal、duplicate source、retry 和 evaluation 不计为 candidate，
但全部记入预算/证据。

若 UCB-Air 达到 `K` 所需的最低 `B_eval` 与总预算冲突，calibration 必须拒绝 run；不能临时更改
`alpha` 或把 failed build 算入 80。

## 3. Archive model

Archive 是 append-only candidate set + lineage edges + external observations：

```ts
interface CandidateNode {
  id: CandidateId
  canonicalParent?: CandidateId
  donorCandidates: CandidateId[]
  sourceHash: Sha256
  capsuleHash: Sha256
  status: CandidateStatus
  proposalReceipt: ArtifactRef
  buildReceipt: ArtifactRef
}

interface TrialObservation {
  candidateId: CandidateId
  opaqueTaskId: string
  split: 'dev-observed' | 'dev-guard'
  attempt: number
  reward: 0 | 1
  costUsd: number
  durationMs: number
  artifact: ArtifactRef
}
```

Canonical parent 形成一棵树，供 clade 统计。Donor 只表达 evidence/crossover provenance，不成为
第二条 parent edge，避免 DAG 重复计数。任何 view（best、frontier、clade counts）都从事件重建。

所有 admitted candidates 留在 Archive；低分节点不删除。只有安全 invalidation 或 artifact 损坏会
令其失去 action eligibility。

## 4. Utility observations

Primary utility 是 verifier binary pass。对每个节点 `a`：

```text
s(a) = number of completed development passes
f(a) = number of completed development failures
n(a) = s(a) + f(a)
```

缺失、agent error、timeout、corrupt result 默认计 `f += 1`。只有外部 reliability classifier 在不知道
reward 的情况下判定为 allowlisted infrastructure failure 时，trial 才不进入 `s/f` 并按相同
idempotency key 重试。

任务 sampler 在每个候选上无放回选 task，优先全局低覆盖 stratum，以降低难度构成偏差。完成 60
个 development task 前不得重复；重复 attempts 只用于预注册的 tournament/ambiguity resolution。

## 5. Clade metaproductivity estimator

对 canonical tree 中以 `a` 为根的 clade `C(a)`：

```text
S_C(a) = sum(s(x) for x in C(a))
F_C(a) = sum(f(x) for x in C(a))
CMP_hat(a) = S_C(a) / (S_C(a) + F_C(a))
```

当分母为 0 时只报告 `undefined`，parent selection 使用 Beta prior。该估计是 HGM 的 clade outcome
aggregate；它不是论文中不可观测的 true CMP，也不能解释成长期改进概率。

Parent Thompson draw：

```text
theta_clade(a) ~ Beta(tau * (1 + S_C(a)), tau * (1 + F_C(a)))
parent = argmax theta_clade(a)
```

Primary run 默认 `tau=1`（HGM 公开实现的 `cool_down=false`），避免未经 TB 2.1 消融就人为压缩后期
探索。MAY 在 Gate 5、只用 development pilot 的预注册 ablation 中比较 cooling：

```text
tau(N) = min(10000, (B_eval / max(1, B_eval - N))^beta), beta=1
```

一旦 run manifest 冻结，不得根据 search score 切换。

## 6. Node evaluation selection

当 action 是 evaluation 时，对每个有未测 task 且未超 per-node pending cap 的节点：

```text
theta_node(a) ~ Beta(1 + s(a), 1 + f(a))
candidate_to_evaluate = argmax theta_node(a)
```

例外优先级高于 Thompson：

1. 新 admitted node 必须完成 `q0=1` 个 cold-start trial：从 search 前冻结的 baseline-failed observed
   pool 确定性抽取 1 题；
2. shortlist tournament 的 coverage plan；
3. 已预注册的 paired baseline confirmation。

这些是实验设计约束，不是从 reward 触发的人工规则。

## 7. Expand versus evaluate: UCB-Air

令：

- `N` = 已完成且计入 utility 的 ordinary development trials；
- `P_eval` = 当前 wave 已预留 evaluation 数；
- `T` = 已 admitted candidates（含 baseline）加当前 wave 的 unique pending children 上界。

当且仅当以下成立且 admitted count `< K` 时选择 expansion：

```text
(N + P_eval)^alpha >= T, alpha = 0.6
```

否则选择 evaluation。达到 `K` 后只允许 evaluation/tournament；达到 `B_eval` 后不再启动 trial。

这保持 HGM 的 infinite-arm trade-off，但明确处理 pending work。`alpha`、计数定义和 off-by-one 必须
有 golden tests；不得把 proposal 次数当 `N`。

## 8. Wave-synchronous concurrency

完全按完成时间更新会偏向短任务/快候选。完全串行则浪费 benchmark 并发。因此采用冻结快照的
wave scheduler：

1. reducer 对 committed state 建立 `decisionSnapshotHash`；
2. 使用固定 RNG 流逐个产生最多 `waveSize` reservations，每个 draw 考虑此前 reservation 的 virtual
   pending，但不猜测 reward；
3. journal 先写完整 wave intent，再提交外部 jobs；
4. 等待全部 job 完成、达到固定 deadline 或得到 terminal failure；
5. 按 reservation sequence（不是 wall-clock finish order）commit results；
6. 从新 state 产生下一 wave。

Proposal pool 和 evaluation pool MAY 分开并行，但各自遵守 wave barrier。Parent 同一 wave 默认只
允许一个 expansion reservation，除非 eligible parent 数小于空闲 slot；这提升 lineage diversity。

RNG 使用 counter-based generator；每个 draw 记录 `(stream, counter, candidates, beta params,
sampled values, winner)`，resume 不重新抽样。

## 9. Proposer policy

Expansion 不是模板替换。由 parent candidate 的 `propose` mode 下运行的 agentic coder：

- 读取 parent source、Archive catalog、所有可见 historical source/diff/score；
- 按需读取 `DEV_OBSERVED` trajectories、passing examples 和 rejected proposal receipts；
- 使用标准 read/search/edit/bash/typecheck 工具；
- 输出至受限 child roots；
- 每个 child 给出一个可证伪的机制 hypothesis、证据引用和 preservation tests。

Prompt SHOULD 描述目标、边界和 output protocol，不列出 task-specific fix cookbook。Failure
clustering 由 proposer/diagnosis model 对真实证据完成；trusted code 只做 schema/大小/label 过滤，
避免手工规则成为能力上限。

为避免 proposal mode 只复制 parent：

- `W_p=3` children 需声明不同主 hypothesis；
- semantic diff 相同会 deduplicate；
- proposer 可读其他 clade 机制形成 donor provenance；
- no-change、test-only、comment-only 或仅延长 prompt 无机制证据的 child 被拒。

## 10. Archive views and Pareto policy

Archive 全保留，但 UI/shortlist 维护派生 Pareto frontier：

```text
maximize: development pass posterior lower bound
minimize: model cost, median wall time, input tokens, critical-risk count
```

性能不与成本随意线性加权。只有当两个候选的 development performance point estimate 相差不超过
预注册 `epsilon_perf=0.01` 时，才按以下顺序打破平局：

1. 更低 critical/high risk（critical 必须都是 0）；
2. 更低 mean cost；
3. 更低 median duration；
4. 更小 semantic diff；
5. lexicographically smaller full candidate hash。

Parent selection 仍以 CMP Thompson 为主，Pareto view 不删枝。

## 11. Stable-demo stop and optional formal tournament

`stable-demo` 完成 3 个 admitted candidates、至少两层 lineage 和 crash/replay 验收后直接停止，状态为
`STABLE_ITERATION_VERIFIED`。它不选择 champion，也不接触 guard/sealed service。

只有显式启动 `terminal-bench-formal` profile，完成 80 个 admitted candidates 后才进入固定 tournament：

1. 排除 invalid/quarantined、少于 `minEligibilityTrials`（默认 12）或 artifact 不完整节点；
2. 按 `q10(Beta(1+s,1+f))` 选前 `shortlistSize=5`，hash 固定 tie-break；
3. 为 shortlist 与 baseline 执行相同的 60-task development coverage plan；默认每 task至少 1 次；
4. observed 48 和 guard 12 都参与 selector；guard 始终向 proposer 隐藏，不伪称 held-out；
5. 计算 task-weighted paired delta、90% cluster-bootstrap LCB、cost/time；
6. 在 baseline + shortlist 中选最高 performance LCB，按第 10 节 tie-break。

合格节点不足时的确定性降级（在 run manifest 预注册，不得按分数临场发明）：

- 合格节点在 `1..4` 个之间：shortlist 取全部合格节点，tournament 照常执行；
- 合格节点为 0：若剩余 `B_eval` 允许，先对按 `q10` posterior 排序的前 `shortlistSize` 个
  admitted 节点执行 top-up trials 至 `minEligibilityTrials`（顺序与数量由固定 RNG stream 记录），
  再重新应用步骤 1–2；预算不足以完成任何 top-up 时，run 记为
  `NO_DEVELOPMENT_IMPROVEMENT`，不接触 sealed service。

若 baseline 获胜或 winner 的 development point delta `<= 0`，状态为
`NO_DEVELOPMENT_IMPROVEMENT`，不接触 sealed service。否则将 winner source/capsule/run manifest
三重 hash 写入 candidate lock；此后任何 mutation 都创建新 run。

stable-demo 的 baseline failure pool 和 candidate task RNG streams 必须在 candidate reward 可见前写入
manifest/journal。reward 出现后不得换题、补抽失败题或丢弃通过题。该 development score 只代表 demo
sample，不代表 Terminal-Bench 性能。

## 12. Sealed gate is outside the search algorithm

Selector 在 candidate lock 后停止。29 个 sealed task 的评测结果不会更新 CMP、parent posterior、
Archive score、proposer evidence 或第二次 selection。结果只产生：

```text
SEALED_PROMOTED | PROMISING_NOT_CONFIRMED | SEALED_REJECTED | PROTOCOL_INVALID
```

失败后不得回到 Archive 选择“下一个最好”再测；这样做会把 sealed set 变成 adaptive development。

## 13. Why previous held-out gating is rejected

“每个 candidate 同时在 search 和 29 held-out 上测试，若两者不下降则 accept”忠实复现
Self-Harness 的一种实验算法，但在 80 次适应性选择后，held-out score 已反复影响搜索，不再能支持
独立泛化声明。它也需要至少 `80 × 29` 额外 task trials，并强迫 Archive 退化成逐步 merge。

本设计保留其有价值部分——failure mining、minimal/diverse proposals、regression preservation——
但把 29-task set 作为一次性 sealed confirmation。12-task dev-guard 提供搜索期间的有限回归信号，
并明确标为 development。

## 14. Multiplicity and ablations

- 一个正式 run 只能有一个预注册 primary algorithm 和一个 sealed reveal。
- Hyperparameter pilot/ablation 必须在独立 run ID、development-only 数据和独立预算下完成。
- 多个 pilot 中挑最好再报告时，必须列出所有 runs；不能只展示 winner。
- 不同 proposer model/solver model/DSH version 是不同 experiment family，不能把最好结果拼成一条
  单一 evolution curve。
- Search curve 报告 best-so-far development 是描述性；只有 sealed gate 支持泛化结论。

## 15. Required algorithm tests

在付费运行前 MUST 有：

- small-tree 手算 CMP/Beta parameter golden tests；
- UCB-Air threshold/property tests（包括 pending、K/B 边界）；
- seeded RNG replay tests；
- duplicate child/donor edge/clade no-double-count tests；
- async wave 完成顺序置换不改变下一 state 的测试；
- missing/corrupt/timeout fail-closed tests；
- crash at every intent/launch/collect/commit boundary 的 replay tests；
- sealed event 注入 selector/proposer 时强制 abort 的 information-flow tests。
