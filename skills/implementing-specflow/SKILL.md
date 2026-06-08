---
name: implementing-specflow
description: Use when the orchestrator dispatches specflow-implement and the active Group has pending implementation tasks
---

# Implementing SpecFlow：实现入口

按 `plan.md` Roadmap 的当前 Active Group 推进实现，并把结果写入 plan Log。状态变更优先使用 `manage-state mark-group`，task 级仅作回退。

## 设计思想

| 原则 | 含义 |
| --- | --- |
| Plan Driven | 只实现当前 Active Group 指定的任务。 |
| Evidence Driven | 有实现证据与 Completion Packet 后才送测。 |
| QA Owns Completed | Implement 只能送测，不能标记 completed。 |
| Change Before Code | 发现需求、合约或方案变更时，先同步文档再继续实现。 |

## 使用时机

- 编排器派发 `specflow-implement`。
- Active Group 存在待实现任务（由引擎/编排确认）。

## 终态

- 当前 Group 的实现任务完成并写入 Completion Packet。
- 通过结构门禁后，优先用 `mark-group <groupId> ready-for-qa` 送测。
- 若发现需求/合约/方案变化，停止实现并回到文档同步。

<HARD-GATE>

不得手工编辑 `plan.md` 中任务 checkboxes。
不得将任务标记为 `completed`；该权限仅 QA 使用。
不得未同步文档就改合约、接口或外部行为。
不得执行无范围参数的项目级/模块级测试、检查、构建或类型验证。
不得启动本地服务、跑端到端或访问真实环境。

</HARD-GATE>

## 执行真相源

- `agents/specflow-implement.md`
- `protocols/implement.md`
- `docs/user-facing/completion-output-implement.md`
- `tools/manage-state.cjs mark-group`（推荐）或 `mark-task`（回退）

## 流程

1. 加载当前 Active Group 的 `focusPlan`。
2. 按 Task Group 的 Test Strategy / Verification Contract 执行。
3. `[TDD]` 单元按 Red → Green → Refactor 留证；非 TDD 只做 Strategy 指定的最小自检。
4. 写入 Completion Packet：Changed Files / AC Mapping / Local Contract Mapping / Test Strategy Execution / Verification Matrix / Not Run / Knowledge Rules Used。
5. 证据齐备后优先使用 `mark-group <groupId> ready-for-qa`；混合结果等特殊场景再回退 `mark-task`。
6. 按子代理规则更新 plan Log 区并汇报。

## 反模式

- 手工勾选 checkbox。
- 任务看起来做完就直接标 completed。
- 接口或字段顺手改，不同步文档。
- 跑全量项目检查来替代局部 Verification Contract。
- Red 失败后不记录证据，直接写实现。
- Green 失败后注释断言或造假通过。

## 自检

- 是否只实现当前 Active Group？
- Completion Packet 是否完整？
- Verification Matrix 是否覆盖 Static Diagnostics / Targeted Test / Contract Check / Smoke Evidence？
- code-style Hard 规则是否有验证映射？
- 是否没有越权标记 completed？

## 输出契约

- 成功：当前 Group 送入 `ready-for-qa`，并留下可审计证据。
- 阻塞：说明阻塞原因；涉及需求/合约/方案变化时转回 `syncing-specflow-docs`。
- 用户可见文本遵循 `docs/user-facing/VOICE.md` 与 `completion-output-implement.md`。
