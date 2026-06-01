---
name: planning-specflow
description: Use when the orchestrator dispatches specflow-plan or the requirement is in Plan phase and gates are passed
---

# 使用 SpecFlow 制定技术方案

架构师阶段：技术澄清先行 → 产出**单一** `plan.md`（设计 + 契约 + 可执行 Roadmap）。Implement 读 plan 即可按 Task 开干。

## 终态

- `plan.md` 已生成或更新（§1 摘要/决策 → §2 契约 → §3 Feature → §4 带 Verify 的 Roadmap）；或
- 技术依据不足，已生成技术澄清状态并 blocked，本轮不写 plan。

<HARD-GATE>
产品 `[?]` 未闭合不写 plan。
技术澄清未闭合不写满 plan。
不得臆造 API、字段、枚举或第三方契约。
不得推进 Implement。
</HARD-GATE>

## 使用时机

- 编排器派发 `specflow-plan`。
- 引擎处于 Plan 阶段且门禁已通过。

## 执行真相源

- `agents/specflow-plan.md`
- `templates/plan-template.md`
- `docs/user-facing/completion-output-plan.md`
- `protocols/plan.md`

## 工作清单

1. **Phase 0**：检查接口/对接/Mock 依据；不足则生成技术澄清状态并 blocked。
2. 读取 `focusSpecify`；筛选 `knowledgeContext`。
3. 写 §1：Goal、技术非目标、已确认技术决策、目录、红线、SOP。
4. 写 §2：Mock 表（如需）+ 常量/Domain + 联调替换清单。
5. 写 §3：Feature 映射（要点 + Test Scope，不重复 Roadmap）。
6. 写 §4：Group/Task + Step/Verify + Spec 覆盖自检。
7. 自检可读性与引擎锚点。

## 与 Superpowers 对齐（仍在一份 plan 内）

- §1 ≈ design 的「背景/非目标/决策/目录」
- §2 Mock 表 ≈ design 的「Mock API」
- §4 Task 的 Step/Verify ≈ plan 的可执行步骤
- 不拆第二份文件；Specify 仍只承载产品规格

## 反模式

- Mock 未授权却写满 `[待确认]` 契约。
- Feature 与 Roadmap 重复粘贴。
- 只有任务名、没有 Run/Expected。
- 在 plan 里改产品口径。

## 自检

- Implement 不读 specify 也能知道改哪些文件、跑什么命令。
- Mock 场景 §2.1 可独立支撑 Group A/B。
- 模板锚点完整；Task ID 兼容 mark-task。
