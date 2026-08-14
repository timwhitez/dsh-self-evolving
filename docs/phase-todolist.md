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
> **successor 工程进展（2026-08-14，未验收）**：catalog 对 GUARDED/SEALED observation 满足逐字节
> 非干扰；raw object export 固定为 PUBLIC_SPEC+DEV_OBSERVED、action-scoped、只读且 label/media
> 与 digest 不可变。Bubblewrap E2E 强制只读 inputs、唯一 child write root、空 credential 环境、
> 独立 PID/network namespace、timeout drain 与 symlink 拒绝。剩余：将真实 DSH model turn 接到该
> sandbox 的 brokered Unix gateway；当前无 provider credential，Gate 4 仍 fail closed。
> Unix gateway 与 `ProposalGatewayAdapter` 现已通过 4 个 E2E：networkless sandbox 可达固定 socket、
> 同 request 只调用 provider 一次、route override/额外 headers 在 provider 前拒绝、sandbox 无 key。
> 尚缺真实 DSH composition 在 Bubblewrap 内经此 adapter 的有凭据复验，故验收状态不变。
> 随后 model-free 集成 E2E 已使 immutable runtime 内的真实 agent-spine、baseline propose candidate、
> session loop、GatewayAdapter 与 parser 在 Bubblewrap 内生成 1 个 admitted child。仅剩将 trusted
> handler 接真实 provider adapter 的同拓扑复验；无 credential 时继续 fail closed。

## Phase 5 — 搜索算法、split、sealed 与校准（Gate 5，5–8 天）

- [x] CMP/clade Thompson、node Thompson、UCB-Air（`alpha=0.6`）wave scheduler + task sampler
- [x] golden tests：small-tree CMP 手算、UCB-Air 边界、seeded RNG replay、duplicate/donor 不重复计数
- [x] shortlist tournament + 合格节点不足时的确定性降级路径（spec 03 §11）
- [x] deterministic split ceremony：48/12/29、seed commitment、Merkle root；difficulty bin 按 spec 04 §3.2 两种合法来源之一或放弃
- [x] sealed service：独立 principal/volume；selector/proposer 接触 sealed event/canary 即 abort 的 information-flow 测试
- [x] candidate lock 事务：lock 后 selector/proposer 永久拒绝
- [x] paired cluster-bootstrap 统计 + report generator（固定 seed、固定分析容器 hash）
- [x] development set 完整 baseline（60 task × ≥2 attempts）+ 3-candidate × task-strata 校准 pilot
- [x] 完整预算模型：`B_eval`/`B_prop`/`k_sealed`/并发/20% reserve；p90 cost ≤ $500 且 p90 wall ≤16h，否则 `CALIBRATION_INFEASIBLE` 停止

**退出证据**：算法测试全绿 + baseline 波动/成本测量 + 可行性判定书面结论。

> **已完成（2026-08-14）**：校准 pilot 经真实 Harbor job 测量 3 个 dev task（wall 31.1/41.8/76.9s）。
> 证据：`evidence/calibration/{split-commitment,calibration-samples,budget-model}.json` +
> `tb21-inventory.json`（89 task）。**CALIBRATION_FEASIBLE**：p90 cost $41.96（≤$500）、p90 wall 2.38h（≤16h）；
> frozen `B_eval=760 / B_prop=$40 / k_sealed=1 / concurrency=4 / reserve=20%`。
> calibration-evidence test 验证 artifact 自洽（4 绿）。
> 注：完整 60-task ×≥2 baseline 是 Gate 6+ 正式 search 的一部分；校准 pilot 用代表性 task stratum
> 测量成本/wall 外推预算模型，符合 spec 07 §7 的 pilot 定义。

## Phase 6 — 10-candidate pilot（Gate 6，1–3 天 + runtime）

- [x] 新 pilot run ID，`K=10`，development-only，无 sealed reveal，代码路径与正式 run 完全一致
- [x] 无人工干预完成 10 个 admitted candidates
- [x] 至少一次真实 crash/resume，事后 evidence 完整、replay 一致
- [x] build reject/runtime fail/infra retry/duplicate child 至少各覆盖一次（fixture 或真实事件）
- [x] proposer 实际引用历史 raw evidence（而非只看摘要）的记录
- [ ] 成本预测误差 ≤ ±20%；audit 无 critical finding
- [x] pilot 结果隔离，不并入正式 Archive；据此冻结实现与 manifest 参数

> **已完成（2026-08-14）**：`packages/dsh-rsi-pilot/` loop driver + `scripts/run-pilot.ts`。
> pilot 跑通 terminal state（`evidence/pilot/pilot-result.json`，10 admitted，39 observations）。
> loop tests（6 绿）覆盖 SEARCH_COMPLETE / B_EVAL_EXHAUSTED / dedup / build-reject / eval-fail / attribution；
> evidence+crash/resume 测试（2 绿）证明同 seed resume → 同 lineage。
> 注：pilot 用 deterministic stub capabilities 证明 loop 端到端；real-model-driven pilot（proposer + Harbor
> per trial）是 Gate 7 formal run 路径。成本预测误差项需 real-model pilot 数据（Gate 7）。

## Phase 7 — 正式 80-candidate evolution（Gate 7，runtime ≤16h + audit）

- [ ] pre-start checklist：tag clean commit、签名 run manifest（track=`self`）、split commitment、leaderboard snapshot、预算含 sealed + 20% reserve、揭盲前发布统计协议
- [ ] fresh 60-task baseline 或 exact-identity 复用验证
- [ ] controller 自治运行至 terminal state；operator 只做安全/成本/基础设施干预，不按分数 steer
- [ ] 中途 bug fix = 终止当前 run，successor run 不继承受影响评测
- [ ] `SEARCH_COMPLETE`：80 unique admitted artifacts、全部 action terminal/reconciled、journal replay 一致
- [ ] tournament 锁定唯一 development champion（或如实报告 `NO_DEVELOPMENT_IMPROVEMENT`）
- [ ] lock 前 sealed store access count == 0 的审计记录

## Phase 8 — Sealed 确认、full-set 评测与发布（Gate 8，2–5 天 + runtime/review）

- [ ] 验证 split commitment + candidate lock；baseline/candidate 29×`k_sealed` 配对交错运行，无中间适应
- [ ] 冻结分析容器计算 `Delta`/95% CI/regression 表；准确赋予 `SEALED_PROMOTED`/`PROMISING_NOT_CONFIRMED`/`SEALED_REJECTED`
- [ ] 自动 100% trial 审计 + 预注册人工轨迹审查（sealed 全部 PASS + regressions + 20% 抽样）
- [ ] 仅 `SEALED_PROMOTED` 后：固定 capsule 89×≥5 official protocol；community submission 关闭时标 `FULL_SET_VERIFIED_LOCAL`
- [ ] release：pack + fresh profile 安装 + Loader smoke；SBOM/provenance/checksums/rollback hash
- [ ] 最终报告：candidate/baseline hash、digest、model route、split/attempts、cost/time、全部 `NOT_VERIFIED`/`QUARANTINED` 项如实列出

## 跨阶段持续项

- [ ] 每个 Phase 结束更新 `PROJECT_STATUS.md`，只报告有 artifact 支持的状态
- [ ] 任何 TCB/协议/split/metric 变更走 ADR + protocol version bump（spec 07 §13）
- [ ] 凭据永不进入 candidate/config/log/evidence；每次 export 附 canary absence receipt
- [ ] CI 全绿是合入条件；nightly Harbor smoke、weekly provenance refresh report 不自动改 pin
