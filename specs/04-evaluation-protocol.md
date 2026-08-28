# 04 — Evaluation, statistics, and promotion protocol

**Status:** normative draft  
**Benchmark:** Terminal-Bench 2.1 through Harbor

## 1. What this protocol must establish

评测要回答三个不同问题：

1. **Search utility**：哪个 candidate 值得继续评测或繁衍？
2. **Generalization**：固定 development champion 是否在未反馈任务上优于 baseline？
3. **Benchmark performance**：固定发布 artifact 在官方 89-task、≥5 attempts 协议下的分数是多少？

三者必须使用不同 label 和 gate。Development 数据可以驱动 1；一次性 sealed 数据只回答 2；完整
官方运行只回答 3。不得用其中一个结果替代另一个。

## 2. Frozen benchmark identity

Run manifest MUST 固定：

- registry name：`terminal-bench/terminal-bench-2-1`；
- dataset content digest，而不是 mutable `latest`；设计快照为
  `sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a`；
- 官方 source repo commit 和 89-task ordered inventory hash；
- Harbor commit/version、environment provider/image/resource policy；
- 每 task agent/verifier timeout，不覆盖为更宽松值；
- network mode、retry policy、concurrency 和 cleanup policy；
- solver model provider/endpoint/exact ID/reasoning effort/temperature/seed capability；
- DSH/candidate capsule、ACP protocol/runtime、base tool roster；
- scorer version 和聚合脚本 hash。

上游 TB 2.1 release 页面与 source README 对修订 task 数分别出现 28 和 26 的口径差异；本项目不
依赖该摘要数字。实际 task inventory + dataset digest 才是权威输入。

## 3. Deterministic split ceremony

### 3.1 Split sizes

89 个 task 固定分为：

- `DEV_OBSERVED`: 48 — trajectory/outcome 可进入 proposer；
- `DEV_GUARD`: 12 — outcome 可进入 selector/tournament，task identity/trace 不进入 proposer；
- `SEALED`: 29 — candidate lock 前，identity、assignment、outcome、trace 和 aggregate 全部不可见。

60 development task 用于适应性搜索，因此不能称 held-out。29 sealed task 只揭盲一次。

### 3.2 Stratification

在任何 candidate evaluation 前，由 trusted splitter 使用公开 task metadata 做确定性分层：

- primary category；
- timeout/resource class；
- network-dependent flag；
- modified-in-TB2.1 flag（若可从官方 change manifest 机械提取）。

difficulty bin 是可选分层维度，且有严格因果约束：为 89 个 task 分箱需要 split 前的全集
校准结果，而 sealed baseline 必须在 reveal ceremony 才运行。因此 difficulty bin 只允许两种
来源之一：

1. 由 trusted splitter 在 split ceremony 前、用预注册的固定参考配置对全部 89 task 执行
   一次性校准；其逐 task 结果直接写入 sealed store（`SEALED` label），controller、operator、
   proposer 和 selector 都不可读，splitter 只输出分箱后的 split mapping；
2. 若不支付该校准成本，则放弃 difficulty bin，只用上述公开 metadata 分层。

MUST NOT 用 development-only baseline 给 sealed task 定难度，也 MUST NOT 让全集校准的逐
task 结果在 candidate lock 前离开 sealed store。

层太小时使用 global controlled rounding：先从一个冻结的全局 48:12:29 目标矩阵计算每个
metadata stratum × label 的有理 ideal quota，再只在每格的 floor/ceil 之间求满足全部 row/column margin
的整数矩阵。主目标为最小化全矩阵 L1 quota error；同一最优值由冻结 seed 的 cell rank 决定，仍相同则按
canonical metadata tuple 与固定 label 顺序作 total-order fallback。不得按已消耗的剩余 quota 逐层贪心，
也不得让 task/stratum 输入枚举顺序改变 mapping。每个 stratum 内先按 task ID canonical 排序，再用独立
seeded stream 分配具体 task。Splitter code、input metadata hash、seed commitment 和输出 Merkle root
均写入 ceremony receipt。

### 3.3 Concealment

推荐两个阶段：

1. 在 search host 外生成 random 256-bit seed，发布 `sha256(seed || dataset_digest || protocol_hash)`；
2. 将 encrypted seed、split mapping 和 task identities 写入只对 sealed evaluator 可读的 store。

