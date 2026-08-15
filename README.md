# dsh-self-evolving

`dsh-self-evolving` 是一个以 DeepSeek Harness（DSH）插件为唯一运行时核心、以
Terminal-Bench 2.1 为首个验证环境的递归自改进（RSI）项目。

当前开发版本为 **v0.2.0**。产品名、npm scope、CLI、Cordis service、协议/MIME 和发布身份统一为
`dsh-self-evolving`。v0.1/v0.1.1 的历史审计保留旧名称和旧绝对路径，以维持既有证据真实性；迁移说明见
[`docs/migration-v0.2.md`](docs/migration-v0.2.md)。

项目当前状态为 **`OPEN_SOURCE_V0_2_RELEASE_CANDIDATE`**。Gate 0–7 的 Loader、candidate builder、
Harbor ACP、durable controller、真实 DeepSeek 官方 Responses proposer、K=3 稳定迭代、低消耗固定回放
effectiveness gate 与 Apache-2.0 source release 已有验收证据。尚无 Terminal-Bench 提分、sealed
promotion、leaderboard 或 SOTA 结论。

v0.1.1 的 bounded multi-file successor 已通过 fresh real K=3、真实 Harbor candidate trials、注入式
crash/resume 和独立审计，状态为 **`AUTONOMOUS_PLUGIN_DEVELOPMENT_VERIFIED`**。该能力声明仅证明系统能稳定
迭代受限的多文件 DSH 插件；不声明 Terminal-Bench 提分、sealed promotion、leaderboard 或 SOTA。

## 一句话架构

可信的 `dsh-self-evolving` Cordis service 在 DSH 内维护证据、谱系和搜索状态；它生成的每个候选
harness 仍是标准 DSH bundle/plugin，并在独立的一次性 DSH 进程中运行；Terminal-Bench
通过 Harbor 适配器评测候选，verifier、数据切分和最终测试始终位于候选不可写的可信边界。

这不是 DSH 的 fork，也不是套在 DSH 外面的第二套 agent controller。DSH 上游保持只读；
Harbor 是可替换 benchmark provider，而不是 RSI 的所有者。

## 文档阅读顺序

| 顺序 | 文档                                                                 | 回答的问题                                   |
| ---- | -------------------------------------------------------------------- | -------------------------------------------- |
| 1    | [`specs/00-product-contract.md`](specs/00-product-contract.md)       | 成功、失败和非目标分别是什么？               |
| 2    | [`specs/01-architecture.md`](specs/01-architecture.md)               | 为什么采用 DSH 插件 + 隔离评测进程？         |
| 3    | [`specs/02-candidate-contract.md`](specs/02-candidate-contract.md)   | 候选能改什么、如何装载和回滚？               |
| 4    | [`specs/03-evolution-algorithm.md`](specs/03-evolution-algorithm.md) | Archive、CMP、Thompson 和 UCB-Air 如何组合？ |
| 5    | [`specs/04-evaluation-protocol.md`](specs/04-evaluation-protocol.md) | 如何避免 held-out 泄漏并形成可信结论？       |
| 6    | [`specs/05-safety.md`](specs/05-safety.md)                           | 信任边界、reward hacking 和供应链如何防护？  |
| 7    | [`specs/06-evidence-state.md`](specs/06-evidence-state.md)           | 如何持久化、恢复、审计和精确计费？           |
| 8    | [`specs/07-implementation-plan.md`](specs/07-implementation-plan.md) | 按什么验收门实现和运行？                     |

辅助材料：

- [`docs/dsh-integration.md`](docs/dsh-integration.md)：经当前源码核对的 DSH API 和 Loader 约束。
- [`docs/terminal-bench-2.1-runbook.md`](docs/terminal-bench-2.1-runbook.md)：Harbor/TB 2.1
  接入、校准、正式评测与结果解析。
