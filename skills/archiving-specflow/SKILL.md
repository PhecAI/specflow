---
name: archiving-specflow
description: Use when the orchestrator dispatches specflow-archive or the requirement is in Archive phase with all tasks completed
---

# Archiving SpecFlow：归档入口

在所有任务完成后生成 `summary.md` 并运行 `archive.cjs` 做归档与索引更新。

## 设计思想

| 原则 | 含义 |
| --- | --- |
| Script Only | 归档只用脚本执行，不手工移动目录或写 index。 |
| Finalized Work | 归档只在任务完成、用户确认冻结后进行。 |
| Delivery Closure | 归档是收尾交付，不是继续修改需求或实现。 |

## 使用时机

- 编排器派发 `specflow-archive`。
- 引擎处于 Archive 阶段且所有任务已完成。

## 终态

- `summary.md` 已生成。
- `archive.cjs` 已完成归档与索引更新。
- 用户收到符合完成汇报规范的归档结果。

<HARD-GATE>

归档只在所有任务完成后进行。
归档只运行 `archive.cjs`。
不得手工移动 `ai-docs` 目录或手写 history/index。
归档过程中不得顺手改实现、改需求或改 plan。

</HARD-GATE>

## 执行真相源

- `agents/specflow-archive.md`
- `protocols/archive.md`
- `templates/summary-template.md`
- `docs/user-facing/completion-output-archive.md`
- `tools/archive.cjs`

## 流程

1. 确认引擎已进入 Archive，且无未完成任务。
2. 按模板生成 `summary.md`。
3. 按 `agents/specflow-archive.md` 运行 `archive.cjs`。
4. 按完成汇报规范告诉用户归档结果。

## 反模式

- 直接移动需求目录。
- 手写 history/index。
- 归档前顺手修 bug 或改需求。
- 跳过用户归档锚点提前合并知识库。

## 自检

- 引擎是否确认所有任务均已完成？
- 是否用模板生成 summary？
- 是否只运行归档脚本，没有手工移动目录？
- 是否按用户可见规范汇报？

## 输出契约

- 成功：返回归档完成的人话摘要。
- 阻塞：说明未满足的归档前置条件。
- 不暴露内部脚本细节给用户，除非用户明确要求。
