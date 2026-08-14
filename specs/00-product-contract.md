# 00 — Product and experiment contract

**Status:** normative draft  
**Owner:** `dsh-rsi` trusted control plane  
**Applies to:** every evolution run and every published claim

本文使用 MUST、MUST NOT、SHOULD、MAY 表示强制、禁止、建议和可选要求。未经新的 ADR 和
run lineage，不得在实现中弱化 MUST/MUST NOT。

## 1. Problem statement

给定一个固定的基础模型和一个以 DSH Cordis plugin/bundle 表达的 agent harness，系统应从
可验证的 Terminal-Bench 2.1 执行证据中产生候选修改，维护非贪心谱系，分配有限评测预算，
选择一个最终候选，并在此前未反馈给搜索过程的任务上验证泛化。

优化对象是**模型之外的可执行 harness**：prompt、上下文构造、工具接口与呈现、事件中间件、
工作流、恢复、验证前行为以及候选自改进过程。模型权重不变。

系统身份由以下五元组决定：

```text
(DSH source, candidate artifact, solver route, benchmark protocol, run manifest)
```

缺少任意一项都不能复现实验，也不能归因“harness 提升”。

## 2. Product thesis

### 2.1 First-principles choice

DSH 已提供 Cordis 的 plugin、service、依赖注入、可逆 effect、Fiber lifecycle、动态组合和
agent/session/tool seams。RSI 控制面和候选都应使用这些原语，而不是在外面复制 agent loop。

因此：

- `dsh-rsi` MUST 是标准 DSH bundle 中的 Cordis service。
- candidate MUST 是标准 DSH bundle/plugin，且能被真实 Cordis Loader 加载。
- DSH 上游 MUST 保持未修改；patch/fork 不属于本项目的正常实现路径。
- benchmark adapter MUST 只翻译“提交任务—读取结果”，不得拥有 Archive、选择或晋升逻辑。

### 2.2 The Bitter Lesson applied

系统优先给强模型通用、可扩展的计算与证据访问，而不是积累任务特定规则：

- 原始轨迹、diff、分数和历史候选通过文件系统按需读取，不全部压进 prompt。
- Archive 保留 stepping stones，不用单冠军 hill-climbing。
- proposal 可以使用通用代码工具、并行采样和长上下文，而不是固定 failure→rule 映射表。
- 硬规则只用于信任边界、实验有效性和资源约束；不能把人工解题技巧伪装成进化算法。

## 3. Terms that MUST remain distinct

| 术语                 | 定义                                                          | 不能被误称为          |
| -------------------- | ------------------------------------------------------------- | --------------------- |
| Candidate            | 一个不可变、内容寻址的 DSH plugin/bundle artifact             | 已接受改进            |
| Archive admission    | 候选通过结构/安全检查并进入谱系                               | 分数提升或晋升        |
| Development score    | 在 60 个开发任务上的搜索反馈                                  | held-out 泛化结果     |
| Development champion | 按预注册规则从 Archive 锁定的单一候选                         | 最终成功              |
| Sealed promotion     | 单一锁定候选通过 29 个 sealed task 的门                       | 官方 leaderboard 分数 |
| Full-set evaluation  | 89 任务、每任务至少 5 次的固定候选评测                        | 搜索证据或在线自适应  |
| SOTA                 | 同时匹配数据、模型、harness、预算和官方验证口径的当前最好结果 | 一个静态百分比        |

任何报告 MUST 同时给出候选哈希、模型 route、task digest、attempt 数、预算和证据路径。

## 4. Run tracks

同一代码支持两个清楚标注、不可混合比较的 track：

### 4.1 `self` track

- solver 和 proposer 使用相同的固定模型 route 与推理配置。
- proposer 在被选择 parent 的 candidate harness 下运行。
- 候选可改进下一代 proposal 的 harness-side 行为，因此形成递归反馈。
- 这是“模型在自身 harness 下改进自身 harness”主张所需的 track。

### 4.2 `sota` track

