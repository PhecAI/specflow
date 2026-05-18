---
name: specifying-specflow
description: Use when the orchestrator dispatches specflow-specify or the requirement is in Specify phase with requirement ID set
---

# 使用 Specflow 进行规格制定

## Overview

在 Specify 阶段产出/更新 `specify.md`：对**阻塞性**未决点使用 `[?]` 与 Clarification Log；无阻塞点时允许**零提问**完成。文档需保持锚点可被引擎解析。

**Core principle：** 一次性写出完整文档初稿；**仅当**不澄清就无法唯一确定范围、AC、验收或合规风险时，才打 `[?]` 并提问。**不为流程完整性而提问。**

**Violating the letter of this process is violating the spirit of this process.**

---

## When to Use

- 编排器派发 `specflow-specify`
- 或引擎处于 Specify 阶段且已确认 `requirementId`

## 执行真相源

直接阅读并遵循子代理提示（含完整规则、模板、飞书/MCP 读取检查）：

- **Workspace**：`agents/specflow-specify.md`（仓库根目录 `agents/` 下；若安装位置不同则在对应镜像目录中读取）

## 打包资源（相对插件根目录 `$PLUGIN_ROOT`）

- 模板：`templates/specify-template.md`
- 完成汇报规范：`docs/user-facing/completion-output-specify.md`
- 协议 JSON 形状：`protocols/specify.md`

---

## 阻塞性澄清（Blocking Clarification）

以下任一成立时，**必须**使用 `[?]` + Section 5 记录（并在条目中写明 **阻塞原因** 与 **猜错的最坏影响**）：

- 不回答则 **AC / 范围 / 成功标准** 无法唯一写清，或会导致实现出**两套互斥产品**。
- 多源信息**冲突**且无优先级规则。
- **合规 / 安全 / 隐私** 级别未定义且影响设计取舍。

以下情况**不要**单独开 CQ：可用行业惯例、文档内 **「合理默认」** 或 **「[推断]」** 写死，并在 Section 3/4 注明；若后续 Plan 验证不足再迭代。

---

## 渐进式披露与轮次

- **每轮** Clarification Log 中**最多保留 3 条**未闭合的 `[?]` CQ；更多项写入 **Backlog（非阻塞）** 或下一轮再升格为 `[?]`。
- **澄清轮次**建议上限 **3 轮**：在 Section 5 用 `<!-- specflow:clarification-round value="n" -->`（1–3）标注当前轮；引擎交互每轮最多展示 3 条 CQ，其余需在 `specify.md` 中逐项填写 **[User]**。
- **第 3 轮结束后**若仍有未决阻塞：不得再堆新 `[?]`；应在正文写入 **Working assumptions（工作假设）** 并请 your human partner 确认，或 **拆分需求** / 将验证推迟到 Plan 中的 spike（并去掉对应 `[?]`）。

---

## The Iron Law

```
一次性生成包含 Section 1-6 的完整文档初稿。
仅对阻塞性缺口使用 [?]；非阻塞歧义用默认假设或 [推断] 写清。
STRICTLY PROHIBITED：为「显得专业」而提问；STRICTLY PROHIBITED：代替用户填写 [User]。
```

---

## Constraints

- **MUST** 保留锚点 `<!-- specflow:section=... -->`（不可删改）
- **MUST** 每个 `[?]` 的闭合：`#### **[User]**:` 由 your human partner 填写后才算闭合（禁止代答）
- **STRICTLY PROHIBITED** 在 Specify 阶段定义 API 路径或数据库 schema（Plan 阶段负责）

---

## Red Flags — 出现以下念头时立即停止

- “为了凑流程也要问几个澄清”
- “把明显可默认的细节也做成 CQ”
- “用户没空，我代选 A 帮他闭合”
- “先把 API/DB 写进 specify 省事”

**以上念头意味着：回到阻塞性标准与模板，删非阻塞 CQ 或改为正文假设。**

---

## Quick Reference

| 场景 | 操作 |
|---|---|
| 进入 Specify | 一次性写完 `specify.md` 初稿；仅阻塞点用 `[?]` |
| 无阻塞点 | Section 5 可仅保留「✅ 无阻塞性澄清」；直接进入完成汇报 |
| 有阻塞点 | Clarification Log + 每轮 ≤3 条 `[?]`；闭合后更新正文并移除已解条目 |
| 不确定 | 回到编排（`orchestrating-specflow`）跑引擎 |

---

## 检查清单

```
规格制定阶段：
- [ ] 需求号与 `ai-docs/<id>/` 下的路径正确
- [ ] 生成包含 Section 1-6 的完整文档初稿；`[?]` 仅标识阻塞性缺口并含「阻塞原因 / 猜错影响」
- [ ] 保留模板中的锚点 `<!-- specflow:section=... -->`（不可删改）
- [ ] 输出格式与 completion-output-specify.md 一致
```

这里 **不要** 定义 API 路径或数据库 schema（Plan 阶段负责）。
