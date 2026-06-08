---
name: qa-specflow
description: Use when the orchestrator dispatches specflow-qa and there are ready-for-qa tasks to audit
---

# QA SpecFlow：证据审计入口

只对当前 Group 的 `ready-for-qa` 任务做 QA Lite 审计并记录裁决。QA 是证据裁判，不是第二个实现阶段。

## 设计思想

| 原则 | 含义 |
| --- | --- |
| Evidence Over Claims | 只依据 Completion Packet 与 Verification Matrix 裁决。 |
| Audit Only | QA 不修代码、不重新设计测试、不默认重跑验证。 |
| Group First | 优先整组 completed/failed；混合结果才回退 task 级。 |

## 使用时机

- 编排器派发 `specflow-qa`。
- 当前 Group 存在 `[?] ready-for-qa` 任务。

## 终态

- PASS：当前 Group 标记为 `completed`。
- FAIL：当前 Group 标记为 `failed` 并写 Failure Report。
- 若需要补录，只补同一局部目标的验证证据。

<HARD-GATE>

只验收 `[?] ready-for-qa` 任务。
不得在 QA 中修生产代码。
不得启动服务、跑端到端、访问真实环境或使用浏览器做真实页面验证。
不得执行范围不明的项目级/模块级测试、检查、构建、类型收口。
不得把“命令通过”当作唯一结论；必须映射到 AC、Local Contract 或 Verification Matrix。

</HARD-GATE>

## 执行真相源

- `agents/specflow-qa.md`
- `protocols/qa.md`
- `tools/manage-state.cjs mark-group`

## 流程

1. 确认当前任务均为 `[?] ready-for-qa`。
2. 审核 Completion Packet 是否包含 Changed Files / AC Mapping / Local Contract Mapping / Test Strategy Execution / Verification Matrix / Not Run / Knowledge Rules Used。
3. 审核 AC Mapping、Local Contract Mapping 与 Verification Matrix 是否可追溯。
4. `[TDD]` 任务只审 Red / Green / Refactor 三段证据、顺序与测试质量。
5. 必要时按“证据补录边界”补同一局部目标证据。
6. 优先用 `mark-group <groupId> completed|failed` 回写状态。

## 证据补录边界

只有以下情况允许 QA 补录一次验证证据：

- Completion Packet 声称 pass，但证据缺失或无法对应 scope。
- Test Strategy 明确要求 QA 执行某个局部目标。
- Bug Fix 再验收需要复核原失败项。

补录必须只跑同一局部目标范围，不扩大到模块或项目；无安全局部能力时，不猜命令，写 CI/manual 承接。

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

## 反模式

- QA 中修代码。
- 默认重跑全量测试。
- 只看命令通过，不映射验收和契约。
- Completion Packet 缺关键小节仍 PASS。

## 自检

- 是否只审 `[?] ready-for-qa`？
- 是否覆盖 Completion Packet / AC / Contract / Test Strategy / Verification Matrix？
- TDD 证据顺序是否正确？
- Not Run / Deferred 是否合理承接到 QA / FinalQA / CI / manual？

## 输出契约

- PASS：写入 QA Lite evidence 并标记 Group completed。
- FAIL：写入 Failure Report 并标记 Group failed。
- 用户可见文本遵循 `docs/user-facing/VOICE.md`。
