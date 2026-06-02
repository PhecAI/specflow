---
name: implementing-specflow
description: Use when the orchestrator dispatches specflow-implement and the active Group has pending implementation tasks
---

# 使用 Specflow 进行实现（Implement）

## Overview

按 `plan.md` Roadmap 的当前 Active Group 推进实现，并把结果写入 plan Log；状态变更优先使用 `manage-state mark-group`（task 级仅作回退）。

**Core principle：** plan.md 驱动实现；证据驱动状态变更。

**Violating the letter of this process is violating the spirit of this process.**

---

## When to Use

- 编排器派发 `specflow-implement`
- 或 Active Group 存在待实现任务（由引擎/编排确认）

## 执行真相源

- **子代理提示**：`agents/specflow-implement.md`

## 打包引用

- 协议：`protocols/implement.md`
- 完成汇报规范：`docs/user-facing/completion-output-implement.md`
- 任务状态变更：`tools/manage-state.cjs mark-group`（推荐）或 `mark-task`（回退，见 `tools/README.md`）

## 硬性规则

- **禁止**手工编辑 `plan.md` 中任务 checkboxes；只能用 `manage-state.cjs`（优先 `mark-group`）。
- **禁止**标记 `completed`（`[x]`）；该权限仅 QA 使用。
- 一旦实现与 specify/plan 不一致：**立刻停止**，先回到编排 / **同步 Specflow 文档**，再继续后续流程。

---

## The Iron Law

```
只实现 plan Roadmap 当前 Active Group 指定的任务。

STRICTLY PROHIBITED：
- 手工编辑 plan.md 的任务复选框
- 将任务标记为 completed（仅 QA）
- 未同步文档就改合约/外部行为
```

---

## Constraints

- **MUST** 优先使用 `manage-state.cjs mark-group <groupId> ready-for-qa` 进行整组送测（一次门禁校验）
- **MUST** 任务有证据再标记 `ready-for-qa`（并把 Evidence 写入 plan Log）；仅在混合结果等特殊场景回退 `mark-task`
- **MUST** Ready-for-QA 日志包含 `Completion Packet`：Changed Files / AC Mapping / Local Contract Mapping / Test Strategy Execution / Verification Matrix / Not Run / Knowledge Rules Used，供 QA Lite 快速审计
- **MUST** 依赖状态机硬门禁推进：`manage-state` 会校验 `implement.completion_packet_ready`，缺少完整 Completion Packet 时拒绝进入 `ready-for-qa`
- **MUST** 发现需求/合约/方案变更 → 先走 `syncing-specflow-docs`
- **MUST** 标记 `ready-for-qa` 前满足结构门禁：Completion Packet 完整、Verification Matrix 覆盖、code-style Hard 规则有验证映射
- **MUST（性能硬约束）** Implement 阶段按 Task Group 的 **Test Strategy / Verification Contract** 执行；`[TDD]` 只是审计标签，只有 Strategy 指定的 TDD Units 才按“同一最小目标验证”执行 Red→Green→Refactor
- **MUST（探索硬约束）** QA 方案由 agent 基于当前项目文件探索；SpecFlow 不提供内置技术栈探测器，也不会自动选择命令；无安全局部验证能力时写 CI/manual 承接
- **STRICTLY PROHIBITED** 无范围参数的项目级/模块级测试、检查、构建、类型验证；启动本地服务；端到端或真实环境访问

---

## Red Flags — 出现以下念头时立即停止

- "我手动把 checkbox 勾一下更快"
- "这任务看起来 done 了，我直接标 completed"
- "接口/字段顺手改一下，不用同步文档"
- "顺手跑一下整个项目看看，反正 QA 也会再跑"（——不，Implement 阶段只执行 Test Strategy / Verification Contract 指定的最小目标验证）
- "顺手跑一下全量类型/构建收口"（——不，全量收口只能在 Final Gate 中按项目安全能力或 CI/manual 承接）
- **"Red 测试跑出来失败了，我赶紧写实现把它修掉"**（——不，Red 的失败是预期状态；**先把失败输出落盘到 plan Log 的 Red 证据区**，再进入 Green 编码）
- **"Red 跑失败了，我顺手改下测试让它先过"**（——不，Red 阶段只能改测试断言以保证**有效**，不能改测试去**消除**失败；大多数失败源于"实现未就绪"，进 Green 再写 `src/`）
- **"Green 没跑过，我把几个断言注释掉 / 换成 `expect(true).toBe(true)` 先过一下"**（——造假证据，QA 一眼识破，直接 FAIL 回 `fix`）
- **"写测试的同时顺手把 `src/` 也写了，一次到位省事"**（——等于跳过 Red，破坏红绿证据链）

**以上所有念头都意味着：停止，回到状态机与同步门禁。**

---

## Quick Reference


| 场景            | 操作                                              |
| ------------- | ----------------------------------------------- |
| 实现任务          | 跟随 `agents/specflow-implement.md` + `focusPlan` |
| 需要改 spec/plan | 先 `syncing-specflow-docs`，再回编排                  |
| 任务完成待验收       | 先写 Completion Packet 并过结构门禁，再 `mark-group <groupId> ready-for-qa` + Evidence（必要时回退 `mark-task`） |


---

## 检查清单

```
实现：
- [ ] 为当前 Active Group 加载 focusPlan（或允许的全量 plan fallback）
- [ ] 每个任务：读取 Task Group Test Strategy；TDD Units 走红-绿-重构，非 TDD 只执行 Strategy 明确分配给 Implement 的最小自检
- [ ] 写入 Completion Packet：Changed Files / AC Mapping / Local Contract Mapping / Test Strategy Execution / Verification Matrix / Not Run / Knowledge Rules Used
- [ ] 在有证据后优先使用 `mark-group` 将当前组送测；必要时再逐任务 `mark-task`
- [ ] 按子代理规则更新 plan Log 区
```
