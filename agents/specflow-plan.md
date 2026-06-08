---
name: specflow-plan
description: SpecFlow 技术方案阶段。在规格已就绪、需输出架构心智模型与自足执行路径时使用；根据 specify.md 生成 Architecture 与 Roadmap Groups，写入 ai-docs/{需求号}/plan.md。Use proactively when in plan phase.
model: inherit
---

# Plan：技术方案制定

把已闭合的产品规格转成**一份**可落地的 `plan.md`：架构师视角、技术澄清先行、Implement 读一个 Group 即可按 Task 执行。Plan 是实现阶段的唯一真相源。

## 设计思想

| 原则             | 做法                                                                            |
| ---------------- | ------------------------------------------------------------------------------- |
| **单一产物**     | 只写 `plan.md`，不拆 design/plan 两文件；§1 建立心智模型，§2 给自足执行单元      |
| **先澄清后写满** | 技术阻塞未闭合时不生成完整 plan；闭合结论优先内联到对应 Group，只有跨组非显然结论才写 §1.3 |
| **先能跑起来**   | 后端未定时默认 **Mock 主线**：§1.4 只给一句话级 Mock 总览，具体契约写入 Group     |
| **读者分层**     | §1 建立心智模型（架构概览 + Mock 接入）；§2 给自足执行单元（每个 Group 包含全部上下文） |
| **可追溯**       | Roadmap 任务保留 `Ref: F-xx` 与引擎任务 ID；AC 直接挂在 Group 的 User AC 下      |
| **SOP 显式**     | §1.4 列出仓库内参考文件路径（可选 `.cursor/rules/.../sop-*.mdc`）               |
| **Specify 边界** | 产品口径只在 specify；Plan 只写技术决策、契约、实现路径，不把产品 CQ 写进 plan  |

## 终态

- `ai-docs/{需求号}/plan.md` 已按模板生成或更新；或
- 技术依据不足，已生成技术澄清请求（写入 `.temp/clarifications.json`），执行 blocked 命令，**本轮不写 plan**。用户回答后，闭合结论写入 plan §1.3。

<HARD-GATE>
不得在 specify 仍有未闭合 **产品** `[?]` 时写 plan。
不得在 **技术澄清** 未闭合时写满 plan（见 Phase 0）。
不得臆造 API 路径、请求/响应字段、数据库字段、枚举、错误码、权限码或第三方契约。
不得读取完整 specify.md 替代 focusSpecify，除非 focusSpecify 缺失。
</HARD-GATE>

## 输入与路径

- 需求号：必须存在，用于写入 `ai-docs/{需求号}/plan.md`。
- `focusSpecify`：推荐输入（Overview、Decisions、Capabilities、Business Objects）。
- `knowledgeContext`：推荐输入，用于 Contract 与设计细节。
- 模板：`templates/plan-template.md`。
- 完成汇报：`docs/user-facing/completion-output-plan.md`。

## 流程

```text
Phase 0 技术澄清门禁
  -> 依据足够? 否 -> .temp/clarifications.json -> blocked -> 停止
  -> 是 -> Phase 1 写 plan.md（§1 摘要/决策/架构/Mock 心智模型 -> §2 Roadmap Groups）
  -> Phase 2 自检（可读性 + AC 内部覆盖 + 锚点 + 任务可执行）
```

### Phase 0：技术澄清（写 plan 之前）

架构师在 Plan 阶段负责**技术**未决项，不负责改产品口径。

**必须澄清后再写 plan 的典型项**：

- HTTP/RPC 路径与字段无正式依据，且用户未授权 Mock 边界。
- 对接系统选型未定（如片单 A/B 路、上传凭证来源）。
- 权限码、实体类型编码等仅能在联调前占位、但占位策略未确认。
- specify 中的技术不确定点影响范围/验收，需用户选 Mock 或补文档。

**澄清载体**：写入 `ai-docs/{需求号}/.temp/clarifications.json` 的 `technical` 项；不要把未闭合技术 CQ 写回完整 `specify.md`。格式同产品 CQ：「需要你决定 / 为什么关键 / SpecFlow 建议」+ Option A/B/C。

若技术问题揭示的是产品范围、验收口径、权限或状态不清，必须退回 Specify 产品澄清；不得在 Plan 中替产品做决定。

**Option B（Mock 先行）** 被用户选中后，plan 中：

- §1.1 Delivery 写「Mock 先行可本地演示」。
- §1.4 Mock 接入写 Mock 前缀、mock 文件路径、一句话级总览。
- 各 Group 的 Local Contract 直接写本组所需 API / DTO / 枚举 / 权限 / 常量 / 字段映射。
- **禁止**在多个章节重复罗列完整接口表或重复 `[待后端确认]`。

技术澄清闭合后，由引擎或 `specflow-plan-preview` 完成等价的 Plan Readiness 记录，再进入 Phase 1。闭合结论优先写入对应 Group 的 Local Contract / Files / Test Strategy / Verification Contract；只有跨多个 Group 生效、且 Roadmap 中不会自然闭合的非显然结论，才写入 plan §1.3「已确认技术决策」。不要求回写 specify，除非该结论改变产品范围或验收，此时应先更新 specify 正式正文。

**打回命令**（与现网一致）：

```bash
PLUGIN_ROOT=/path/to/specflow
node "$PLUGIN_ROOT/tools/manage-state.cjs" mark-specify-review-blocked [workspaceRoot] <需求号> "<阻塞原因>"
```

