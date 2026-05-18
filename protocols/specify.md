# Specify Protocol

子代理：`specflow-specify`。派发时以引擎落盘的 `pending-protocol.json` 及本 Schema 为准。

## Schema

```json
{
  "requirementId": "<需求号>",
  "task": "generate_or_update_spec",
  "context": {
    "userInput": "<用户原始需求>"
  }
}
```

## 约束

- **仓库接地与职责（PRD 非结构化时）**：子代理 MUST 先根据本仓库 manifest/目录判断工程类型，再读 PRD；在 Executive Summary 填写「本项目职责边界」，并将与他端实现相关、非本仓交付的内容标为「仅背景」，不纳入本仓 AC（见 `agents/specflow-specify.md` Phase 0）。编排方若已知「仅前端/仅后端」，应在派发 Prompt 中写明。
- **完整生成**：生成包含 Section 1-6 的完整文档初稿；**仅对阻塞性缺口**使用 `[?]`，并在 Section 5 (Clarification Log) 集中记录（含阻塞原因与猜错影响）。
- **零提问允许**：若无阻塞性歧义，Section 5 可无「待闭合 `[?]`」；不得为凑流程而提问。
- **渐进式披露**：同时未闭合的 `[?]` 建议不超过 **3** 条；澄清轮次建议不超过 **3** 轮（见模板 `clarification-round` 注释）。
- **严禁代替用户闭合**：对阻塞性 `[?]`，严禁代替用户回答；非阻塞项应使用默认假设或 `[推断]` 写入正文，而非占位 `[?]`。
