# 05 — Safety, security, and reward-integrity specification

**Status:** normative draft  
**Threat model:** proposer-generated candidate code is untrusted

## 1. Safety objective

安全目标不是声称“模型不会作弊”，而是在候选可能主动或偶然利用基础设施时，仍保证：

- candidate 无法读取/修改 reward source、sealed information、controller 或 credentials；
- candidate 不能绕过资源、成本、模型或工具 policy；
- 所有行为可归因到 immutable artifact 和 trial；
- compromise/异常局限于一次性 sandbox；
- 证据缺失或不一致时不会晋升；
- 已发布 candidate 可回滚到已知 baseline。

## 2. Assets

必须保护的资产按优先级：

1. verifier/test source、reward output 和 scorer；
2. sealed split mapping、task identity、trajectory 和 aggregate result；
3. model/API/cloud credentials 与 billing authority；
4. controller code、state journal、budget、selector/RNG 和 candidate lock；
5. DSH/Harbor/dataset/runtime provenance；
6. evidence completeness、trajectory 和 cost records；
7. host、Docker/cloud control plane 和其他 trial；
8. public result 的因果有效性与用户声誉。

## 3. Adversaries and failure modes

- Candidate source 直接使用 dangerous API、供应链脚本或 dependency escape。
- Solver 从 public task name/known tests 硬编码答案或 task-specific route。
- Proposer 通过 prompt injection in trace 读取秘密、污染 evidence 或修改 TCB。
- Candidate 修改/删除 trace、伪造 final answer、cost 或 timeout。
- Candidate 访问 verifier files、Docker socket、host mount、network metadata/credentials。
- Selector 利用 sealed/guard identity、异步完成顺序或 missing trials 形成偏差。
- Operator 为高分 candidate 临时放宽扫描、重试或 timeout。
- 上游 mutable version/外部资源漂移导致错误归因。
- Crash/restart 重复付费、重复记成功或使用半写状态。

## 4. Trust domains

| Domain                        | Trusted for                    | Not trusted for                              |
| ----------------------------- | ------------------------------ | -------------------------------------------- |
| RSI controller                | policy, scheduling, journal    | candidate behavior, verifier result          |
| Proposer model/runtime        | proposing source               | compliance, score, secrets                   |
| Candidate plugin/process      | task/proposal execution        | any TCB fact                                 |
| Builder                       | deterministic validation/build | benchmark reward                             |
| Harbor orchestrator           | task lifecycle/artifacts       | candidate-generated self-report              |
| Task environment              | task workspace execution       | keeping verifier secret in shared mode       |
| Separate verifier environment | official scoring               | search policy                                |
| Sealed service                | concealment/reveal             | candidate selection after reveal             |
| Model/compute providers       | contracted execution           | local evidence availability without receipts |

Cordis Fiber/`node:vm` 只属于 candidate process 内 lifecycle domain，不跨 trust boundary。

## 5. Filesystem isolation

### 5.1 Controller

- 以独立 OS user 运行，唯一 writer lock；
- candidate/eval workers 无 controller UID、socket、cwd 或 evidence-write mount；
- secrets 仅通过 brokered environment/FD 注入需要的 trusted process；
- journal/artifact root 使用 restrictive permissions、hash chain 和定期只读 snapshot；
- 不把 API key 放进 run manifest、candidate capsule 或 command line。

### 5.2 Proposal sandbox

- parent/contracts/evidence 只读，child root 唯一可写；
- 每次 proposal 启动先进入独立 delegated cgroup v2 domain，再继续执行 untrusted worker；memory/swap、
  CPU rate/time、PID、block I/O、file-size/open-file 与 writable bytes/inodes 必须使用版本化固定上限；
- 非 root launcher 必须由可信 service manager 先放入 delegated root 下的 executor child；每个资源域
  是其 sibling，确保 launcher 只在已委派的公共祖先内迁移进程，不能依赖对 host cgroup root 的写权限；
