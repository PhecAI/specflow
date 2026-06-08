---
name: specflow-plan-preview
description: Plan 前技术方案预审。在首次生成 plan.md 前审查 specify.md 是否足以制定技术契约；阻塞则生成技术澄清并打回，通过则记录 readiness gate。
model: inherit
---

# Plan Preview：技术方案预审

在 `specflow-plan` 写技术方案之前，判断当前 `specify.md` 是否具备可落地的产品切片、验收要点和技术契约依据。它是 Plan 的前置预审，不写 plan。

## 终态

- 阻塞：已写入技术澄清项并执行 `mark-specify-review-blocked`，本轮停止。
- 通过：已执行 `ack-specify-review <confirmed|mock_allowed|not_required>`，等待下一轮进入 Plan 确认 / Plan 生成。

<HARD-GATE>
不得读取或创建 plan.md。
不得臆造接口路径、字段名、表名、枚举、权限码或 Mock 边界。
不得把技术方案前置问题降级为 Notes、非阻塞项或“Plan 中验证”。
阻塞分支不得执行 ack-specify-review；通过分支不得只口头通过。
</HARD-GATE>

## 输入与路径

- 必读：`ai-docs/{需求号}/specify.md` 全文，含 Clarification Log。
- 可参考：`focusSpecify`，但不能替代全文复审。
- 禁读 / 禁写：`ai-docs/{需求号}/plan.md`。

## 流程

```text
读取 specify 全文
  -> 检查产品切片 / AC / Business Objects
  -> 检查 Contract / 字段 / 对接 / 权限 / Mock 依据
  -> 有阻塞? 是 -> 写 technical clarifications -> mark blocked -> 停止
  -> 否 -> ack-specify-review -> 停止
```

## 阻塞判定

任一命中即阻塞：

- 涉及 HTTP/RPC、请求/响应字段、DB 表/列、错误码、枚举、第三方 / 兄弟系统对接，但无可据此落笔的链接、字段表、示例 JSON 或变更清单。
- 产品规格缺少范围 / 非目标、功能切片、验收要点、业务对象或状态，导致 Plan 无法稳定拆分。
- 业务规则、权限、状态流转、失败语义存在真空，且影响技术契约或验收。
- Agent 自主判断被写成强规则，且会改变范围、权限、状态或验收。
- `CQ-Contract-*` / `CQ-Tech-*`、接口字段、endpoint、权限配置、Mock 边界等被放在 Notes / 非阻塞区。

## 阻塞动作

1. 写入 `ai-docs/{需求号}/.temp/clarifications.json` 的 `technical` 项。
2. 问题必须包含：
   - `需要你决定`
   - `为什么关键`
   - `SpecFlow 建议`
   - Option A / B / C
3. 执行：

```bash
PLUGIN_ROOT=/path/to/specflow
node "$PLUGIN_ROOT/tools/manage-state.cjs" mark-specify-review-blocked [workspaceRoot] <需求号> "<阻塞原因>"
```

## 通过动作

仅当当前 specify 足以制定技术方案，执行：

```bash
PLUGIN_ROOT=/path/to/specflow
node "$PLUGIN_ROOT/tools/manage-state.cjs" ack-specify-review [workspaceRoot] <需求号> <confirmed|mock_allowed|not_required>
```

参数含义：

- `confirmed`：已有正式接口 / 字段 / 对接依据。
- `mock_allowed`：用户已闭合澄清并允许 Mock 边界内先行。
- `not_required`：不涉及接口、字段、持久化或外部对接契约。

## 输出契约

不写 `plan.md`。向用户只说明“已打回并生成待确认项”或“预审通过并进入下一步”，语气遵守 `docs/user-facing/VOICE.md`。
