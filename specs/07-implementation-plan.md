# 07 — Implementation and acceptance plan

**Status:** normative execution plan  
**Rule:** no paid/full-scale work before the previous gate has artifacts

## 1. Delivery strategy

项目按垂直闭环验收，不按“先写完所有 services 再集成”。每个 gate 都必须产生：实现、自动测试、
真实 runtime evidence、已知限制和 `PROJECT_STATUS.md` 更新。文档 checkbox 不是完成证据。

估时按一名熟悉 TypeScript/DSH/Harbor 的工程师给出，包含测试和修复，不包含云队列等待：

| Gate | Outcome                                   |                        Estimate |
| ---- | ----------------------------------------- | ------------------------------: |
| 0    | pinned provenance + real Loader lifecycle |                        1–2 days |
| 1    | candidate contract + reproducible capsule |                        3–5 days |
| 2    | Harbor ACP smoke + trusted normalization  |                        3–5 days |
| 3    | journal/reducer/archive/budget crash-safe |                        5–8 days |
| 4    | proposal sandbox + one child end-to-end   |                        4–7 days |
| 5    | algorithm + split/sealed + calibration    |                        5–8 days |
| 6    | 10-candidate pilot                        |           1–3 days plus runtime |
| 7    | 80-candidate formal search                | runtime target ≤16 h plus audit |
| 8    | sealed/full evaluation + release          |    2–5 days plus runtime/review |

首个可信 80-iteration 结果约 4–7 周，而不是旧文档中未经 integration evidence 的固定 Week 5。

## 2. Gate 0 — Provenance and Cordis lifecycle spike

### Build

- 初始化当前目录为项目 Git scope（若用户授权），将三个上游作为 external pinned checkouts，而非嵌套
  可编辑代码；
- 定义 root workspace、strict TypeScript、formatter/lint/test 和 schema toolchain；
- 生成 `provenance.lock.json`：DSH/Harbor/TB source、paper、Node/pnpm/Python、container、model catalog；
- 创建最小 `@dsh-rsi/candidate-baseline` bundle 和真实 `cordis.yml` fixture；
- 实现无模型 Loader boot → service/tool/listener inventory → unload → quiescence check。

### Accept

- baseline namespace plugin 通过真实 Loader，不能只有手工 `ctx.plugin()`；
- 故意加 `export default apply` 的 negative fixture 必须失败，证明测试能捕获 Loader unwrap；
- unload 后 inventory 与 boot 前精确一致，无 process/timer/open handle；
- upstream working trees clean；provenance 可机器验证。

### Stop if

当前 DSH API 与 spec 不符，先更新 `docs/dsh-integration.md`/ADR；不得用 `any`/mock 绕过。

## 3. Gate 1 — Candidate SDK and builder

### Build

- versioned JSON schemas：candidate/proposal/build/capsule manifests；
- canonical tar/hash、diff boundary、dependency/import/task-fingerprint scan；
- candidate SDK types/testkit，two-mode baseline candidate；
- deterministic builder sandbox、double build、SBOM、capsule launcher；
- packed bundle install + real Loader + mock replay E2E。

### Accept

- golden candidate 两次 clean build 的 source/bundle/capsule hash 相同；
- traversal/symlink/install-script/dynamic-import/task-literal/default-export/leaked-effect fixtures 全拒；
- packed capsule 在无 source checkout/无 network 的 fresh container 启动 DSH ACP initialize/session；
- builder 不执行 candidate lifecycle script，不访问 model/verifier。

## 4. Gate 2 — Terminal-Bench provider vertical slice

### Build

- TypeScript provider 生成 Harbor job config 和 inline ACP binary registry entry（HTTPS + SHA-256）；
- immutable artifact endpoint 或 provider-supported equivalent；
- `extract-elf` task 的真实 Harbor job；
- per-trial normalizer、planned inventory、ACP/ATIF/DSH/cost reconciliation；
- shared/separate verifier compatibility probe，不私自更改正式 task contract。

### Accept

- Nop/broken/golden fixture 能分别产生 expected fail/fail/valid result；
- 缺失 `result.json`、reward、trajectory、candidate hash 都显式 FAIL/invalid，不从分母消失；
- 真实 DSH candidate 通过 ACP client 完成一次 task，stdout protocol clean；
- adapter 重复 submit 同 idempotency key 不产生第二个付费 trial；
- raw Harbor job + normalized artifact 可从零重新解析成同 hash。

## 5. Gate 3 — Durable controller core

### Build

- `@dsh-rsi/core` bundle/service、config schema、single writer；
- object store、hash-chain journal、pure reducer、snapshot；
- candidate/archive/observation state、budget double-entry ledger；
- provider saga/idempotency/reconcile 和 read-only status command；
- fault-injection harness。

### Accept

- property tests 覆盖 arbitrary valid event sequences；
- 每个 intent/launch/collect/commit 边界 kill 后 resume，不重复 external effect/score/cost；
- event completion order permutation 在同 wave 得到相同 state hash；
- corrupt journal/object/snapshot fail closed；
- controller unload flush 后无 worker/process handle。

## 6. Gate 4 — Agentic proposal vertical slice

### Build

- proposal sandbox filesystem/network/model gateway policy；
- parent candidate `propose` mode through real DSH Loader；
- label-filtered evidence export/catalog，raw historical files on demand；
- proposal output protocol、width/diversity/dedup/donor provenance；
- builder handoff 和 rejected proposal evidence。

### Accept

- baseline parent 从两条 synthetic failure traces 生成至少一个 nontrivial admitted child；
- proposer 无法读取 controller、guard/sealed canary、credentials 或 sibling output；
- trace prompt injection fixture 不能改变 writable root/manifest policy；
- child 在 mock task 上行为符合 hypothesis，parent preservation tests 通过；
- proposal transcript/tool use/token/cost/source refs 完整。