- solver route 固定；proposer MAY 使用另一个更强但同样固定、完整记录的 route。
- parent candidate 仍提供 proposal runtime，外部 proposer 只替换模型能力。
- 这是最高 Terminal-Bench 分数优先的工程 track。
- 结果 MUST 标为 assisted harness evolution，不能冒充同模型 self-improvement。

一次 run 只能选择一个 track，且 track MUST 在 run manifest 冻结时声明。首个正式 80-candidate
run 默认使用 `self` track：它同时支撑递归自改进主张与 benchmark 提升；`sota` track 作为独立
后续 lineage，在 `self` 结果揭盲后按剩余预算另行预注册。中途改变 route、reasoning effort、
temperature、tool transport 或 context window 会创建新 lineage，旧结果不能合并。

## 5. Frozen and evolvable surfaces

### 5.1 Frozen trusted computing base (TCB)

一个 run 内以下内容 MUST 固定且 candidate 不可写：

- DSH runtime、Cordis Loader、RSI controller、candidate SDK 和 runner；
- model adapter、provider endpoint、精确 model ID、请求默认值、凭据 broker；
- benchmark adapter、Harbor、TB 2.1 dataset digest、task split、verifier 和 scorer；
- evidence journal、预算计数器、安全 policy、artifact builder 和签名/哈希逻辑；
- sealed-result service、统计脚本和最终 candidate lock；
- OS/container policy、网络 policy、时限和资源限制。

### 5.2 Evolvable candidate surface

候选 MAY 修改其 artifact 根目录内、manifest 明确声明的：

- system-prompt sections 和 agent-scoped instructions；
- tool schema、tool presentation、candidate-owned tool 及受控 middleware；
- context selection、compression、memory 和 state-handling policy；
- agent event / session event / tool-result listeners；
- workflow、subagent orchestration、retry/recovery 和 completion policy；
- proposal mode 使用的候选侧证据阅读和自修改工作流；
- candidate-owned tests 和说明。

候选不能通过“配置”改变 5.1 中的事实。具体接口见
[`02-candidate-contract.md`](02-candidate-contract.md)。

## 6. Primary objectives and constraints

### 6.1 Search completion

完整 evolution run MUST：

1. 从一个经过 baseline 评测的 `c0000` 开始；
2. 形成恰好 80 个通过 archive-admission 的新 candidate artifact；
3. 在任何受控中断后可恢复，且不重复计费或重复计入 trial；
4. 在预注册的美元、wall-clock、trial、token 和并发上限内结束；
5. 在预算耗尽时保留完整证据并 fail closed，而不是篡改门槛。

Proposal/build 失败也 MUST 记录，但不计为 80 个 admitted candidates。

### 6.2 Generalization success

在 development champion 哈希锁定后，可信评测器对 baseline 与该 candidate 在 29 个 sealed
tasks 上进行配对评测。成功需要同时满足：

```text
delta_sealed = mean_task(candidate pass rate - baseline pass rate) >= 0.05
paired 95% cluster-bootstrap CI lower bound > 0
critical safety violations = 0
protocol completeness = 100%
```

若只有点估计达到 +5pp 而区间跨 0，报告为 `PROMISING_NOT_CONFIRMED`，不得称成功。

### 6.3 Efficiency objective

性能是首要目标；成本和时延是约束与 Pareto 维度，而不是用任意权重抵消正确率：

- evolution-through-sealed-promotion 的目标模型 API 成本 ≤ USD 500；
- 目标 wall-clock ≤ 16 小时；
- 正式 public leaderboard 运行若由维护方单独执行，成本 MUST 单列，不能隐藏在目标外。

Gate 5 baseline calibration 若证明保留最终评测预算后不可能达到约束，run MUST 在付费搜索前
停止并标记 `CALIBRATION_INFEASIBLE`。不得缩小 sealed 或正式 attempt 数后保留原声明。

### 6.4 SOTA objective

