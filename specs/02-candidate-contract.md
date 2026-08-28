# 02 — Candidate plugin and artifact contract

**Status:** normative draft  
**Applies to:** every generated, hand-authored, baseline and released candidate

## 1. Candidate identity

Candidate 是不可变 source artifact，不是一个可被覆盖的目录名。规范身份为：

```text
candidate_id = "c_" + base32(sha256(canonical_source_tar))[0:26]
```

可读序号（如 `c0017`）只用于 UI。Archive、评测、缓存和报告 MUST 使用完整 SHA-256。

Canonical source tar MUST：

- 路径按 UTF-8 byte order 排序；
- 固定 mode、uid/gid、mtime 和 tar format；
- 只包含 manifest 声明的 source/test/config 文件；
- 排除 `node_modules`、build output、logs、secrets、VCS metadata 和临时文件；
- 拒绝 symlink、hardlink、device、绝对路径、`..`、大小写/Unicode 归一化冲突；
- 在 hash 前验证单文件、总文件数和总字节上限。

同一 canonical source 必须得到同一 ID；重复 proposal 复用已有节点并记录 duplicate edge，不新建候选。

## 2. Source tree

每个 candidate source MUST 具有以下最小形态：

```text
candidate/
├── candidate.json          # schema-versioned behavior/provenance manifest
├── package.json            # DSH bundle package; exact dependencies
├── cordis.patch.yml        # inserts the candidate row
├── src/
│   └── index.ts            # namespace-form Cordis plugin entry
└── tests/
    └── candidate.spec.ts   # candidate-owned unit/regression tests
```

MAY 增加 `src/components/**`、fixtures 和 `README.md`，但第一版限制为：最多 25 个文件、1 MiB
canonical source、5,000 changed lines 相对 canonical parent。该上限是安全/成本边界，不是“越小越好”
的评分规则；超过需在新 run manifest 预注册，不能由 proposer 自行豁免。

## 3. DSH bundle shape

`package.json` MUST 声明 DSH bundle，而不是 profile：

```json
{
  "name": "@dsh-self-evolving/candidate-<short-hash>",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "files": ["lib", "candidate.json", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

实际 hash 在 trusted builder 中物化；proposer 输出不得自行选择 package identity。

`cordis.patch.yml` MUST 只插入固定 ID 的 candidate row：

```yaml
- insert:
    - id: self-evolving-candidate
      name: '@dsh-self-evolving/candidate-<short-hash>'
```

稳定 runner 在更晚的 patch layer 中重述该 row 的完整 config，传入 `mode` 和 immutable candidate
identity。由于 Loader 的 config patch 是整值替换，runner MUST 每次重述所有必需字段。

Candidate bundle MUST NOT：

- 声明 profile、覆盖 `dsh-base`/runner 的既有 row ID 或插入 Host/Web/LLM adapter；
- 使用 `!!js` 读取环境变量、process、文件或 credential；
- 插入 candidate source root 之外的绝对/相对 module path；
- 依赖 install/prepare/postinstall 脚本；
- 包含 prebuilt native binary、WASM 或 opaque archive。

## 4. Loader entry contract

入口使用 namespace-form named exports，MUST NOT 同时提供 default export。当前 DSH Loader 对
`default` 的 unwrap 会丢弃同级 `inject`/`Config`/`name`，手工 `ctx.plugin()` 测试无法发现该问题。

```ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'self-evolving-candidate'
export const inject = ['systemPrompt', 'tools']

export interface Config {
  candidateId: string
  mode: 'solve' | 'propose'
}

export const Config: z<Config> = z.object({
  candidateId: z.string().required(),
  mode: z.union(['solve', 'propose'] as const).required(),
})