Controller 只得到：48 个 observed task handles、12 个 opaque guard handles、sealed Merkle root 和
count=29。Candidate/proposer sandbox 完全不挂载 mapping。candidate lock 后 sealed evaluator 验证
commitment、解密、执行并把一次性 reveal receipt 写入 run。

若未部署独立机密服务，至少使用不同 Unix account/volume key 和只读 ACL；同一进程中把 JSON
字段“藏起来”不构成 seal。

## 4. Baseline protocol

Baseline 不是零散 smoke score。`c0000` 必须与候选使用同一 stable runner/candidate contract，只含
预注册的初始 DSH plugin。

### 4.1 Stable-demo failure discovery

只在 published observed IDs 中按预注册顺序分批运行：

- 首批 6 题，每题 1 attempt；没有 failure 时再运行第二批 6 题；硬上限 12 trials；
- 出现至少 1 个真实 baseline failure 后冻结 failure pool；
- 12 题均通过时状态为 `NO_REAL_FAILURE_SIGNAL`，不得根据 candidate reward 再选题；
- raw pass/fail、error、timeout、tokens、cost、duration、tool calls；
- DSH event/ACP/ATIF reconciliation。

该 evidence 只服务 K=3 stable demo，报告标记 `FAILURE_DISCOVERY_SAMPLE`。

### 4.2 Optional benchmark baseline

启动 K=10/K=80 benchmark profile 前另行冻结对应 baseline。正式 K=80 仍要求 60 development tasks、
每 task 至少 2 attempts；stable-demo evidence 不可冒充或直接补齐这一矩阵。

### 4.3 Sealed baseline

为了避免先看 baseline sealed score 再调搜索，sealed baseline 与 locked candidate 在同一 reveal
ceremony 中运行。两者使用相同 task/attempt schedule 和 independent trial seeds，执行顺序按
task/attempt 随机交错；scheduler 不读取中间 reward。

### 4.4 Full-set baseline

正式 fixed-artifact comparison 使用所有 89 task，每 task至少 5 attempts。若已有同一 manifest 的
不可变 baseline 结果可复用，必须验证每个 identity field；任一差异都要重跑。

## 5. Trial semantics

一个 planned trial 由下列 tuple 唯一标识：

```text
(run, candidate hash, task handle, split, attempt, protocol hash)
```

每个 planned trial 最终必须处于：

- `PASS`：verifier primary reward 精确为 1；
- `FAIL`：reward < 1、agent error、agent timeout、缺失/损坏结果或不可验证；
- `INFRA_RETRYABLE`：只由 trusted classifier 按预注册、reward-blind signals 判定；
- `PROTOCOL_INVALID`：TCB/identity/integrity 不变量破坏，整个 affected evaluation 无效。

TB primary reward 的具体 key 在 preflight 从真实 task result 验证并冻结。Terminal-Bench adapter
只接受 finite exact `0` 或 `1`；负数、fractional、超出范围、指数溢出或非 numeric reward 均为
protocol-invalid。不得取 reward map 最大值、只取成功 trial 或对 missing trial 改分母。

Mechanism outcome 只能由 canonical paired trials 推导。每个 baseline/child arm 必须带相同的实际
`task handle + attempt index`，且每个 domain/key 恰好各有一个 baseline 和一个 child；缺失、重复、
跨 task/attempt 配对、重复 evidence ref 或任一 `INVALID` arm 均产生 `INVALID_TRIALS`。Target arm 的
task handle 还必须等于 outcome 声明的 target。配对后的完整 role/task/attempt/ref/status/reward multiset、
proposal/candidate、hypothesis digest、target cluster 与 target handle 一并进入 idempotency commitment；
输入枚举顺序不得改变 outcome bytes。

## 6. Retry policy

允许重试的例子：Harbor provider control-plane 5xx、sandbox provisioning 在 agent 启动前失败、artifact
hash 下载失败且 agent 未运行。以下不是 infrastructure retry：agent process 非零、task timeout、tool
网络失败、package download 失败、verifier assertion 或 candidate crash；这些都是 harness 在真实环境
中的表现，计 FAIL。

