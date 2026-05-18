---
name: planning-specflow
description: Use when the orchestrator dispatches specflow-plan or the requirement is in Plan phase and gates are passed
---

# 使用 Specflow 进行技术方案制定（Plan）

## Overview

在 Plan 阶段生成或更新 `plan.md`（Feature/Design/Contract/Roadmap），并保证后续 Implement 的输入一致、可验。

**Core principle：** Plan 是实现的唯一真相源；先对齐 Contract/AC，再拆 Roadmap。

**Violating the letter of this process is violating the spirit of this process.**

---

## When to Use

- 编排器派发 `specflow-plan`
- 或引擎处于 Plan 阶段且门禁已通过

## 执行真相源

- **子代理提示**：`agents/specflow-plan.md`

## 打包资源

- 模板：`templates/plan-template.md`
- 完成汇报规范：`docs/user-facing/completion-output-plan.md`
- 协议：`protocols/plan.md`

## 门禁（必须满足，不能跳过）

- 优先使用 协议里的 `focusSpecify`；除非明确允许 fallback，否则不要读取完整 `specify.md`。

---

## The Iron Law

```
只要要产出或更新 plan.md：
必须引用/对齐 specify 的 AC，并把 Contract 与 Roadmap 写成可执行输入。

STRICTLY PROHIBITED：在 Plan 未通过门禁时推进 Implement。
```

---

## Constraints

- **MUST** 保留模板锚点（`<!-- specflow:section=... -->`）
- **MUST** Contract/Roadmap 引用的 AC id 来自 specify
- **MUST** 写入 plan 后按子代理指引清除 plan 锚点（如需）

---

## Red Flags — 出现以下念头时立即停止

- “specify 还没完整，但我可以先写 plan”
- “Contract 先随便写，后面实现时再改”
- “Roadmap 先堆任务，AC 对不对之后再说”

**以上所有念头都意味着：停止，回到门禁检查与 focusSpecify，对齐后再写 plan。**

---

## Quick Reference

| 场景 | 操作 |
|---|---|
| 需要写/改 plan.md | 跟随 `agents/specflow-plan.md` + `plan-template.md` |
| 不确定门禁 | 回到编排（`orchestrating-specflow`）重跑引擎 |

---

## 检查清单

```
Plan 阶段：
- [ ] specify 门禁已满足
- [ ] Contract 与 Roadmap 引用的 AC id 来自 specify
- [ ] 模板锚点保留完好
```
