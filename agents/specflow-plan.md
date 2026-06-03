---
name: specflow-plan
description: SpecFlow 技术方案阶段。在规格已就绪、需输出技术契约与执行路径时使用；根据 specify.md 生成 Feature & Design、Contract、Roadmap，写入 ai-docs/{需求号}/plan.md。Use proactively when in plan phase.
model: inherit
---

# Plan：技术方案制定

把已闭合的产品规格转成**一份**可落地的 `plan.md`：架构师视角、技术澄清先行、Implement 读 plan 即可按 Task 执行。Plan 是实现阶段的唯一真相源。

## 设计思想

| 原则             | 做法                                                                            |
| ---------------- | ------------------------------------------------------------------------------- |
| **单一产物**     | 只写 `plan.md`，不拆 design/plan 两文件；设计说明放在 §1，执行步骤放在 §4       |
| **先澄清后写满** | 技术阻塞未闭合时不生成完整 plan；闭合结论写入 §1.3「已确认技术决策」            |
| **先能跑起来**   | 后端未定时默认 **Mock 主线**：§2.1 Mock 表 + §2.5 联调清单，而非全文 `[待确认]` |
| **读者分层**     | §1–2 给心智模型；§3 给映射与测试意图；§4 给 Files/Steps/Verify                  |
| **不重复**       | Feature 不写逐步操作；Roadmap 不复制 Feature 长段设计                           |
| **可追溯**       | Feature Ref 指向 specify 功能切片；Roadmap 任务保留 `Ref: F-xx` 与引擎任务 ID   |
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
  -> 是 -> Phase 1 写 plan.md（§1 摘要/决策 -> §2 契约 -> §3 Feature -> §4 Roadmap）
  -> Phase 2 自检（可读性 + 覆盖 + 锚点 + 任务可执行）
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
- §2.1 给出完整 Mock API 表与 mock 文件路径。
- §2.5 写联调替换清单；**禁止**在 §2.4 每个接口重复 `[待后端确认]`。

技术澄清闭合后，由引擎或 `specflow-specify-review` 完成等价的 Plan Readiness 记录，再进入 Phase 1。闭合结论写入 plan §1.3「已确认技术决策」；不要求回写 specify，除非该结论改变产品范围或验收，此时应先更新 specify 正式正文。

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
- **已确认技术决策** 表格固化 Phase 0 结论。
- **目录树** 只列本需求触及路径。
- **边界红线** 与 **SOP 参考** 必须具体可点击（文件路径）。

**§2 Technical Contracts**

- Mock 场景：**§2.1 为主**，Implement 默认对接 Mock。
- 枚举/常量/Domain 衍生规则写清；领域 flag 用 Plain Language。
- 正式 API 仅在有依据或 Mock 切换说明时写 §2.4。

**§3 Feature Breakdown**

- 每个 specify 功能切片至少一个 `[F-xx]`。
- **Design** 限 3–5 条要点；**Verification Intent** 只写测试/验证候选，不写执行步骤。
- `[TDD]` 只作为审计标签，不承担测试设计；真实执行方式必须在 §4 Task Group 的 **Test Strategy** 中闭合。
- Ref 必须使用 specify 中的全局验收编号：`Ref: AC-001` / `Ref: AC-002`。Feature 可同时标注关联功能切片，但 AC 覆盖审计以 `AC-xxx` 为准。

**§4 Implementation Roadmap**

- 保留 **Task Group** 作为唯一执行单元；不要引入 Slice 等新概念。
- 每个 Task Group 必须是 LLM 可直接执行的自足信息集合，包含 **Goal / Depends on / User AC / Local Contract / Files / Test Strategy / Verification Contract / Group Verify**。
- **Local Contract** 从 §2 摘取本组最小必要 API / DTO / 枚举 / 权限 / 常量；不得只写 `Ref: F-xx` 让 Implement 自行跨章节拼图。
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
- 末尾 **AC 覆盖自检** 表：每个 `AC-xxx` → Feature / Task。必须做到 `AC-xxx` 100% 覆盖；若某 AC 不在本轮实现，必须在表中写明延期或非目标依据。
- 可选 **建议提交粒度**（3–5 条 commit message），写在 Final Gate 下。

### Phase 2：自检

- Phase 0 技术项已闭合或已按 Mock 边界写入 §1.3 / §2.1。
- Implement 仅读 plan 能回答：做什么、不做什么、改哪些文件、跑什么命令验收。
- Feature 与 Roadmap 无大段重复；Roadmap 的重复必须是“执行所需最小摘要”（User AC / Local Contract），不是整段复制。
- 每个 Task Group 的 Test Strategy 同时覆盖 TDD 与非 TDD 验证；不得出现只有 `Ref: F-xx`、没有本组验证路径的 Group。
- 每个 `AC-xxx` 都有 F-xx 与 Task 归宿；不得只覆盖功能切片标题而遗漏验收项。
- 模板锚点完整：`architecture` / `contract` / `feature` / `roadmap` / `execution-log` / `changelog`。
- 类型名、文件名在全文一致（如 Store/API 命名统一）。

## 代码规范基线

- 生成 plan 时必须先参考 `ai-docs/global-assets/standards/code-style.md` 与 `ai-docs/global-assets/standards/architecture-layers.md`。
- `ai-docs/<需求号>/code-style.md` 只作为本需求新增/覆盖规则的归档材料；不得复制全局规范。
- `[CodeStyle]` 只写本次需求发现的新增横切规则，不写业务枚举、字段或已存在的全局规则。
- 每条 `[CodeStyle]` 必须携带 `(layers: <architecture-layer-id>)`，且 layer 必须来自 `architecture-layers.md`；无法归层时不要写入 CodeStyle 增量。
- `(applies: ...)` 只能使用 layer 的分层级 glob，禁止精细到具体业务模块目录。

## 反模式

### 「契约先写满待确认，Implement 自己猜」

错误。Mock 未授权则 Phase 0 打回；已授权则 §2.1 Mock 表必须可执行，§2.5 集中写差异。

### 「Feature 和 Roadmap 各写一遍设计」

错误。§3 写意图与测试；§4 写文件与步骤。

### 「Plan 里开产品 CQ」

错误。产品问题在 specify 阶段前置澄清；Plan 只处理技术澄清，未闭合问题进入 `.temp/clarifications.json`，闭合后写入 plan §1.3。

### 「只有任务列表，没有 Verify」

错误。每组至少一条 Group Verify；关键 Task 必须有 Step + Verify。

### 「只写人话，丢失 AC 追踪」

错误。Feature、User AC 与 AC 覆盖自检必须保留 `AC-xxx`，同时用简洁自然语言解释覆盖意图。

## 输出契约

`plan.md` 必须包含模板规定的六章及锚点。Roadmap 任务 ID 格式必须兼容 `manage-state.cjs mark-task`。