Classifier MUST 在 verifier reward 被读取前使用 phase timestamps/error class 判定。Normalizer
先解析异常 metadata，再独立决定 retry eligibility；allowlist 字符串本身不是授权。计划中的
candidate/task/attempt 必须与 closed-schema controller attribution 精确一致，result/trajectory/ACP 文件
必须是单一、稳定、非 symlink 的 regular file，任何 present-but-malformed、别名歧义或 identity mismatch
均优先判为 protocol/integrity failure，`retryEligible=false`。`classification` 字段存在时优先于
`type`；两个不同的已注册类别同时出现则拒绝。正常 numeric reward 与 exception metadata 同时出现视为
stale/contradictory metadata，不得 retry。`docker-build-error` 与 `network-pull-error` 只允许在 reward
和全部 agent evidence 都尚未产生时重试；`oom-crash` 可保留已验证的 partial agent evidence，但仍必须
没有 reward。

一次 allowlisted infra trial 最多重试 2 次，使用同一 idempotency lineage；所有尝试都保留。重试耗时计
wall-clock，provider 若不收费可不计 model cost，但须明确。

## 7. Search-stage evaluation

搜索只在 60 development tasks 上运行，具体 allocation 由
[`03-evolution-algorithm.md`](03-evolution-algorithm.md) 决定。

为了避免污染：

- observed task instruction/trace 可被 proposer 看到；
- guard task 只以 opaque handle 送到 Harbor；controller 获得聚合/逐 handle binary outcome 用于
  selector，但不获取 task name、instruction、verifier output 或 trace；
- evidence export 工具必须按 label 生成 manifest，不能靠调用方记得过滤；
- proposer prompt/result、tool trace 中若出现 guard/sealed token，information-flow monitor 立即
  `SAFETY_ABORTED`。

Search score 是 task-weighted mean，不按已有 trial 数简单拼接难度不同的样本；posterior 和 paired
tournament 细节见算法规范。

## 8. Candidate-lock transaction

进入 sealed evaluation 前必须原子完成：

1. Search budget 关闭，所有 pending proposal/eval terminal 或取消；
2. Archive snapshot hash、RNG counters 和 tournament receipt flush；
3. 单一 development champion 的 source/bundle/capsule hash 固定；
4. baseline capsule hash、model/protocol identity 固定；
5. sealed evaluation plan（29 tasks × `k_sealed` attempts）固定；
6. statistical analysis code/container hash 固定；
7. `candidate-lock.json` 签名/只读化；
8. controller transition 到 `CANDIDATE_LOCKED`，selector/proposer permanently disabled。

`k_sealed` 默认 5，与正式稳定性口径一致。若 Gate 5 预算只允许更少 attempts，必须在 search 前
预注册且报告低 power；不得在看见结果后增加 attempts。

## 9. Primary sealed estimand

对 sealed task `i` 和 `k` attempts：

```text
p_i(c) = passes(candidate, i) / k
p_i(b) = passes(baseline, i) / k
d_i = p_i(c) - p_i(b)
Delta = (1 / 29) * sum(d_i)
```

主 estimand 是按 task 等权的 average Pass@1 probability difference，避免更快或更多完成的 task 获得
额外权重。报告：

- `Delta` 百分点；
- candidate/baseline macro Pass@1；
- paired task-cluster bootstrap 95% percentile CI（固定 seed，至少 100,000 resamples）；
- improved/tied/regressed task counts；
- cost/token/time differences（secondary）。

Primary promotion rule：

```text
Delta >= 0.05
and CI95.lower > 0
and complete planned trials == 100%
and critical safety findings == 0
```

29 tasks 导致 +5pp 门槛可能统计 power 较弱；这是目标与数据规模的事实。点估计达标但 CI 跨 0 时
状态为 `PROMISING_NOT_CONFIRMED`，不能换统计检验直到显著。

## 10. Regression and guardrail analysis

Secondary、预注册但不替代 primary：

- development observed/guard paired delta；
- category-level sealed deltas 和 exact task table（揭盲后）；
- baseline-solved task regression rate；
- catastrophic regression：baseline `p_i >= 0.8` 且 candidate `p_i <= 0.2`；
- timeout/error/tool-loop/artifact-missing rates；
- mean/median/p95 cost、tokens、duration；
- candidate behavior invariants 与 trajectory audit findings。

任一 critical safety violation 直接拒绝。其他 regression 不另设未经 power 校准的硬阈值；完整展示，
用于后续新 run 的设计，而不是本 run 的二次适应。