export function apply(ctx: Context, config: Config): void {
  // Register candidate behavior only through declared DSH surfaces.
}
```

示例只表示 export 形态。实际候选可使用多个组件，但所有 effect 必须由 candidate Fiber 所有：

- listener 使用 `ctx.on`；
- tool/prompt/service registration 通过其 Cordis service API；
- 外部资源使用 `ctx.effect` 返回/生成 disposer；
- 不允许 detached promise、裸 `setInterval`、全局 singleton 或 process handler；
- required service 放入 `inject`，不能用轮询等待；optional service 只能通过批准的 `ctx.get()`。

真实 Loader boot/unload 是 admission gate；手工 import 和 `ctx.plugin()` 只算 unit test。

## 5. Runtime modes

同一 artifact MUST 支持两个模式，并由 TCB config 选择：

### 5.1 `solve`

候选扩展 TB task-solving agent。它只收到普通 task instruction、agent workspace 和 DSH tool
results。它看不到 search metadata、candidate scores、split label、verifier source 或 controller。

### 5.2 `propose`

候选扩展用于生成下一代的 DSH proposer agent。它收到 parent source、filtered development
evidence、archive catalog 和 child output root。这样候选对 context/tool/workflow 的改进可以影响
下一代 proposal，形成真实 harness-level recursion。

模式差异 MUST 是通用行为分支；candidate 不得在 `solve` 中按 task ID/字符串路由，也不得在
`propose` 中改变 TCB 的 proposal output validator。

## 6. `candidate.json`

Manifest 由 proposer 起草、builder 补全、schema validator 冻结。最小字段：

```json
{
  "schemaVersion": 1,
  "canonicalParent": "sha256:<parent>",
  "donorCandidates": [],
  "proposal": {
    "hypothesis": "A falsifiable mechanism-level hypothesis",
    "evidenceRefs": ["evidence://..."],
    "targetFailureModes": ["artifact-finalization"],
    "expectedBehaviorChange": "...",
    "regressionRisks": ["extra tool call on already solved tasks"],
    "touchedSurfaces": ["system-prompt", "tools-result-middleware"]
  },
  "runtime": {
    "requiredServices": ["systemPrompt", "tools"],
    "optionalServices": [],
    "newToolNames": [],
    "supportsModes": ["solve", "propose"]
  },
  "tests": {
    "mechanismAssertions": ["..."],
    "preservationAssertions": ["..."]
  }
}
```

Builder 追加以下不可由 proposer 决定的字段到 `build-manifest.json`，而不是信任其原值：

- candidate/source/bundle/capsule hashes；
- parent diff hash、file list 和 line counts；
- compiler/runtime/dependency/SBOM fingerprints；
- scan、unit、Loader、unload 和 mock-replay receipts；
- builder image digest 和 build timestamp；
- signer/attestation（若部署启用）。

自然语言 hypothesis 用于审计和证据路由；score 只来自外部 verifier。

## 7. Allowed DSH surfaces

默认 allowlist 允许候选使用以下能力，精确 package/export 随固定 DSH snapshot 生成：

| Surface                 | Typical use                                    | Constraint                                   |
| ----------------------- | ---------------------------------------------- | -------------------------------------------- |
| `systemPrompt`          | stable sections, task-independent policy       | section name prefixed `candidate:`           |
| `tools`                 | candidate-owned tool, presentation/restriction | no verifier/controller tool; unique name     |
| `agent/*` events        | pre-step, request recovery, stopping policy    | bounded work; preserve `next()` semantics    |
| `session/event`         | observe durable lifecycle                      | no rewriting existing history                |
| `tools/result`          | recovery/context middleware                    | result content size cap; no reward inference |
| `agents`/subagent seams | general delegation/workflow                    | depth/concurrency enforced externally        |
| candidate-local memory  | bounded state for one session                  | no cross-trial hidden state                  |

禁止 surface：

- `dynamicCordisRunner`、plugin Loader/HMR、`appExit`、process lifecycle；
- raw `llm` adapter/request client、credential/auth services；
- RSI/controller、budget、evidence writer、benchmark/sealed services；
- host webserver/API gateway、Docker/socket/runtime manager；
- session persistence mutation outside current agent's ordinary API；
- arbitrary subprocess/fs/network service used by plugin code itself。

Agent 调用受 TCB 提供的 bash/fs/web tools 是正常 harness 行为；candidate plugin 直接用 Node
`child_process`、`fs`、`net`、`http` 绕过 agent audit path 则被拒绝。

## 8. Import and dependency policy

AST + resolved module graph MUST enforce：

- only exact pinned `@deepseek-ai/*` packages in the run allowlist；
- candidate SDK 和 candidate 内相对 imports；
- no `node:*` imports except a tiny pre-registered pure utility list（默认空）；
- no dynamic `import()`、`require`、eval、`Function`、VM、native addon 或 path traversal；
- no unpinned semver、git/url/file dependency 或 lockfile change；
- no module whose license、install behavior 或 transitive graph 未在 TCB allowlist。

这不是完整恶意代码证明。它降低攻击面；真正机密和 verifier 仍必须在进程外。

## 9. Task-agnostic policy

候选的目标是通用 harness mechanism，而不是 TB answer cache。Static/semantic audit MUST flag：

- TB task name、dataset repo path、verifier/test filename；
- 与 task instruction/test 显著重合的长字符串、hash、expected output 或 magic constant；
- task classifier 后分派专用 solution；
- 根据 reward、split、candidate ID 或 trial index 改变 solve behavior；
- 禁用/绕过 verification、谎报完成、删除 trace 或操控计时/成本。

对命中项默认拒绝。误报只能由 trusted human security review 在 search 开始前更新 allowlist；run
中不得按候选 score 豁免。由于 TB 2.1 是公开数据，审计只能提供程序性防护，不能证明模型先验
完全无污染；报告 MUST 保留该限制。

## 10. Proposal contract

每个 expansion reservation 启动一个 proposer sandbox。输入是 capabilities，不是 controller path：

```text
/input/parent/                  read-only parent source
/input/archive/catalog.jsonl   candidate metadata; statistics derived from DEV_OBSERVED only
/input/evidence/               DEV_OBSERVED only; guarded by manifest
/input/contracts/              candidate schema and selected DSH docs
/work/children/<proposal-id>/  only writable output
```

catalog 中任何逐候选统计（s/f、pass rate、cost）MUST 只从 `DEV_OBSERVED` trial 派生；
guard/sealed 的 identity、结果和含 guard 的聚合数字都不得出现。selector 内部使用的
observed+guard posterior 不导出到 proposer 视图。

Proposer SHOULD 通过 `rg`、manifest 和按需文件读取探索历史；prompt 只含目录索引、目标和预算，
不内联所有轨迹。它最多输出 `proposalWidth`（默认 3）个独立 child，每个必须：

- 从 canonical parent 的完整拷贝开始；
- 只实现一个主 hypothesis，可含为它必需的协同改动；
- 提供机制测试和 preservation test；
- 写完整 manifest，引用实际 evidence；
- 不读取其他 proposer 并发输出。

Archive catalog 允许 proposer 借鉴其他 clade 的机制；child 仍只有一个 canonical parent，其他来源
记为 donor。这样保留树形 CMP，又获得 experience-level crossover。

## 11. Build and admission pipeline

Trusted builder 按顺序执行；任一步失败即停止后续 paid evaluation：

1. **Containment**：验证 output root、文件类型/大小、canonical tar。
2. **Schema**：验证 candidate/proposal manifest 和 parent identity。
3. **Diff boundary**：只允许 candidate source；生成 semantic diff。
4. **Policy scan**：imports、dependencies、secrets、task fingerprints、危险 API。
5. **Reproducible build**：锁定 Node/pnpm/TypeScript，网络关闭，拒绝 lifecycle scripts。
6. **Type/lint/unit**：candidate SDK contract、candidate-owned tests、TCB contract tests。
7. **Real Loader boot**：通过实际 `cordis.yml`/bundle layer 加载 named exports。
8. **Unload invariant**：dispose candidate Fiber 后 service/tool/listener/timer/handle inventory 回到基线。
9. **Mock agent replay**：固定 replay LLM 下验证两个 mode、tool schema、event ordering 和 bounded exit。
10. **Capsule build**：生成 immutable tar/SBOM/attestation，双构建 hash 必须一致。

只有 1–10 全部通过的 candidate 才进入 Archive，状态为 `ADMITTED_UNEVALUATED`。Admission 表示
“安全可运行”，不表示 performance acceptance。

Loader admission 必须同时保留两类证据：隔离的一次性 solve/propose candidate-mode probe，以及对最终
packed production overlay 的真实启动。后者必须验证 `runner/cordis.patch.yml` 与 launcher 实际读取的
`runtime/cordis.yml` 字节相同，并在断网、清空环境的隔离进程中完成真实 ACP initialize/session；手工重建
等价 plugin composition 不能替代该证据。启动完成信号必须由候选加载前生成的随机 challenge 绑定，候选
写入同一诊断通道的提前/重复信号必须 fail closed；ACP stdout 必须在读取前接受总字节上限、严格 UTF-8、
逐行 JSON 和 JSON-RPC envelope 校验。

## 12. Evaluation capsule

Capsule MUST 自包含且不可变：

```text
capsule/
├── runtime/                 # pinned DSH production closure or verified install manifest
├── candidate/               # compiled bundle
├── runner/                  # stable ACP application + final overlay
├── provenance.json
├── sbom.spdx.json
└── SHA256SUMS
```

Harbor adapter 在 task environment 上传 capsule；解包前验证 hash/paths，解包后再次验证。运行用户对
runtime 和 candidate code 只读，对 task workspace 可按 benchmark policy 写。每个 trial 创建全新
session/persistence root；跨 trial cache 只能是只读、candidate-independent 的依赖缓存。

同一协议内只能有一个用于 controller、runner overlay、capsule manifest 与 evaluator attribution 的
canonical candidate identity。v0.1.1 使用 admission 的 `sha256:<source digest>`；Candidate SDK 构建产生的
`c_<base32>` identity 必须作为 `candidate.buildCandidateId` 写入 capsule，并在 admission receipt 中显式
交叉绑定。resume/audit 遇到缺失或互相矛盾的 identity 必须 fail closed，不得把旧 alias 静默迁移为新 ID。

## 13. Runtime limits

TCB 外部强制而非只写进 prompt：

- task timeout/resource/network 取 TB 2.1 manifest，不由 candidate 覆盖；
- LLM gateway 锁 exact model route/parameters，并按 trial/candidate/run 计费；
- tool/subagent/concurrency/output size 受 runner policy 上限；
- process tree 在 trial 结束时统一回收；
- stdout 协议纯净，诊断只到 stderr/structured log；
- missing final ACP settlement、trajectory 或 cost receipt 使 trial 不完整并 fail closed。

Candidate 自己施加更早停止或更少工具属于被评测行为；它不能扩大上限。

## 14. Candidate state model

```text
PROPOSED
  -> REJECTED_CONTAINMENT | REJECTED_POLICY | REJECTED_BUILD | REJECTED_LOADER
  -> ADMITTED_UNEVALUATED
  -> EVALUATING
  -> ARCHIVED
  -> SHORTLISTED
  -> DEVELOPMENT_CHAMPION
  -> SEALED_PROMOTED | SEALED_REJECTED
  -> FULL_SET_VERIFIED
```

`QUARANTINED` 和 `INVALIDATED` 可从任意 post-admission 状态进入；它们不删除 artifact，只阻止新
action。发现 TCB 漏洞时，受影响 lineage 的所有 descendant 一并 invalidated。

## 15. Release artifact

最终发布对象是普通 DSH bundle tarball + immutable provenance，不包含 controller 或 benchmark：

- built JS、patch、candidate/build manifest、SBOM、license；
- DSH compatibility range 和精确验证 commit；
- solver model(s) 和已验证 score 的明确限制；
- install/dump-config/Loader smoke instructions；
- known limitations、safety audit 和 rollback bundle hash。

发布前必须从 tarball 在全新 profile 中安装并运行真实 Loader E2E。source checkout 成功不能替代
packed artifact 验证。
