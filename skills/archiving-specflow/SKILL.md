---
name: archiving-specflow
description: Use when the orchestrator dispatches specflow-archive or the requirement is in Archive phase with all tasks completed
---

# 使用 Specflow 进行归档（Archive）

## Overview

在所有任务完成后生成 `summary.md` 并运行 `archive.cjs` 做归档与索引更新。

**Core principle：** 归档是“收尾交付”，不是“搬文件”；只用脚本归档。

**Violating the letter of this process is violating the spirit of this process.**

---

## When to Use

- 编排器派发 `specflow-archive`
- 或引擎处于 Archive 阶段且所有任务已完成

## 执行真相源

- **子代理提示**：`agents/specflow-archive.md`

## 打包引用

- 协议：`protocols/archive.md`
- 模板：`templates/summary-template.md`
- 完成汇报规范：`docs/user-facing/completion-output-archive.md`
- **归档执行**：仅允许按子代理说明运行 `node tools/archive.cjs`（带文档里规定的参数）

---

## The Iron Law

```
归档只在所有任务完成后进行，并且只运行 archive.cjs。

STRICTLY PROHIBITED：手工移动 ai-docs 目录或手写 history/index。
```

---

## Constraints

- **MUST** 引擎确认无未完成任务再归档
- **MUST** 用模板生成 summary（按 completion-output）
- **STRICTLY PROHIBITED** 归档过程中“顺手改实现/改需求”（应走 change/implement 流程）

---

## Red Flags — 出现以下念头时立即停止

- “我直接把目录挪一下就算归档了”
- “index 我手动加一行更快”
- “归档前顺手修个小 bug”

**以上所有念头都意味着：停止，只按 archive.cjs 流程收尾。**

---

## Quick Reference

| 场景 | 操作 |
|---|---|
| 需要归档 | 生成 summary → 跑 `archive.cjs` |
| 发现还有任务未完成 | 回编排（`orchestrating-specflow`） |

---

## 检查清单

```
归档：
- [ ] 引擎确认所有任务均已完成
- [ ] 用 focusArchive / 模板生成 summary.md
- [ ] 只运行 archive.cjs（不要手动移动目录）
- [ ] 向用户报告归档目标路径与 index 行
```