## 11. Optional formal 89-task evaluation

v0.1 open-source release 不运行 full-set。只有发布后 benchmark profile 得到 sealed promotion且另行
授权官方评测预算后才进入 formal run。协议使用官方当前要求：

```text
dataset: pinned Terminal-Bench 2.1, 89 tasks
candidate: locked release capsule
attempts: >= 5 per task (445 planned trials at k=5)
environment/resources/timeouts: official task values
model route/config: exact frozen identity
```

Formal run 不再进化、路由 candidate、从中间结果改变 harness 或重试非 infra failure。报告必须区分：

- empirical mean pass rate / Pass@1；
- pass@k reach 与 pass^k consistency（若展示）；
- standard error/CI、attempt completeness；
- total/mean cost、tokens、time；
- official verified、self-reported 或 local evidence 状态。

截至设计核验时，官方 repo 表示 community submission 暂停、只接受维护方运行；因此
`FULL_SET_VERIFIED` 不等于 `LEADERBOARD_VERIFIED`。

Gate 8 acceptance 不能从 caller 提供的 hash-shaped strings、布尔值或可重算的 envelope commitment 推导。
Verifier 必须从可信 content-addressed store 读取 versioned receipt bytes，校验外部 signer/attestation，并从
journal、action store、normalized/raw trial artifacts 与 immutable launch manifests 重建 terminal、replay、
no-adaptation 和 identity facts。上述 producer/schema/authority 未实现时，public verifier 必须返回
`PROTOCOL_INVALID`；synthetic matrix/statistics consistency 只能作测试，不能成为 acceptance。

## 12. Cost and time accounting

预算 ledger 从可信 gateway/Harbor receipt 汇总，不信 candidate 自报。至少分：

- proposer model；
- solver model；
- session title/compaction/subagent 等辅助 model calls；
- search、baseline、sealed、formal phases；
- provider/sandbox compute；
- failed/retried/cancelled work；
- unpriced usage（必须显式，不能当 0）。

`$500` goal 默认涵盖 calibration 后的 proposal + development search + sealed baseline/candidate model
API cost；不涵盖独立的维护方 leaderboard rerun 时必须明确。Wall-clock 从 `SEARCHING` 到 sealed
terminal state，包含 queue/retry；preflight/calibration/formal 另列。

Meta-Harness 公开 TB2 artifact 给出的 89×2、约 4–6 小时、约 `$500/iteration` 说明旧文档的
`$0.20/candidate` 不可信。实际预算只能由本项目固定模型 baseline/pilot 外推，并保留至少 20% reserve。

## 13. Result parsing and completeness

Harbor job 顶层摘要只能作 convenience view。Normalizer MUST 遍历预注册 trial inventory，并对每个
trial 验证：

- `config.json` identity；
- per-trial `result.json` schema；
- verifier reward、agent context、timing；
- ACP summary/events、ATIF trajectory 与 DSH session event count；
- candidate capsule/protocol/task hashes；
- cost/token values 的 reconciliation；
- terminal phase and cleanup receipt。

预期 trial 缺目录或 result 时创建显式 FAIL record，不能消失。Normalizer 输出 canonical JSONL +
Merkle root；Archive 只接受该 artifact。

## 14. Reward-hacking audit sampling

自动审计覆盖 100% trials：forbidden path/network/process access、test discovery、trace deletion、score
inconsistency、suspicious task literals、process survivors、resource overrun。

人工轨迹审查至少包括：

- sealed candidate 的所有 PASS 和所有 baseline→candidate regressions；
- development champion 的随机 20% PASS/FAIL（seed 预注册）；
- 每个新 tool/workflow mechanism 至少 3 条代表轨迹；
- 所有 anomaly detector 命中。

审查者在 sealed reveal 前不能把 task detail 回馈搜索。Critical finding 使 lineage invalid。

## 15. Reports and claims

每个报告开头必须展示：

```text
candidate hash | baseline hash | DSH/Harbor/dataset digest | model route
split sizes | attempts | planned/completed trials | cost coverage
status: local / independently reproduced / official leaderboard
```

必须同时发布 point estimate、uncertainty、raw per-task table（sealed reveal 后）、failed trials、完整
manifest 和 analysis code。不得只展示 best seed、best candidate 或 best-of-k 而称 Pass@1。
