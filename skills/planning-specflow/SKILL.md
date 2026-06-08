---
name: planning-specflow
description: Use when the orchestrator dispatches specflow-plan or the requirement is in Plan phase and gates are passed
---

# Planning SpecFlow：技术方案入口

架构师阶段：技术澄清先行，产出**单一** `plan.md`。Implement 读 plan 的 Task Group 即可执行。

## 设计思想

| 原则 | 含义 |
| --- | --- |
| Agent Is Source | 具体写作与门禁以 `agents/specflow-plan.md` 为准。 |
| Clarify Before Plan | 技术依据不足时生成澄清状态，不写满 plan。 |
| Self-contained Groups | Roadmap Group 必须自足，Implement 不依赖回读完整 specify。 |

## 使用时机

- 编排器派发 `specflow-plan`。
- 引擎处于 Plan 阶段且门禁已通过。

## 终态

- `plan.md` 已生成或更新；或
- 技术依据不足，已生成技术澄清状态并 blocked，本轮不写 plan。

<HARD-GATE>

产品 `[?]` 未闭合不写 plan。
技术澄清未闭合不写满 plan。
不得臆造 API、字段、枚举、错误码、权限码或第三方契约。

</HARD-GATE>

## 执行真相源

- `agents/specflow-plan.md`
- `templates/plan-template.md`
- `docs/user-facing/completion-output-plan.md`
- `protocols/plan.md`

## 流程

1. Phase 0：检查接口、对接、Mock 依据；不足则生成技术澄清状态并 blocked。
2. 读取 `focusSpecify`；筛选 `knowledgeContext`。
3. 写 §1：Goal、技术非目标、可选的已确认技术决策、目录、红线、SOP；技术结论优先内联到对应 Group。
4. 写 §2：Mock 表（如需）+ 常量/Domain + 联调替换清单。
5. 写 §3：Feature 映射（要点 + Verification Intent，不重复 Roadmap）。
6. 写 §4：Task Group 作为执行单元；每组内联 Goal / Depends on / User AC / Local Contract / Files / Test Strategy / Group Verify / Task Step+Verify。
7. 自检可读性与引擎锚点。

## 反模式

- Mock 未授权却写满 `[待确认]` 契约。
- Feature 与 Roadmap 重复粘贴。
- 只有任务名，没有 Local Contract / Test Strategy / Verify。
- 在 plan 里改产品口径。

## 自检

- Implement 不读 specify 也能从当前 Task Group 知道用户验收、局部契约、改哪些文件、执行哪些最小验证。
- Mock 场景 §2.1 可独立支撑 Group A/B。
- 模板锚点完整；Task ID 兼容 mark-task。

## 输出契约

- 成功：生成或更新 `plan.md`。
- 阻塞：生成技术澄清状态并停止，不写完整 plan。
- 用户可见文本遵循 `docs/user-facing/VOICE.md` 与 `completion-output-plan.md`。
