---
name: specifying-specflow
description: Use when the orchestrator dispatches specflow-specify or the requirement is in Specify phase with requirement ID set
---

# Specifying SpecFlow：需求说明入口

这是 Specify 阶段的技能入口，用来把 PRD、飞书文档或口头需求转成 Agent 易理解、易拆分的产品规格。

本文件只说明何时使用、读取什么、不能越过哪些边界；具体执行以 `agents/specflow-specify.md` 为准，避免 skill 与 agent 规则漂移。

## 设计思想

| 原则 | 含义 |
| --- | --- |
| Agent Is Source | 具体澄清格式、升级规则、写作流程以 `agents/specflow-specify.md` 为准。 |
| Product Before Tech | Specify 只定义产品范围、验收、业务对象与状态，不写技术契约。 |
| Clarify Before Draft | 高影响不确定点未闭合时，不写正式 `specify.md`。 |

## 使用时机

- 编排器派发 `specflow-specify`。
- 引擎处于 Specify 阶段，且已确认 `requirementId`。
- 需求说明尚未生成、存在未闭合待产品确认，或用户补充了会影响产品规格的信息。

## 终态

- 没有高影响不确定点：`specify.md` 已完整生成，且无未闭合 `[?]`。
- 存在高影响不确定点：只保留待用户决定或确认的问题，等待用户回答。

<HARD-GATE>

不得为了“流程完整”而提问。
不得代替用户回答 `[?]`。
不得在存在高影响不确定点时先写满正式规格正文。
不得在 Specify 阶段定义 API 路径、DTO 字段、数据库 schema、真实权限码或技术方案。
不得把接口或字段缺失包装成产品问题，除非它会改变产品范围、验收口径、权限、合规或高返工取舍。

</HARD-GATE>

## 执行真相源

- `agents/specflow-specify.md`
- `templates/specify-template.md`
- `docs/user-facing/completion-output-specify.md`
- `protocols/specify.md`

若本文件与上述文件存在细节差异，以 `agents/specflow-specify.md` 为准。

## 流程

1. 确认需求号与 Specify 阶段状态。
2. 读取 `agents/specflow-specify.md`，按其中流程执行。
3. 读取需求来源、业务知识库与必要仓库上下文。
4. 先判断是否存在高影响不确定点，再决定写最小澄清文件或完整规格。
5. 按完成汇报规范用自然语言告诉用户结果。

## 输出边界

`specify.md` 应聚焦：

- 需求概览与本期边界。
- 产品决策与业务依据。
- 功能切片与验收要点。
- 业务对象、状态与规则。
- 待用户决定或确认的产品问题。

技术契约、接口字段、真实权限码、数据库结构、实现路径和测试策略应后移到 Plan。

## 反模式

- 把技术字段缺口包装成产品 CQ。
- 在 Specify 中写 API、DTO、DB 或技术栈方案。
- 为了减少等待而替用户闭合 `[?]`。
- 绕过 `agents/specflow-specify.md` 自行设计澄清格式。

## 自检

- 是否已经按 `agents/specflow-specify.md` 完成 Clarification Gate？
- 是否没有把高影响不确定点静默写入正式正文？
- 是否没有在 Specify 中写入技术方案细节？
- 是否按 `completion-output-specify.md` 汇报，没有暴露内部流程机制？

## 输出契约

- 成功：生成完整 `specify.md`，或生成待用户回答的澄清状态。
- 失败：说明阻塞原因，不伪造产品结论。
- 用户可见文本遵循 `docs/user-facing/VOICE.md`。
