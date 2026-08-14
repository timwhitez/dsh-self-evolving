# Implementation phase todolist

**Status:** execution checklist derived from `specs/07-implementation-plan.md`  
**Rule:** 逐项勾选必须有对应 artifact/测试证据；勾选不产生任何规范效力，验收以 spec 07 各 Gate 为准。
上一 Gate 的 Accept 项未全部有证据前，不开始下一 Phase 的付费/全量工作。

## Phase 0 — Provenance 与 Cordis lifecycle 地基（Gate 0，1–2 天）

- [x] 初始化项目 Git scope；`deepseek-harness/`、`harbor/`、`tb/` 保持外部 pinned checkout，不纳入可编辑范围
- [x] 建立 root workspace：pnpm + strict TypeScript + lint/format/test + JSON Schema 工具链
- [x] 生成机器可读 `provenance.lock.json`（DSH/Harbor/TB commit、paper hash、Node/pnpm、container、model catalog）
- [x] 创建最小 `@dsh-rsi/candidate-baseline` bundle（namespace-form exports）与真实 `cordis.yml` fixture
- [x] 实现无模型 Loader E2E：boot → service/tool/listener inventory → unload → quiescence 精确一致
- [x] negative fixture：加 `export default apply` 后测试必须失败（证明能捕获 Loader unwrap 缺陷）
- [x] CI 骨架：format/lint/typecheck/unit/Loader E2E/upstream-clean/AGENTS-CLAUDE 字节一致

**退出证据**：Loader E2E 通过记录 + negative fixture 失败记录 + 可机器验证的 provenance lock。

> **已完成（2026-08-14）**：commit `3799fa5`。证据：`pnpm provenance:check`、
> `pnpm upstream:check`、`pnpm byteequal:check`、`pnpm test`（7 单元）、
> `pnpm test:e2e`（3 真实 Loader 测试，含 negative）全绿。详见 `PROJECT_STATUS.md`。

## Phase 1 — Candidate SDK 与 trusted builder（Gate 1，3–5 天）

- [x] `schemas/`：candidate/proposal/build/capsule manifest 的 versioned JSON Schema
- [x] canonical tar + SHA-256 身份（排序、固定 mode/mtime、拒绝 symlink/traversal/大小超限）
- [x] diff boundary 校验 + dependency/import allowlist + task-fingerprint/secret scan（AST + module graph）
- [x] `packages/candidate-sdk/`：类型、validator、testkit；两模式（solve/propose）baseline candidate
- [x] deterministic builder sandbox：无网络、禁 lifecycle scripts、double build hash 一致、SBOM
- [x] evaluation capsule：runtime closure + compiled bundle + runner + provenance + SHA256SUMS
- [x] packed capsule 在无 source、无网络的 fresh container 中完成 DSH ACP initialize/session
- [x] 全套拒绝 fixtures：traversal/symlink/install-script/dynamic-import/task-literal/default-export/leaked-effect

**退出证据**：golden candidate 双次 clean build 三 hash 相同；全部拒绝 fixture 生效。

> **已完成（2026-08-14）**：`packages/candidate-sdk/` + 4 个 JSON Schema。证据：
> golden build 三 hash 一致（`builder-golden.test.ts`，2 绿）；canonical tar/identity 10 绿；
> policy scanner 19 绿（含 15 reject fixture）；manifest validation 7 绿；rejection suite 9 绿
> （dynamic-import/default-export/task-literal/external-import/child-process/secret/symlink/install-script）；
> packed capsule 离线 boot 真实 Loader（`capsule-offline-boot.e2e.ts`，1 绿）。共 50 SDK 单元 + 4 E2E（Phase 1 范围）。
>
> **Successor（2026-08-14）**：旧的 Loader-only / source-symlink capsule 证据已被独立审计判为不足。
> successor 物化 pinned runtime closure，生成 SPDX 与可逐文件验证的完整性记录，并从 packed bytes
> 在独立 network namespace 及 `FROM scratch`、只读、无网络 Docker 容器中完成真实 ACP
> initialize/session/prompt。证据见 `docs/audits/2026-08-14-gate1-successor.md`。

## Phase 2 — Terminal-Bench provider 垂直切片（Gate 2，3–5 天）

- [x] `benchmark-adapters/terminal-bench/`：TypeScript provider 生成 Harbor job config + inline ACP binary registry entry（HTTPS + SHA-256）
- [x] immutable artifact endpoint（或 provider 支持的等价物）；capsule 根部 `dsh-rsi-acp` wrapper 用绝对路径解析自身 config
- [x] 真实 Harbor job 跑通 `extract-elf`：nop/broken/golden 三种 fixture 分别得到预期 fail/fail/valid
- [x] per-trial normalizer：以 planned inventory 为分母；缺 `result.json`/reward/trajectory/hash 显式 FAIL，不消失
- [x] ACP/ATIF/DSH session/cost reconciliation；raw job + normalized artifact 可从零重解析出同一 hash
- [x] 同 idempotency key 重复 submit 不产生第二个付费 trial
- [x] shared/separate verifier-mode compatibility probe（只记录，不擅改正式 task contract）