Stretch goal 是在**相同模型与官方协议**下达到当前官方最佳 harness，随后争取全榜最佳。
run 启动时必须把官方 leaderboard snapshot URL、抓取时间和目标行写入 manifest。文档中不得把
`83.8%` 或任何移动数字写成永久 SOTA。

## 7. Experimental invariants

以下不变量在每个候选 trial 前后都 MUST 可机器验证：

```text
model(candidate)       == model(baseline)
model_params(candidate)== model_params(baseline)
task_digest(candidate) == frozen_task_digest
verifier(candidate)    == frozen_verifier
resource(candidate)    == frozen_resource_policy
only_changed_files     subset_of candidate_editable_roots
sealed_feedback_seen   == false until candidate_lock
```

候选增加的 token、tool call、subagent 或时延属于 harness 行为，必须计费，不能通过统一补偿隐藏。

## 8. Lifecycle and terminal states

一个 run 只能沿以下阶段前进：

```text
DRAFT -> PREFLIGHT -> CALIBRATED -> SEARCHING -> CANDIDATE_LOCKED
      -> SEALED_EVALUATED -> PROMOTED | REJECTED -> FULL_EVALUATED -> RELEASED
```

允许的提前终止状态：

- `PREFLIGHT_FAILED`
- `CALIBRATION_INFEASIBLE`
- `BUDGET_EXHAUSTED`
- `SAFETY_ABORTED`
- `EVIDENCE_CORRUPT`
- `PROTOCOL_INVALID`
- `OPERATOR_STOPPED`

终止状态不可通过编辑状态文件恢复为成功；修复后应从最后一个有效 checkpoint 创建 successor run。

## 9. Non-goals

第一版明确不做：

- 修改模型权重、训练 adapter 或把 benchmark 轨迹用于 fine-tuning；
- 让 candidate 修改 RSI controller、selector、budget 或 verifier；
- 在线部署时无门槛地自更新生产 harness；
- 用 LLM judge 替代 TB verifier；
- 为所有 benchmark 创建通用平台后才验证 TB 2.1；
- 用 Kubernetes、消息队列、向量数据库或独立 web control plane 解决尚未出现的问题；
- 把 public benchmark 上的提升外推成通用软件工程能力。

## 10. Claim vocabulary

对外状态 MUST 使用以下之一：

| 状态                      | 最低证据                                |
| ------------------------- | --------------------------------------- |
| `SPECIFICATION_ONLY`      | 只有文档                                |
| `ENGINEERING_VALIDATED`   | unit + Loader E2E + crash replay        |
| `ADAPTER_VALIDATED`       | 真实 Harbor smoke + 原始 trial artifact |
| `BASELINE_ESTABLISHED`    | 固定 manifest 下的完整 baseline         |
| `SEARCH_COMPLETE`         | 80 admitted candidates + 完整预算/谱系  |
| `PROMISING_NOT_CONFIRMED` | sealed 点估计达标但统计门未过           |
| `SEALED_PROMOTED`         | 6.2 全部门通过                          |
| `FULL_SET_VERIFIED`       | 固定 candidate 的 89×≥5 完整评测        |
| `LEADERBOARD_VERIFIED`    | 官方维护方接受/展示的行                 |

“零 reward hacking”只能写为“在预注册控制和审计中未检测到 reward hacking”，见安全规范。

## 11. Product definition of done

项目 MVP 只有在以下条件全部有 artifact 时完成：

- `dsh-rsi` 和 candidate 都由真实 DSH Loader 加载，无上游 patch；
- 80 个 admitted candidates 的 run 可在故障注入后逐事件重放得到同一 Archive；
- baseline、development、sealed 和 full-set 结果物理/逻辑隔离且标签完整；
- 单一锁定 candidate 通过 6.2；
- 静态、运行时、轨迹和 verifier-integrity 审计均无 critical finding；
- 成本与 wall-clock 在声明范围内，或明确标记未达成；
- 所有公开数字可追到 immutable Harbor trial、candidate hash 和 run manifest。
