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

- **仓库接地与职责（PRD 非结构化时）**：子代理 MUST 先根据本仓库 manifest/目录判断工程类型，再读 PRD；在「需求概览」填写「本仓职责边界」，并将与他端实现相关、非本仓交付的内容标为「仅背景」或写入「非目标」，不纳入本仓功能切片与验收要点（见 `agents/specflow-specify.md` Phase 0）。编排方若已知「仅前端/仅后端」，应在派发 Prompt 中写明。
- **澄清前置**：先识别产品/验收问题；有高影响不确定点时，不生成完整 `specify.md`，只写最小澄清草稿并等待用户回答。
- **正式文档只放答案**：完整 `specify.md` 不允许出现未闭合 `[?]`；Section 5 改为 Decision Log，只记录已闭合产品决策。
- **产品决策不独立成章**：不要输出 `Product Decisions & Boundaries` 章节；3-5 条高影响产品结论可放在 Requirement Overview 的「关键产品决策」，其余必须写入对应 Capability。
- **问题状态不进正文**：未闭合产品问题写入 `ai-docs/<需求号>/.temp/clarifications.json`（或最小澄清草稿中的结构化 CQ），不得散落在 Capability / Business Objects 正文中。
- **提问质量**：每条产品问题必须写成用户可理解的业务决策题，包含「需要你决定」「为什么关键」「SpecFlow 建议」；禁止把缺字段、缺接口、缺文案等技术缺口直接甩给用户。
- **一次性列全阻塞问题**：若存在真正阻塞 Plan/验收要点的产品决策题，必须一次性列全；不得为了控制轮次或数量而隐藏、延后或拆成多轮。
- **严禁代替用户闭合**：对阻塞性问题，严禁代替用户回答；低影响项应写成默认假设或已确认决策，不能用 `[?]` 占位。