**退出证据**：真实 DSH candidate 经 Harbor ACP 完成一次 task，stdout 协议纯净，归一化结果 hash 可复现。

> **已完成（2026-08-14）**：`benchmark-adapters/terminal-bench/` provider（registry entry / job config /
> normalizer / idempotency / cost reconcile）。证据：真实 Harbor job（docker build → agent → verifier →
> reward）三 fixture 通过 TS adapter normalizer（`harbor-smoke.e2e.ts`，golden→1.0 PASS、nop→0.0 FAIL、
> broken→0.0 FAIL，3 绿）；adapter 单元 22 绿。注：smoke 用脚本解（oracle/nop agent）而非付费模型，
> 验证 verifier pipeline 与 normalizer，未声称 benchmark capability。
>
> **successor 验收（2026-08-14）**：packed baseline capsule（含 root ACP launcher、bundled Node、
> immutable HTTPS archive + sha256）经 Harbor generic ACP agent 完成真实 initialize/prompt/verifier；
> Harbor 原生写出 trajectory/events/summary，normalizer 强制消费并得到可复现、可归因的
> `reward=0` 有效失败。证据：`harbor-acp-candidate.e2e.ts` 1 绿；不构成 capability 声明。

## Phase 3 — 持久化 controller 核心（Gate 3，5–8 天）

- [x] `packages/dsh-rsi/`：DSH bundle + 单一 `ctx.rsi` Cordis service，`ctx.effect` 全量 disposer
- [x] content-addressed object store（staging → fsync → hash → no-clobber publish；scrub）
- [x] hash-chain JSONL journal + 单 writer lock + HEAD 原子更新
- [x] pure state reducer + snapshot；full replay 与 snapshot resume 的 canonical state hash 一致
- [x] action saga（PLANNED→…→COMMITTED）+ 确定性 idempotency keys + provider reconcile
- [x] budget double-entry ledger（reserve→spent/released；unpriced usage 显式；最坏上界防超卖）
- [x] fault-injection harness：在每个 intent/launch/collect/commit 边界 kill 后 resume，不重复外部 effect/score/cost
- [x] event completion order permutation 测试：同 wave 任意完成顺序得到相同 state hash
- [x] corrupt journal/object/snapshot 的 fail-closed 测试；read-only status command

**退出证据**：crash/replay 全套通过；controller unload 后无残留 worker/handle。

> **successor 验收（2026-08-14）**：`@dsh-rsi/core` 已成为 namespace-form DSH bundle，并由
> Cordis lifecycle 持有唯一 `ctx.rsi` service、atomic writer lock、journal flush 和 provider saga。
> 4 个真实 Node controller 在 intent/launch/collect/commit 后分别遭 `SIGKILL`，恢复后均只有一次
> external launch、observation、cost settlement 和 commit；stale owner identity 被核验并保留证据。
> 另有只读 status CLI、并发写/预算不超卖、64 组生成序列 property、unload 无 handle 验收。

## Phase 4 — Agentic proposal 垂直切片（Gate 4，4–7 天）

- [x] proposal sandbox：filesystem/network/model gateway policy（parent/evidence 只读，仅 child root 可写）
- [x] parent candidate 以 `propose` mode 经真实 Loader 装载，proposer 用 `ctx.agents.create({ setup })`
- [x] label-filtered evidence export（manifest + Merkle root + guard/sealed canary absence receipt）
- [x] archive catalog 导出：统计只从 `DEV_OBSERVED` 派生，无 guard/sealed 衍生数字
- [x] proposal 输出协议：width=3、hypothesis 去重、donor provenance、no-change/test-only 拒绝
- [x] builder handoff + rejected proposal 证据保留
- [x] 安全测试：proposer 读不到 controller/canary/credentials/sibling；trace prompt-injection fixture 不能改变 policy

**退出证据**：baseline parent 从两条 synthetic failure trace 生成 ≥1 个 nontrivial admitted child，preservation tests 通过，transcript/cost 完整。

