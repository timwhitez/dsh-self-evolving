# Project status

**状态：SPECIFICATION ONLY / NOT IMPLEMENTED**  
**更新时间：2026-08-14（Asia/Tokyo）**

## 已完成

- 核对本地 DeepSeek Harness、Harbor、legacy Terminal-Bench 和官方 TB 2.1 源码快照。
- 阅读 `/root/paper.pdf` 中 Cordis 动态组合、自进化 harness 和可逆 lifecycle 的相关章节。
- 核对 HGM、DGM、Meta-Harness、SICA 与 Self-Harness 的论文/公开实现。
- 冻结第一版架构、候选契约、搜索算法、sealed 评测、安全和恢复语义。
- 纠正旧文档中的错误引用、held-out 反复使用、`node:vm` 隔离、成本和 SOTA 假设。

## 尚未完成

- 没有 `dsh-rsi` package、candidate SDK、TB agent runner 或 benchmark adapter 实现。
- 没有单元测试、真实 Cordis Loader E2E、Harbor smoke、baseline 或成本校准。
- 没有运行 80 次扩展，没有 sealed 评测，也没有正式 89×5 评测。

因此当前不能声称：闭环可运行、分数提升、满足 `$500`/16 小时、零 reward hacking、可提交
leaderboard 或达到 SOTA。

## 下一个验收门

执行 `specs/07-implementation-plan.md` 的 Gate 0：生成机器可读的 provenance/run schema，验证
固定 DSH bundle 能通过真实 Loader 启动，并在不调用模型的情况下证明 unload 后无残留 effect。
逐项执行清单见 `docs/phase-todolist.md`。

Gate 0 未通过前，不创建自动 proposer，也不运行付费 benchmark。
