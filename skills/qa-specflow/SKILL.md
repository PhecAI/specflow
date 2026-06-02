---
name: qa-specflow
description: Use when the orchestrator dispatches specflow-qa and there are ready-for-qa tasks to audit
---

# 使用 SpecFlow 进行验收（QA Lite）

## Overview

只对当前 Group 的 `ready-for-qa` 任务做 **QA Lite** 审计并记录裁决。QA 的职责是审核 Implement 留下的 `Completion Packet` 与 `Verification Matrix`，通过则整组 `completed`，失败则整组 `failed` 并写 Failure Report；**不修生产代码，不重新设计测试，不默认重跑验证**。

**Core principle：** Evidence over claims。QA 是证据裁判，不是第二个实现阶段。

---

## When to Use

- 编排器派发 `specflow-qa`
- 当前 Group 存在 `[?] ready-for-qa` 任务

## 执行真相源

- 子代理提示：`agents/specflow-qa.md`
- 协议：`protocols/qa.md`
- 状态工具：`tools/manage-state.cjs mark-group`

---

## 硬性规则

- **MUST** 只验收 `[?] ready-for-qa` 任务。
- **MUST** 优先用 `mark-group <groupId> completed|failed` 回写状态；混合结果才回退 `mark-task`。
- **MUST** PASS evidence 包含 `QA Lite / Completion Packet / AC / Contract / Test Strategy / Verification Matrix` 摘要。
- **MUST** Completion Packet 缺少关键小节时直接 FAIL；状态机也会在 `completed` 前硬校验。
- **MUST** 只审核 Verification Contract 指定的局部目标与证据。
- **MUST** `[TDD]` 任务只审 Red / Green / Refactor 三段证据、顺序与测试质量；默认不重跑。
- **STRICTLY PROHIBITED** 在 QA 中修生产代码。
- **STRICTLY PROHIBITED** 启动服务、跑端到端、访问真实环境或使用浏览器做真实页面验证。
- **STRICTLY PROHIBITED** 执行范围不明的项目级/模块级测试、检查、构建、类型收口。
- **STRICTLY PROHIBITED** 把“命令通过”当作唯一结论；必须映射到 AC、Local Contract 或 Verification Matrix。

---

## QA Lite Checklist

```text
QA：
- [ ] 当前任务状态均为 [?]
- [ ] Completion Packet 存在且包含 Changed Files / AC Mapping / Local Contract Mapping / Test Strategy Execution / Verification Matrix / Not Run / Knowledge Rules Used
- [ ] AC Mapping 能追到具体文件、符号或行为证据
- [ ] Local Contract Mapping 覆盖接口、字段、枚举、权限、常量等本组契约
- [ ] Verification Matrix 覆盖 Static Diagnostics / Targeted Test / Contract Check / Smoke Evidence，且每项都有 scope -> evidence -> pass/deferred
- [ ] TDD 任务具备 Red / Green / Refactor 三段证据与正确顺序
- [ ] Not Run / Deferred 的原因合理，且承接到 QA / FinalQA / CI / manual
- [ ] Knowledge Rules Used 与实现落点一致
```

---

## 证据补录边界

只有以下情况允许 QA 补录一次验证证据：

- Completion Packet 声称 pass，但证据缺失或无法对应 scope。
- Test Strategy 明确要求 QA 执行某个局部目标。
- Bug Fix 再验收需要复核原失败项。

补录必须遵守：

- 只跑同一局部目标范围，不扩大到模块或项目。
- 不启动服务，不访问真实环境。
- 在 Evidence 中写明 `Supplemental Evidence: <scope> -> <result>`。
- 无安全局部能力时，不猜命令，写 CI/manual 承接。

---

## 状态回写

通过：

```bash
PLUGIN_ROOT=/path/to/specflow node "$PLUGIN_ROOT/tools/manage-state.cjs" mark-group <workspaceRoot> <requirementId> <groupId> completed "<QA Lite evidence>"
```

失败：

```bash
PLUGIN_ROOT=/path/to/specflow node "$PLUGIN_ROOT/tools/manage-state.cjs" mark-group <workspaceRoot> <requirementId> <groupId> failed "<Failure Report>"
```

PASS evidence 固定包含：

```text
<Group ID> | Mode: QA Lite | Completion Packet checked | AC Mapping checked | Local Contract checked | Test Strategy checked | Verification Matrix checked
```
