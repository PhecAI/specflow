---
name: specflow
description: >-
  Use when the user explicitly starts Specflow delivery (implement chain): first run orchestrator implement or specflow-engine; not the change/sync path (use syncing-specflow-docs). Session defaults still follow using-specflow hooks.
---

# SpecFlow：交付主线入口

本技能仅作开发/交付主线的显式入口（首轮 implement 链），不重复会话中已注入的总闸与编排协议。

## 设计思想

| 原则 | 含义 |
| --- | --- |
| Implement Entry Only | 本技能只启动交付主线，不处理需求变更同步。 |
| Engine First | 首轮必须先跑引擎或 orchestrator。 |
| Delegate Loop | 进入闭环后交给 `orchestrating-specflow`。 |

## 使用时机

- 用户明确要启动 SpecFlow 交付主线。
- 目标是继续 implement 链，而不是同步规格、合约或方案变更。

## 终态

- 已知需求号：得到 `orchestrator.cjs implement` 的引擎 JSON。
- 尚无需求号：得到引擎 `interaction_required`，等待用户选择或输入需求号。

<HARD-GATE>

首轮禁止 `orchestrator change` / `sync-document`。
若实为规格、契约或方案变更，改用 `syncing-specflow-docs`。
不得绕过引擎直接派发子代理或改代码。

</HARD-GATE>

## 执行真相源

- `tools/orchestrator.cjs`
- `tools/specflow-engine.cjs`
- `tools/README.md`
- `orchestrating-specflow`

## 流程

路径以插件根 `$PLUGIN_ROOT` 为准；可执行脚本位于 `tools/`。

已知需求号：

```bash
node tools/orchestrator.cjs implement [workspaceRoot] <需求号>
```

尚无需求号：

```bash
node tools/specflow-engine.cjs [workspaceRoot]
```

出现 `interaction_required` 时按引擎 `questions` 处理；有 AskQuestion 工具则先调用。选定需求号后再回到 implement 入口。

## 反模式

- 首轮误跑 `change`。
- 用户补接口文档时继续走 implement。
- 未跑引擎就创建 `ai-docs`、派发 agent 或改代码。

## 自检

- 首轮输出是否来自 implement 链？
- 顶层是否没有出现 `"mode": "change"`？
- 是否在进入闭环后转给 `orchestrating-specflow`？

## 输出契约

- 成功：返回引擎 suggestedAction，后续由 `orchestrating-specflow` 执行。
- 若判定为变更：切到 `syncing-specflow-docs`。