- writable root、`/tmp` 与 `/dev/shm` 必须是 size/inode-bounded tmpfs。需要预置 child tree 时由可信
  supervisor 从只读 seed 复制；target 启动前移除全部 capabilities，退出后先杀净 PID namespace 再导出；
- sandbox root 与 `/dev` 只读；可信 supervisor 完成 mount 后必须禁用其 private user namespace 下继续
  创建 nested user namespace，target 不得通过新 user/mount namespace 重新获得 mount capability；
- untrusted target 必须在 supervisor 下级的独立 PID namespace 中启动，只能看到自身及其后代；即使宿主
  user namespace 只能映射一个 UID，也不能观察、发信号给 supervisor 或访问其 control FD；
- 缺少可委派 controller、配额设置失败、收据控制通道异常或资源超限一律 fail closed；不得退回只有
  wall timeout 的执行路径；
- 成功不得通过 `cgroup.kill` 合成：target 必须零退出，trusted supervisor 必须先完成最终 storage sample
  并写出完整 control receipt；admission/resume/audit 必须按冻结 policy、mount、peak、event、exit/signal
  逐字段验证，不能只验证 receipt digest；
- no host home、SSH agent、cloud metadata、Docker socket、controller IPC；
- network 默认仅允许 fixed LLM gateway 和 approved package mirror；build phase no network；
- trace 文件视为不可信数据，工具输出不能改变 system policy；
- output exporter follow-no-symlink，并在 sandbox 外重新 canonicalize。
- proposal resource receipt 必须独立持久化，其 digest 必须进入 materialization receipt；cache/audit 缺失
  任一侧或语义不一致时不得采用既有 proposal。
- sandbox 导出的 child/worker output 本身不是完成标记；resource/gateway/diagnostic/worker bytes 必须先进入
  fsync + manifest-last 的 execution bundle。无 commit marker 的 residue 要隔离后从 immutable parent 重建，
  provider 请求仅能经 durable idempotency record 重放；cache/audit 还必须读回 materialization CAS 原文。
- provider idempotency reservation 必须在任何付费 dispatch 前 fsync file 与 parent directory；完成记录使用
  fsynced temp + atomic rename + directory fsync。bundle manifest 同样先完整 fsync staging，再 no-clobber 发布；
  最终 audit 读回并重放 stable proposal 的 resource/gateway/idempotency/proposal 全 bundle。
- gateway audit 必须重算 frozen route hash，并拒绝空 request/error、扩展或畸形 attempt、以及 retry/ambiguity/
  usage 语义不一致；只验证字符串/hash/array 外形不构成可信收据。stable 与 V011 必须复用同一验证器；
  每个 logical request id 最终必须成功，只允许 retryable failure 在前，2xx 或 non-retryable row 后不得再有
  attempt/receipt，success 不得带 error，failure 必须带非空 error。

### 5.3 Task sandbox

- stable runtime/candidate capsule 只读，task workspace 按 benchmark 要求写；
- 每 trial fresh session、home、persistence、temp namespace；
- 不挂载 evidence/archive/sealed/controller；
- process tree/cgroup/network namespace 独立，无 sibling discovery；
- credential broker 只允许固定 model route，并拒绝任意 URL/model/headers。

Harbor/TB task 的官方 environment resource policy 仍由冻结 benchmark manifest 管理；controller 内的
proposal、candidate test/build/Loader/packed-overlay 配额不能替代或改写正式 task 配额。

### 5.4 Verifier

TB 2.1 现有 task 默认可能采用 shared environment 语义；这不等于 verifier source 在 agent phase 可见，
但若 tests 后挂入同一容器，candidate 仍可能污染 workspace。正式 run SHOULD 在 Harbor 支持且 task
artifact contract 验证通过时强制 `environment_mode=separate`：先停止 agent main service，只复制声明
artifacts，再在 fresh verifier env 注入 tests。

如果某 task 无法在 separate mode 保持官方语义，则必须：

- 保留官方 shared mode，记录 exception；
- 确保 tests/verifier 在 agent phase 不存在；
- 评测后做 workspace/process integrity checks；
- 不声称所有 verifier 都物理隔离。