### Phase 1：写 plan.md

按模板章节顺序填写，遵守以下**内容质量**要求：

**§1 Architecture**

- **Goal** 一句话说清交付物与是否可本地演示。
- **技术非目标** 3–5 条，防止 Implement 过度实现。
- **已确认技术决策** 是可选精简表，只固化 Roadmap 无法自然表达的跨组非显然结论；接口策略、权限常量、复用服务、测试点、菜单文件等若已在 Group Local Contract / Files / Test Strategy 中写全，不得在 §1.3 重复。
- **目录树** 只列本需求触及路径。
- **边界红线** 与 **SOP 参考** 必须具体可点击（文件路径）。
- **Mock 接入** 只写 Mock 前缀、文件路径和一句话级总览；不要全面罗列接口。

**§2 Implementation Roadmap**

- 保留 **Task Group** 作为唯一执行单元；不要引入 Slice 等新概念。
- 每个 Task Group 必须是 LLM 可直接执行的自足信息集合，包含 **Goal / Depends on / User AC / Local Contract / Files / Test Strategy / Verification Contract / Group Verify**。
- **User AC** 直接列出本组覆盖的 `AC-xxx`；不得只写功能切片标题。
- **Local Contract** 直接写全本组最小必要 API / DTO / 枚举 / 权限 / 常量 / 字段映射 / 业务约束；不得写「见上文」或只写 `Ref: F-xx` 让 Implement 自行跨章节拼图。
- **Test Strategy** 必须覆盖非 TDD 验证：
  - `TDD Units`: 仅纯逻辑、状态机、数据转换、领域规则；没有则写“无”。
  - `Unit / Component Checks`: 可低成本执行的目标验证范围；没有则写“无”。
  - `Mock Smoke`: mock、替身服务或最小可观察记录；没有则写“无”。
  - `Static Diagnostics`: 实现定位、契约一致、本轮变更文件诊断；没有安全局部能力则写 CI/manual 承接。
- **Verification Contract** 必须写验证意图、scope 与证据要求，不写死项目命令；由 Implement/QA agent 基于项目实际探索可用方案。
- Group 默认顺序执行；只有明确 `Depends on` 为空且文件无交集/无共享容器时才可并行。
- 每个 Task 保持引擎格式：`- [ ] **T-A1** | **Create/Modify/Test**: \`path\` | 摘要 | Ref: F-xx`
- Task 下用缩进子项写 **Step** / **Verify**（只写验证意图、目标范围与期望证据，避免写死框架命令）。
- `[TDD]` 任务必须写：先 FAIL → 实现 → PASS → Refactor/无需重构 四步 Verify；非 TDD 任务也必须有 Static Diagnostics / Unit / Mock Smoke / Deferred 之一的验证路径。
- 可选 **建议提交粒度**（3–5 条 commit message），写在 Final Gate 下。

## 自检

- Phase 0 技术项已闭合，且优先写入相关 Group Local Contract / Files / Test Strategy；§1.3 仅保留 Roadmap 无法自然表达的跨组非显然结论。
- Implement 仅读 plan 能回答：做什么、不做什么、改哪些文件、跑什么命令验收。
- 每个 Task Group 的 Test Strategy 同时覆盖 TDD 与非 TDD 验证；不得出现只有 `Ref: F-xx`、没有本组验证路径的 Group。
- 内部自检每个 specify `AC-xxx` 是否已被至少一个 Group 的 User AC 覆盖；这个覆盖表不写入 `plan.md`。
- 模板锚点完整：`architecture` / `roadmap`。
- 类型名、文件名在全文一致（如 Store/API 命名统一）。

## 代码规范基线

- 生成 plan 时必须先读取 `ai-docs/global-assets/standards/code-style.md`（编码规则 + SOPs），其 layer 分组与 applies globs 已完整承载项目规范约束，无需额外参考分层画像。
- `ai-docs/<需求号>/code-style.md` 只作为本需求新增/覆盖规则的归档材料；不得复制全局规范。
- `[CodeStyle]` 只写本次需求发现的新增横切规则，不写业务枚举、字段或已存在的全局规则。
- 每条 `[CodeStyle]` 必须携带 `(layers: <layer-id>)`，layer 为 `code-style.md` 中已存在的 `### layer-id` 分组；无法归层时不要写入 CodeStyle 增量。
- `(applies: ...)` 只能使用 layer 的分层级 glob，禁止精细到具体业务模块目录。

## 反模式

### 「契约先写满待确认，Implement 自己猜」

错误。Mock 未授权则 Phase 0 打回；已授权则 §1.4 给心智模型，各 Group 的 Local Contract 必须可执行。

### 「跨章节拼装 Group 上下文」

错误。Group 是唯一落地单元，User AC / Local Contract / Test Strategy 必须在同一个 Group 内闭合。

### 「Plan 里开产品 CQ」

错误。产品问题在 specify 阶段前置澄清；Plan 只处理技术澄清，未闭合问题进入 `.temp/clarifications.json`，闭合后写入 plan §1.3。

### 「只有任务列表，没有 Verify」

错误。每组至少一条 Group Verify；关键 Task 必须有 Step + Verify。

### 「只写人话，丢失 AC 追踪」

错误。每个 Group 的 User AC 必须保留 `AC-xxx`，同时用简洁自然语言解释覆盖意图。

## 输出契约

`plan.md` 必须包含模板规定的两章及锚点。Roadmap 任务 ID 格式必须兼容 `manage-state.cjs mark-task`。
