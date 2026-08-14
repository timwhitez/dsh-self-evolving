# Project status

**状态：GATE 0 COMPLETE — Awaiting Gate 1**  
**更新时间：2026-08-14（Asia/Tokyo）**

## 已完成 — Gate 0（provenance 与 Cordis lifecycle 地基）

artifact-backed，可机器验证，无付费 benchmark 运行。

### Provenance

- `provenance.lock.json` 固定 DSH `47f943859bef60e4160492346772ded9b24f765a`、Harbor
  `ac398bbda7c4c1073461797d3b95c2455cc671b5`、Terminal-Bench
  `d28711d0da2675d0bb1d56de45ae5df6082438a3`、paper sha256
  `4d48478d…49db97f`、Node `v22.23.1`、pnpm `11.7.0`、6 个 `@deepseek-ai/*` 包版本。
- `scripts/check-provenance.ts` 校验：每个 upstream 在 pinned commit、working tree clean、
  toolchain 版本、package 版本、paper hash 全部一致。**当前全绿**。

### 候选 bundle

- `packages/candidate-baseline/`：稳定 baseline parent candidate。namespace-form
  （`name`/`inject`/`Config`/`apply`），无 `export default`（符合 postmortem 0001）。
  双模式 `solve`/`propose`，仅注册单个稳定 prompt section，无 tool/timer/listener/外部资源。
- `candidate.json`、`cordis.patch.yml` 符合 spec 02 §2–§6 最小形态。

### 真实 Loader E2E

- `packages/dsh-rsi-loader-e2e/`：通过真实 `@deepseek-ai/cordis-plugin-loader` + Include/Group
  builtin 启动 `cordis.yml` fixture（非手工 `ctx.plugin()`）。
- `loader-lifecycle.e2e.ts`：boot → 候选 row 激活 → systemPrompt 服务可用 → prompt section
  已渲染 → 全树 unload → loader entries 归零 → 无 leak handle 超出 baseline。**2 测试绿**。
- `negative-default-export.e2e.ts`：故意加 `export default apply` 的 broken candidate，
  真实 Loader 以 `cannot get property "systemPrompt" without inject` 拒绝。证明测试能捕获
  default-unwrap inject-drop 缺陷（postmortem 0001）。**1 测试绿**。

### CI 骨架

- `format:check`、`lint`、`typecheck`、`test`（7 单元）、`test:e2e`（3 Loader E2E）、
  `provenance:check`、`upstream:check`、`byteequal:check` 全绿。
- `.github/workflows/gate0.yml` 定义 fast-ci + loader-e2e 两个 job。
- 三上游 working tree clean；`AGENTS.md` 与 `CLAUDE.md` 字节一致。

## 尚未完成（后续 Gate）

- Gate 1：candidate SDK、deterministic builder、canonical tar/hash、diff/import/secret scan、
  rejection fixture 全套、packed capsule offline boot。
- Gate 2+：Harbor ACP smoke、durable controller、proposal sandbox、search/split/sealed、
  calibration、pilot、formal 80-candidate、sealed/full evaluation。

因此当前不能声称：闭环可端到端运行、分数提升、满足 `$500`/16 小时、零 reward hacking、
可提交 leaderboard 或达到 SOTA。

## 下一个验收门

执行 `specs/07-implementation-plan.md` 的 Gate 1（candidate SDK 与 trusted builder）。
逐项执行清单见 `docs/phase-todolist.md`。