- [`docs/research-basis.md`](docs/research-basis.md)：论文/项目依据、采用方式和已纠正的旧结论。
- [`docs/decisions.md`](docs/decisions.md)：关键架构决策记录（ADR）。
- [`docs/phase-todolist.md`](docs/phase-todolist.md)：按 Gate 0–8 展开的落地执行清单。
- [`docs/v0.1-release-gates.md`](docs/v0.1-release-gates.md)：已验收 predecessor 的短版 Gate 定义。
- [`docs/v0.2-release-gates.md`](docs/v0.2-release-gates.md)：名称/provider/effectiveness successor 的验收定义。
- [`docs/migration-v0.2.md`](docs/migration-v0.2.md)：v0.2 名称、包、CLI、协议和 state 迁移边界。
- [`PROJECT_STATUS.md`](PROJECT_STATUS.md)：当前真实进度与最近一个验收门。

当文档冲突时，优先级为：冻结的 run manifest > `specs/` > `docs/` > README >
历史讨论。代码接口若与固定版本的上游源码不符，必须停止并更新兼容性记录，不能静默猜测。

## v0.1 完成目标

- 从一条真实失败证据出发，连续生成、构建、装载并评测 3 个 unique candidates，且至少形成两层
  lineage；不要求候选得分高于 baseline。
- 真实运行中注入一次 crash，恢复后 proposal/evaluation/cost/Archive 均 exactly-once，journal replay
  与最终 state hash 一致。
- 默认最多运行 12 个 baseline failure-discovery trials 和 3 个 candidate trials；模型保持
  `high + 1M context + 32k output ceiling`，不通过截断 token 降耗。
- fresh profile 可从 source archive 安装并运行同一 demo；发布物包含文档、测试、SBOM、provenance、
  checksums 和回滚说明。v0.1 不发布独立 npm package，避免把 workspace/link 依赖误称为可安装包。
- 搜索阶段不得修改 DSH 上游、benchmark、verifier、模型路由、计分器、切分或安全策略。

## 发布后可选目标

Terminal-Bench K=10/K=80 搜索、29-task sealed confirmation、89×≥5 full-set 和 leaderboard submission
属于持续提分 profile，不阻塞 v0.1 开源发布。启用时仍必须遵守 split、预算、统计和 claim boundary，
工程稳定不等于 benchmark 提升。

## 安装与运行

完整步骤见 [`docs/quickstart.md`](docs/quickstart.md)。最短命令面：

```bash
pnpm setup:source
pnpm dsh-self-evolving init --run-id demo-1 --state-dir /var/lib/dsh-self-evolving-controller/demo-1 --repo-root "$PWD"
pnpm dsh-self-evolving doctor --state-dir /var/lib/dsh-self-evolving-controller/demo-1
pnpm dsh-self-evolving run --state-dir /var/lib/dsh-self-evolving-controller/demo-1
```

配置、恢复和证据解释分别见 [`docs/configuration.md`](docs/configuration.md)、
[`docs/troubleshooting.md`](docs/troubleshooting.md) 和 [`docs/evidence-guide.md`](docs/evidence-guide.md)。
备份、恢复、回滚和卸载见 [`docs/operations.md`](docs/operations.md)。

默认 provider 只读取可信宿主进程中的 `DEEPSEEK_API_KEY`，固定使用 DeepSeek 官方
`https://api.deepseek.com/v1` Responses 路由、`deepseek-v4-flash`、high、1M context 和 `store=false`。
不会读取 Codex 的 `auth.json`/`config.toml`，也不再默认经过 CPA。

## 当前固定版本快照

设计核验使用以下本地快照；实现开始时必须重新生成 `provenance.lock.json`，不得仅依赖此表：

| 组件                               | 快照                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------- |
| DeepSeek Harness                   | `47f943859bef60e4160492346772ded9b24f765a`                                |
| Harbor                             | `ac398bbda7c4c1073461797d3b95c2455cc671b5`                                |
| Terminal-Bench 2.1 dataset repo    | `7131e4375048a0e408a8fb404b5f499d726b695b`                                |
| TB 2.1 Harbor dataset digest       | `sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a` |
| DSH theory paper `/root/paper.pdf` | `sha256:4d48478dc0b6222d9f74d7db10ee776449b1209eb112632336544d32a49db97f` |

这些是设计时证据，不是永久依赖范围。任何升级都必须新开 run lineage，并重跑兼容性和 baseline。