> **已完成（2026-08-14）**：`packages/dsh-rsi-proposer/` proposal runner。证据：真实 `deepseek-v4-flash` 模型经真实 DSH Loader
> （`ctx.agents.create` + `agent-spine-demo` + `llm-deepseek` → verified provider）从 baseline parent + 2 条 synthetic DEV_OBSERVED
> failure trace 生成 ≥1 个 nontrivial admitted child（含 hypothesis / production diff / mechanism+preservation tests），
> `real-model-propose.e2e.ts` 绿。parse+protocol 8 绿；prompt-injection 安全 5 绿（policy 纯函数不被注入改变；
> canary leak 检出；model firewall 拒 route override）。注：archive catalog 导出（统计只从 DEV_OBSERVED 派生）
> 随 Gate 5 搜索/统计层实现；evidence export 的 label 过滤已就位。
>
> **successor 历史工程进展（已由下述 Zen 验收取代）**：catalog 对 GUARDED/SEALED observation 满足逐字节
> 非干扰；raw object export 固定为 PUBLIC_SPEC+DEV_OBSERVED、action-scoped、只读且 label/media
> 与 digest 不可变。Bubblewrap E2E 强制只读 inputs、唯一 child write root、空 credential 环境、
> 独立 PID/network namespace、timeout drain 与 symlink 拒绝，并接到 sandbox 的 brokered Unix
> gateway。
> Unix gateway 与 `ProposalGatewayAdapter` 现已通过 4 个 E2E：networkless sandbox 可达固定 socket、
> 同 request 只调用 provider 一次、route override/额外 headers 在 provider 前拒绝、sandbox 无 key。
> model-free 集成 E2E 使 immutable runtime 内的真实 agent-spine、baseline propose candidate、
> session loop、GatewayAdapter 与 parser 在 Bubblewrap 内生成 1 个 admitted child；当时尚缺的真实
> provider 同拓扑复验已由下述 Zen successor 完成。
>
> **Zen compatible successor（已验收）**：从 root-only Codex auth store 仅向可信宿主注入
> credential；冻结 requested Zen / effective Flash / high / 1,048,576 context。项目绕过 CPA 有缺陷的
> Responses 合成层，直接使用 compatible Chat Completions 与单轮 32,768 output budget；同一
> networkless Bubblewrap + fixed gateway 拓扑生成 1 个 admitted child。CPA 未修改，reasoning/模型正文
> 未持久化。旧 free route 的 429 审计保留为 predecessor。

## Phase 5 — 产品化迭代闭环（Gate 5，1–3 天）

- [x] 搜索、split/sealed、bootstrap、durable controller 的核心模块与测试已存在
- [ ] 将真实 proposer → candidate builder → Loader → Harbor evaluator → Archive 接到统一 CLI
- [ ] 实现 `init/run/resume/status/audit/doctor` 和 versioned config
- [ ] 默认 profile 固定为 `K=3`、development-only、sealedAccessCount=0、solver trial 上限 15
- [ ] 付费 launch 前检查 credential、Docker、Harbor、task materialization、预算和 writable state
- [ ] 同 idempotency key / crash resume 不重复 proposal、trial、score 或 cost

**退出证据**：单命令真实完成一次 propose/build/evaluate/commit，重启后 status/replay 一致。

## Phase 6 — 稳定 K=3 迭代证明（Gate 6，1–2 天 + runtime）

- [ ] fresh run ID；baseline failure discovery 分批运行，最多 12 个 observed tasks
- [ ] 在 candidate reward 前冻结 failure pool 与每个 candidate 的 task draw
- [ ] 无人工干预产生 3 个 unique admitted candidates，lineage depth ≥2
- [ ] 每个 candidate 只评测 1 个 frozen baseline-failed task；不要求分数提升
- [ ] 真实 external effect 后注入一次 crash，resume 后 exactly-once 且 state hash/replay 一致
- [ ] proposer 引用历史 raw evidence；全部 raw/normalized/usage/cost refs 完整
- [ ] sealedAccessCount 始终为 0；终态为 `STABLE_ITERATION_VERIFIED`

**停止条件**：12 个 baseline tasks 均通过时标记 `NO_REAL_FAILURE_SIGNAL`，不按候选结果动态换题。

## Phase 7 — 开源 v0.1 release candidate（Gate 7，1–2 天）

- [ ] README/quickstart/config/troubleshooting/architecture/evidence interpretation 与当前实现一致
- [ ] 用户确认 OSI license；补齐 CONTRIBUTING、SECURITY、code of conduct、CHANGELOG
- [ ] fresh-profile 安装后运行真实 Loader 与 K=3 demo smoke
- [ ] 生成 source/package、SBOM、provenance、checksums、dependency/license scan、secret/leak scan
- [ ] full unit/E2E/typecheck/lint/format/provenance/upstream-clean/UTF-8 全绿
- [ ] 实测 uninstall/rollback 与一次 state backup/restore
- [ ] 发布审计只声明 `OPEN_SOURCE_V0_1_RELEASE_CANDIDATE`，不声明 benchmark 提升

## Phase 8 — 发布后持续提分 profiles（可选，不阻塞 v0.1）

- [ ] `pilot`：K=10 sampled development run
- [ ] `search`：K=80 signed formal development run
- [ ] `sealed`：唯一 champion 的 29×k paired confirmation + frozen bootstrap
- [ ] `official`：仅 sealed promotion 后运行 89×≥5 或 maintainer submission
- [ ] 每个 profile 使用 fresh lineage；sealed 结果不得反馈给同一 run selector/proposer

未运行时统一报告 `BENCHMARK_PROFILES_NOT_RUN`，不是 v0.1 工程发布失败。

## 跨阶段持续项

- [ ] 每个 Phase 结束更新 `PROJECT_STATUS.md`，只报告有 artifact 支持的状态
- [ ] 任何 TCB/协议/split/metric 变更走 ADR + protocol version bump（spec 07 §13）
- [ ] 凭据永不进入 candidate/config/log/evidence；每次 export 附 canary absence receipt
- [ ] CI 全绿是合入条件；nightly Harbor smoke、weekly provenance refresh report 不自动改 pin
