# dsh-self-evolving agent instructions

## Mission

在不修改 `deepseek-harness/` 上游的前提下，把递归自改进实现为标准 DSH Cordis
bundle/service；候选 harness 也必须是标准 DSH bundle/plugin。首个 benchmark 是
Terminal-Bench 2.1，目标是形成可持续、可恢复、可审计且不会污染 sealed test 的完整闭环。

当前仓库首先是规范项目。没有 baseline、真实闭环和 sealed 结果前，不得声称已提升、可部署、
无 reward hacking 或达到 SOTA。

## Non-negotiable rules

1. `deepseek-harness/`、`harbor/`、`tb/` 是参考上游，默认只读；需要上游改动时先停止并写 ADR。
2. RSI、Archive、选择、proposal、预算、晋升和 benchmark provider 只用 TypeScript 实现，并由
   DSH plugin/service 承载。优先复用 Harbor 通用 ACP runner，不自写 Python agent bridge。
3. 候选只能修改其声明的 candidate package；model adapter、verifier、dataset、split、scorer、
   controller、budget 和 safety policy 属于 TCB，候选不可写。
4. 候选不得装入长期运行的 controller 进程。每个候选在一次性隔离进程/容器中通过真实 Cordis
   Loader 启动；`node:vm` 和 `ctx.dynamicCordisRunner` 不是安全边界。
5. Development 反馈可以驱动搜索；29 个 sealed task 的名称、逐题结果、轨迹和聚合分数在候选
   哈希冻结前都不得进入 proposer、selector 或 archive。最终揭盲只能发生一次。
6. Archive admission、development champion、sealed promotion、full-set leaderboard 是四种不同
   状态。任何中间绿灯都不能替代后续门。
7. 缺失、损坏、超时或不可归因结果默认记失败；只有预先登记且与 reward 无关的 infrastructure
   分类可以重试。不得丢弃失败 trial。
8. 所有外部版本、模型路由、参数、任务集合、随机种子、预算和 artifact 必须内容寻址并写入
   run manifest。凭据不能进入候选、日志、prompt 或 evidence。
9. `$500`、16 小时、+5pp 和 SOTA 都是验收目标。baseline 校准证明不可行时应 fail closed，
   不能静默缩小正式协议后仍宣称达标。
10. 开始实现前按顺序阅读 `specs/00` 至 `specs/07`；接口以固定版本源码为准，不复制一份易漂移
    的“完整 API 清单”。

## Project shape

预期实现边界：

```text
packages/dsh-self-evolving/              # 可信 Cordis controller/service
packages/candidate-sdk/        # 受限、可演化的 DSH plugin surface
packages/tb-agent/             # 稳定的 DSH ACP/headless runner
benchmark-adapters/terminal-bench/  # TypeScript Harbor provider；不含 RSI 策略
schemas/                       # manifest/event/evidence JSON Schema
evidence/                      # 运行产物；append-only + content-addressed
specs/                         # 规范唯一真源
docs/                          # 接口依据、ADR、runbook
```

不要预先创建没有验收消费者的 service、数据库、队列或语言边界。文件系统是证据真源；派生索引
可重建，不能成为唯一状态。

## Required workflow

1. 先读取 `PROJECT_STATUS.md`、相关 spec、上游实际 API 和当前 diff。
2. 把改动绑定到一个明确验收门；先写/更新契约测试，再写最小生产实现。
3. 对 DSH plugin 同时跑 unit test 和真实 Loader E2E；手工 `ctx.plugin()` 不能替代 Loader 测试。
4. 对状态机做 crash/replay 测试；对 adapter 做真实 `extract-elf` smoke；对正式结论保留 Harbor
   原始 job 和逐 trial 证据。
5. 更新 `PROJECT_STATUS.md`，只报告已有 artifact 支持的状态。

## Authoritative details

- 产品与范围：`specs/00-product-contract.md`
- 架构：`specs/01-architecture.md`
- 候选接口：`specs/02-candidate-contract.md`
- 算法：`specs/03-evolution-algorithm.md`
- 评测与统计：`specs/04-evaluation-protocol.md`
- 安全：`specs/05-safety.md`
- 状态与证据：`specs/06-evidence-state.md`
- 实施门：`specs/07-implementation-plan.md`