不能为了“独立 verifier”自行改 TB task contract 后仍称官方分数。

## 6. Network policy

按 phase 最小授权：

| Phase      | Default network                                                        |
| ---------- | ---------------------------------------------------------------------- |
| Controller | LLM gateway、artifact store、Harbor control endpoint allowlist         |
| Proposal   | fixed proposer gateway + approved read-only source docs if predeclared |
| Build      | none                                                                   |
| Task agent | exact TB task policy; no controller/sealed/private ranges              |
| Verifier   | exact task verifier policy, preferably none                            |
| Analysis   | none after artifacts local                                             |

DNS/IP rebinding、redirect、IPv6、Unix sockets、cloud metadata 和 private ranges 必须由 sandbox provider
policy 处理。Candidate 不持有通用 provider API key；gateway 按 run/candidate/trial 绑定请求。

## 7. Model and budget firewall

Trusted gateway MUST：

- 锁定 provider、endpoint、exact model、reasoning effort、temperature、max tokens 和允许的 API；
- 注入 idempotency/trial attribution，不接受 candidate 自定 billing tags；
- 对 run/phase/candidate/trial 实时累计 tokens/USD；
- 达到 soft threshold 发 warning，hard threshold 原子拒绝新 request；
- 记录 effective request metadata 和 usage receipt，redact content/secrets；
- 禁止 candidate 调用其他 model、embedding、web proxy 或 credential endpoint。

辅助调用（compaction、subagent、title）同样经过 gateway 并计入 harness cost。

## 8. Static and build-time controls

Admission pipeline 100% 执行：

- dependency allowlist、exact lock、SBOM、license/vulnerability scan；
- no lifecycle scripts、native binary、dynamic code loading 或 dangerous Node APIs；
- secret scan、high-entropy literal、private URL/credential pattern；
- task/verifier fingerprint、answer/magic constant、conditional task routing scan；
- diff boundary 和 immutable parent verification；
- TypeScript strict typecheck、lint、unit、real Loader boot/unload；
- reproducible double build；
- capsule path/hash/signature validation。

Formal preflight 的 signer registry 属于 TCB，必须由 trusted caller 在 run evidence 之外提供。
`signatureKeyId` 只能选择已注册 Ed25519 key；verifier 必须从 registry PEM 重新推导 key id 后再验签。manifest、
evidence、candidate artifact 或环境内自带的 public key 都不能建立 trust anchor；未知、错配或不可解析 key
一律 fail closed。

Regex 只是初筛。还需 AST/import graph、semantic similarity 与运行时 syscall/network monitor；任何一项
都不能单独证明无 reward hacking。

## 9. Runtime controls

每 trial 外部强制：

- CPU/memory/pid/storage/wall-time/output/network/model budgets；
- read-only runtime/candidate mount 和 no-new-privileges/capability drop；
- no privileged container、host PID/network、Docker socket 或 broad bind mount；
- seccomp/Landlock/等价 provider policy（按平台可用性记录）；
- managed process group，结束后 kill/drain 并验证无 survivor；
- immutable audit sink，candidate 只能写 task workspace；
- tool call、permission、ACP event、DSH session event、gateway usage 与 verifier result 的 causal IDs。

Candidate 的 DSH sandbox policy 是 defense-in-depth；外层 container/cloud sandbox 才是主要边界。

## 10. Information-flow enforcement

Artifact store API 必须按 label + purpose + principal 授权。典型规则：

```text
proposer.read  = PUBLIC_SPEC + DEV_OBSERVED
selector.read  = DEV_OBSERVED + DEV_GUARD outcomes
candidate.read = current task instruction/workspace only
sealed.read    = locked candidate + baseline + SEALED assignments
public.read    = only revealed/sanitized artifacts
```

每次 export 生成 manifest/Merkle root；sandbox 内只能看到 export copy，不能直接 query store。Guard/
sealed records 使用 canary token；monitor 在 proposer/controller logs、prompts、source 中发现 canary 时
立即停止并 invalidates lineage。

