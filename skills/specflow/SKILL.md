---
name: specflow
description: >-
  Use when the user explicitly starts Specflow delivery (implement chain): first run orchestrator implement or specflow-engine; not the change/sync path (use syncing-specflow-docs). Session defaults still follow using-specflow hooks.
---

# Specflow（交付入口）

本技能仅作 **开发/交付主线显式入口**（首轮 implement 链）；**不**重复会话中已注入的总闸与编排协议。

## 首轮必须且只能

路径以插件根 **`$PLUGIN_ROOT`** 为准；可执行脚本位于 `tools/`，详见 `tools/README.md`。

1. **已知需求号**  
   `node tools/orchestrator.cjs implement [workspaceRoot] <需求号>`  
   （可选 `--human`。）

2. **尚无需求号**  
   `node tools/specflow-engine.cjs [workspaceRoot]`  
   出现 `interaction_required` 时按引擎 `questions` 处理（有 `AskQuestion` 则先调用）；选定需求号后再回到步骤 1。

## 与需求变更互斥

- 首轮 **禁止** `orchestrator change` / `sync-document`。若实为规格/契约/方案变更，改用 **`syncing-specflow-docs`**。
- 进入闭环后：**`orchestrating-specflow`**；`dispatch` 前 **`print-protocol`**。

## 自检

- 首轮输出为经 **implement** 调起的 **specflow-engine JSON**，**不应**出现顶层 **`"mode": "change"`**。

## 资源与脚本位置

可执行包 `$PLUGIN_ROOT/tools/`；协议 `$PLUGIN_ROOT/protocols/`；模板 `$PLUGIN_ROOT/templates/`；长文档 `$PLUGIN_ROOT/docs/`。
