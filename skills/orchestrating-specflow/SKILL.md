---
name: orchestrating-specflow
description: Use when Specflow is active and the current turn should advance the workflow by running orchestrator/engine and acting on suggestedAction; do not use when you are a dispatched phase subagent (specflow-implement/qa/etc)
---

# Orchestrating SpecFlow：流程编排

本技能负责把脚本输出的 `suggestedAction` 变成可验证动作，避免凭感觉推进。低自由度：只运行打包脚本，不临场改流程顺序。

## 设计思想

| 原则 | 含义 |
| --- | --- |
| SuggestedAction Is Law | 引擎说什么就做什么；引擎让停就停。 |
| Main Session Orchestrates | 主会话只编排，不直接包办 dispatched 子代理工作。 |
| Human Gate Is Real | `interaction_required` 必须真实收集用户输入。 |
| Stop Means Stop | `anchor` / `block` 本轮只展示人话并结束。 |

## 使用时机

- SpecFlow 已激活，当前回合需要推进流程。
- 需要运行 orchestrator/engine，并依据 `suggestedAction` 派发、提问、阻塞或结束。

不得在 dispatched phase subagent 内使用本技能。

## 终态

- `dispatch`：已 print protocol 并显式派发子代理。
- `dispatch_array`：已按依赖与文件/契约冲突判断并行或串行派发。
- `interaction_required`：已通过 AskQuestion 或等价文本输入收集并写回状态。
- `anchor` / `block`：只向用户展示人话并结束本轮。

<HARD-GATE>

每个推进流程的回合必须运行 `orchestrator.cjs` 并依据 `suggestedAction` 行动。
未获取 `suggestedAction` 前，不得 dispatch、manage-state 或写生产代码。
dispatch 前必须 `print-protocol.cjs`；主会话不得直接读写实现文件来替代子代理。
`interaction_required` 且有 AskQuestion 工具时，必须先调用 AskQuestion。
Archive anchor 本轮不得自动调 `set-archive-anchor`，必须等用户下一轮主动确认归档。

</HARD-GATE>

## 执行真相源

- `tools/orchestrator.cjs`
- `tools/print-protocol.cjs`
- `tools/manage-state.cjs`
- `docs/orchestration-full.md`
- `docs/user-facing/VOICE.md`
- `protocols/*.md`
- `docs/troubleshooting.md`

## 流程

```mermaid
flowchart TB
  start([Start turn]) --> run[Run orchestrator.cjs\nRead engine JSON]
  run --> t{suggestedAction.type?}
  t -->|dispatch| d[print-protocol\nDispatch subagent]
  t -->|dispatch_array| da[Check dependsOn/files/contracts\nDispatch parallel or serial]
  t -->|interaction_required| ir[AskQuestion or text fallback\nWrite answer with manage-state\nRun engine again]
  t -->|anchor| a[Show user-facing message\nEnd turn]
  t -->|block| b[Show reason\nEnd turn]
  d --> loop{implement/qa/domain-explorer?}
  da --> loop
  loop -->|yes| run
  loop -->|no| end([Stop])
```

## SuggestedAction 处理

| type | 操作 |
| --- | --- |
| `dispatch` | 先 `print-protocol.cjs --agent` 或 `--task-prompt`，再用 Task tool 显式派发 `suggestedAction.agent`；用户侧只展示 `userFacing` / `--human`。 |
| `dispatch_array` | 每个 item 独立读取 `groupId` / `agent` / `focusPlan` / `dependsOn`；无依赖且无文件/契约冲突时可同批并行，最多 2 个；否则串行。 |
| `interaction_required` | 有 AskQuestion 工具必须先调用；无工具才用 `prompt` + `options` 文案等价展示。回答后用 `manage-state` 写回，再跑引擎。 |
| `anchor` | 只展示 message/reason 并结束本轮。 |
| `block` | 只展示 reason 并结束本轮。 |

## Human Gate

`questions[].id` 可能包含：

- `init_requirement_id`
- `init_requirement_text`
- `confirm_start_plan`
- `confirm_start_implement`
- `confirm_start_group`
- `retry_limit_exceeded`
- `CQ-*`
- `CQ-*__detail`

CQ 回答必须写回 `.temp/clarifications.json`：

```bash
node "$PLUGIN_ROOT/tools/manage-state.cjs" answer-clarification [workspaceRoot] <需求号> <cqId> "<answer>"
```

多项 CQ 同时返回时，必须把本轮所有已回答主 CQ 一次性写回；推荐使用 `answer-clarifications`。`CQ-*__detail` 是补充说明，不是独立 CQ，应拼接进对应主 CQ 的 answer。

## Plan / Implement 门禁

- 未闭合产品 `[?]`：不得进入 Plan。
- Plan 前架构评审未通过：不得确认 Plan。
- `confirm_start_plan`：确认后执行 `ack-specify-before-plan`，再跑引擎。
- `confirm_start_implement`：确认后执行 `ack-plan-before-implement <groupId>`；自动托管选择加 `--auto`。
- `confirm_start_group`：执行 `set-active-group`；自动托管加 `--auto`。

## Group 自动托管

- `autoProceedGroups=false`：每个新 Group 需要确认。
- `autoProceedGroups=true`：后续 Group 静默对齐 activeGroup。
- 自动托管下可能出现 `dispatch_array`，每个 Group 独立 implement → QA → fix → QA 闭环。
- 依赖为空且无明显文件/契约冲突才并行；存在共享页面容器、聚合文件、Mock、API contract 或 `dependsOn` 时串行。

## 归档锚点

- Roadmap 全绿不等于立即归档。
- 收到 `anchor(next.action='set-archive-anchor')`：只展示提示并结束本轮。
- 下一轮用户明确表达归档意图后，才执行：

```bash
node "$PLUGIN_ROOT/tools/manage-state.cjs" set-archive-anchor [workspaceRoot] <需求号>
```

随后再跑引擎，依次进入 domain merge、knowledge review、archive。

## 反模式

- 不跑引擎就派发下一步。
- 用聊天复述选项代替 AskQuestion。
- dispatch 时省略 print-protocol。
- 主会话直接改代码来替代子代理。
- CQ 只写聊天上下文，不写回状态。
- Archive anchor 当轮自动推进。
- `dispatch_array` 不看依赖和文件冲突就全并行。
- 接口文档缺失时在 plan 里臆造 Contract。

## 自检

- 是否已运行 orchestrator/engine？
- 是否只依据 `suggestedAction` 行动？
- dispatch 前是否 print protocol？
- interaction 是否真实收集并写回用户答案？
- anchor/block 是否没有同轮继续 manage-state 或 dispatch？
- implement/qa 返回后是否同轮继续跑引擎直到停止条件？

## 输出契约

- 对用户只展示 `userFacing`、`--human` 或润色后的 reason，不粘贴 JSON 和内部字段。
- 子代理派发必须使用协议输出作为 prompt。
- 任一脚本非零退出码：停止并查 `docs/troubleshooting.md`。

## 索引

- 完整协议：`docs/orchestration-full.md`
- 脚本：`tools/README.md`
- 协议 Schema：`protocols/*.md`
- 故障排查：`docs/troubleshooting.md`