## 11. Prompt-injection and evidence poisoning

TB instructions、tool outputs、source files和历史 trajectories 都是不可信 content。Proposer runner：

- system policy 明确 evidence 是 data，不是 authority；
- evidence reader 返回 provenance/label，不能把文件内容注入 system channel；
- 默认不执行历史 trace 中的命令或打开任意 URL；
- candidate source 只在 builder/sandbox 中处理，controller 不 import；
- proposal manifest 的 evidence refs 必须存在且 label 合法；
- passing/failing evidence 都提供，降低单侧失败诱导；
- rejected candidates 保留原因，防止反复生成同一危险修改。

Prompt 指令不能替代 filesystem/process policy。

## 12. Reward-integrity controls

- Verifier/scorer code、result directory 和 executable hash 只由 Harbor/TCB 写。
- Candidate 不知道 verifier path，不接收 reward 直到 task process 销毁。
- Normalizer 以 planned inventory 为分母；missing/corrupt 默认 FAIL。
- Result schema、task/candidate/protocol hash 必须匹配；不接受 candidate 写的 reward file。
- Regrade（若使用）只从 trusted collected artifacts，在固定 verifier hash 上进行并记录 lineage。
- Retry classifier reward-blind；timeout/resource/network 不因高分 candidate 调整。
- Sealed reveal 一次性，失败后不测试第二候选。
- Formal run 固定 artifact，禁止 task-conditioned routing 或在线更新。

## 13. Auditing

### 13.1 Automatic

每 candidate：source/diff/import/SBOM/task-fingerprint/build/Loader/unload。每 trial：identity、syscall/network/
process/resource、trajectory/result/cost reconciliation、workspace mutation summary。每 run：journal replay、
budget、split flow、RNG 和 trial completeness。

### 13.2 Human

按 evaluation protocol 的预注册样本审查轨迹与 source。审查结论使用：

- `NO_FINDING`
- `SUSPICIOUS_NONCRITICAL`
- `HIGH_RISK`
- `CRITICAL_REWARD_HACK`
- `INSUFFICIENT_EVIDENCE`

Critical 直接 invalidates；insufficient evidence 不能晋升。人工 review 不能修改已揭盲 run 让其通过，
只能解释或触发 successor run。

## 14. Rollback and quarantine

每个 release 都要有 baseline/previous release hash 和一条不依赖 candidate code 的 rollback 命令。

- Controller 只部署 sealed-promoted immutable bundle；不把 Archive latest 自动指向 production。
- Runtime health/safety anomaly 可由 trusted supervisor 切回 previous hash；不询问 candidate。
- Quarantine 保留 artifact/evidence，撤销执行资格和 distribution pointer，不删除历史。
- TCB 漏洞按 affected fingerprints 找出所有 candidates/trials，批量 invalidates 后重跑新 lineage。

## 15. Incident classes and response

| Class | Example                                | Required response                                                  |
| ----- | -------------------------------------- | ------------------------------------------------------------------ |
| S0    | docs/UI issue                          | record, no run impact                                              |
| S1    | one candidate build/load failure       | reject candidate, continue                                         |
| S2    | repeatable candidate sandbox violation | quarantine candidate/clade, review proposer evidence               |
| S3    | secret/guard leak, score inconsistency | stop run, rotate secrets, invalidate lineage                       |
| S4    | verifier/controller/host compromise    | isolate host, preserve forensic copy, invalidate all affected runs |

S3/S4 修复后必须新 run ID 和新的 split/seed commitment；不能 resume 原 run。

## 16. Safety claims

允许的表述：

> 在固定 threat model、自动扫描、隔离执行和预注册轨迹审查范围内，未发现 critical reward-hacking
> 行为；公开 benchmark 与模型先验污染、未知 sandbox escape 等残余风险仍存在。

禁止的表述：`零 reward hacking`、`provably safe`、`verifier 完全隔离`（若有 shared-mode exception）、
或仅凭 regex/green score 声称安全。