## 7. Gate 5 — Search, split, sealed, and calibration

### Build

- CMP/Thompson/UCB-Air wave scheduler、task sampler、shortlist tournament；
- deterministic split ceremony、labels/export firewall、sealed service/candidate lock；
- paired bootstrap/statistics/report generator；
- full baseline on development set；
- representative 3-candidate × task-strata calibration pilot。

### Accept

- algorithm golden/property/RNG replay tests 全通过；
- selector/proposer 接触 sealed event/canary 会 abort；
- candidate lock 后任何 selector/proposer call 被永久拒；
- baseline 重复波动、cost/time/token 估计和 provider concurrency 已测量；
- `B_eval`/`B_prop`/k/worker/reserve 的完整预算模型证明目标可行。

若预计 p90 cost > `$500` 或 p90 wall time >16 h，状态 `CALIBRATION_INFEASIBLE`。可选择更便宜固定
模型/更高合法并发/更高预算后新 run，但不能在原目标下直接开始 80 candidates。

## 8. Gate 6 — Ten-candidate pilot

使用新的 pilot run ID，`K=10`、相同代码路径、development-only，无 sealed reveal。

### Accept

- 无人工干预完成 10 admitted candidates；
- 至少一次真实 crash/resume，最终 evidence 完整；
- build reject、runtime fail、infra retry、duplicate child 均至少通过 fixture 或真实事件覆盖；
- Archive/CMP/wave/budget 与独立 replay report 一致；
- proposer 能引用历史 raw evidence，而非只看最近 summary；
- audit 没有 critical finding，成本预测误差在预注册容限内（建议 ±20%）。

Pilot 结果不能与 formal run Archive 合并；它只用于修复/冻结实现。

## 9. Gate 7 — Formal 80-candidate evolution

### Pre-start checklist

1. tag/commit clean implementation；
2. freeze signed run manifest/provenance/split commitment/leaderboard snapshot；
3. fresh 60-task baseline or exact-identity reusable artifact；
4. budget reservations include sealed baseline/candidate and 20% reserve；
5. no unreviewed source/config change；
6. operator stop/incident/secret rotation/backup procedures tested；
7. publish hypothesis/primary metric/statistical protocol before reveal。

### Runtime policy

- controller autonomous until terminal state；status/metrics read-only；
- operator may stop for safety/cost/infrastructure but不得按分数 steer parent/proposal；
- bug fix terminates current formal run；successor run 不继承受影响评测；
- 60 秒内可获得 progress，而不改变 scheduler；
- completion 必须是 80 unique admitted candidate objects，不是 loop counter。

### Accept search

- `SEARCH_COMPLETE` + 80 candidates；
- all planned actions terminal/reconciled；
- budget/usage/objects/journal/replay/audit complete；
- tournament 锁定一个 development champion 或明确 no-improvement；
- 在 lock 之前 sealed store access count=0。

## 10. Gate 8 — Sealed confirmation, full evaluation, release

### Sealed

- verify split commitment and candidate lock；
- baseline/candidate paired 29×k run without intermediate adaptation；
- run frozen analysis container；
- complete automatic/human audit；
- assign exact promotion state, including CI uncertainty。

### Full set

Only after `SEALED_PROMOTED`：run fixed capsule on 89×≥5 official protocol，公开完整 raw/normalized
evidence。Community submission unavailable时标 `FULL_SET_VERIFIED_LOCAL`，等待 maintainer run。

### Release

- pack/install fresh profile test；
- source/bundle/capsule/SBOM/provenance/checksums；
- baseline/candidate/per-task/statistics/cost/time/safety reports；
- compatibility/limitations/rollback；
- no secrets/guard-before-reveal/private provider logs in public export。

## 11. Test matrix

| Layer                     | Fast CI                     | Integration                      | Paid/slow            |
| ------------------------- | --------------------------- | -------------------------------- | -------------------- |
| Schemas/reducer/algorithm | unit/property/golden        | crash subprocess                 | none                 |
| Candidate                 | AST/type/unit               | real Loader + packed capsule     | replay model         |
| ACP/provider              | config/normalizer fixtures  | local Harbor `extract-elf`       | real solver smoke    |
| Safety                    | static/canary/path fixtures | sandbox escape/permission probes | audit sample         |
| Evaluation                | synthetic paired data       | mini job completeness            | baseline/sealed/full |

任何 paid test 都应先有 replay/mock twin。Mock green 只证明工程 contract，不证明 benchmark capability。

## 12. CI gates

每个 PR 最少：

```text
format/lint/typecheck
schema compatibility
unit + property tests
real Cordis Loader E2E
packed capsule offline boot
journal crash/replay suite
normalizer fixture suite
security policy fixtures
docs links + AGENTS/CLAUDE byte equality
upstream worktrees unchanged
```

Nightly 执行 container/sandbox/Harbor smoke；weekly 执行 dependency/SBOM/provenance refresh report，但不
自动改变 formal run pins。

## 13. Change control

改以下任何项需要 ADR + protocol version bump：candidate editable surface、TCB trust boundary、split sizes/
labels、primary metric/promotion gate、missing/retry semantics、CMP/UCB-Air formula、model route、task digest、
verifier mode 或 budget scope。

实现细节可在同 protocol version 内修改，但若可能影响 candidate behavior、score 或 evidence，需要新
baseline/new run。Docs 不能 retroactively 改释义让已有结果合规。

## 14. First concrete implementation action

先完成 Gate 0 的最小 Loader fixture：baseline namespace plugin、bundle patch、真实 boot/unload inventory
test 和 negative default-export fixture。它是后续 candidate/codegen/benchmark 的共同地基。
