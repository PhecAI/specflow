# SpecFlow — 编排完整协议

> 由 `orchestrating-specflow` 技能按需加载。路径与脚本均以 **SpecFlow 插件根目录**（`$PLUGIN_ROOT`，含 `tools/`、`protocols/`、`templates/`、`docs/`）为准；与 Cursor / Claude Code 等安装方式无关。

## 目录

- [约束](#约束-constraints)
- [执行协议](#执行协议-execution-protocol)
- [脚本与协议索引](#脚本与协议索引)

---

## 约束 (Constraints)

- **MUST** 每轮对话开始先运行状态观测脚本（`specflow-engine.cjs` / `orchestrator.cjs`），再根据返回行动。
- **MUST** 在 Implement 阶段对当前 Group 遵循**闭环状态机**：当派发 `specflow-implement` 或 `specflow-qa` 时，子代理返回后**同一轮内**再次运行引擎并继续派发，直到出现 anchor/block/init 或 agent 非 implement/qa 或死循环保护，不得在子代理返回后未再跑引擎即结束本轮。
- **MUST** 在 `suggestedAction.type` 为 `anchor` 或 `block` 时：仅向用户展示引擎返回的 `message`/`reason`/引导文案，**立即结束本轮**；禁止在本轮再次运行引擎、manage-state 或派发子代理。（**需求号未确认**时引擎返回 `interaction_required` + `init_requirement_id`，见下表，不适用本条的「仅展示」规则。）
- **STRICTLY PROHIBITED** 在展示 anchor 的同一轮内调用 `manage-state.cjs` 或派发子代理；仅当用户**下一轮**明确回复后，才可执行相应脚本并再次运行引擎。
- **STRICTLY PROHIBITED** 在用户未确认需求号前（脚本返回 `interaction_required` 且 `questions` 含 `init_requirement_id` 时）创建/生成任何文档或调用 specify/plan 子代理。
- **STRICTLY PROHIBITED** 在 `type === 'dispatch'` 时仅以自然语言描述「将派发 xxx 子代理」而不在同一轮内**通过工具显式调用子代理**。
- **MUST** 在 `type === 'dispatch'` 时：先运行 `print-protocol.cjs`（代理核对用 `--agent` 或默认），再**必须通过工具显式调用子代理**完成派发。
- **MUST（对用户会话）**：向终端用户展示时**仅**使用引擎 JSON 中的 `userFacing` 经 `render-user-facing.cjs` 的 Markdown、或 `orchestrator.cjs implement ... --human` 的输出、或 `print-protocol.cjs ... --human`；**禁止**将 `suggestedAction`、`agent` 字段名、脚本路径、原始 `print-protocol` 机读块粘贴给用户。
- **MUST** 当任一脚本返回**非零退出码**时：不得盲目重复执行；展示 `docs/troubleshooting.md` 中对应场景并引导修复后重试。

---

## 执行协议

### 1. 状态感知

- **模式识别**：在调用 `orchestrator.cjs` 之前，结合用户输入推断 `implement` 或 `change`（无法区分时默认 `implement`，必要时下一轮澄清）。若本轮是 **接口/API 文档** 新到、更新或粘贴（与 PRD 变更同属 **需求变动**），优先按 **change**（`sync-document`，常见 `--target plan` 或 `both`）处理，再 `implement`；**不要**把「补接口文档」默认当成纯实现推进。
  - implement: `node "$PLUGIN_ROOT/tools/orchestrator.cjs" implement [<workspaceRoot>] <需求号>`
  - change: `node "$PLUGIN_ROOT/tools/orchestrator.cjs" change [<workspaceRoot>] <需求号> <payload> --target specify|plan|both --change-type ... --updates '...'`
- **需求号**：有则传入；否则不传，由脚本探测。
- **变更拦截**：用户要求直接改代码/接口/字段/交互，且处于 Implement 且未通过 `sync-document` 同步时，**禁止**直接改代码；引导 `syncing-specflow-docs` 流程。
- **init（需求号）**：已由引擎统一为 **`interaction_required`**，包含 **`init_requirement_id`（可选，至多 2 个单选）** + **`init_requirement_text`（必有，手动输入，引擎标注 `responseType: 'text'` 以提示输入框）**。编排合并规则：**若 `init_requirement_text` 非空**，以其为准作为需求号；否则取 `init_requirement_id` 所选。元数据见 `init_context`。确认需求号前禁止创建文档或派发 specify/plan。
- **阶段显式化**：引擎会输出 `Init / Specify / PlanReadiness / Plan / Implement / Archive`。`PlanReadiness` 负责技术方案前置评审、技术澄清与开始 Plan 的用户确认；真正进入 `Plan` 时才派发 `specflow-plan`。
- **Plan 进入确认（尚无 plan.md）**：**仅当正式 `specify.md` 无未闭合 `[?]`、`canProceedToPlan` 为真，且 Plan Readiness 当前快照通过时**才会出现 `confirm_start_plan`；`confirm_start_plan` 选确认 → `manage-state.cjs ack-specify-before-plan ...` 后再跑引擎；若之后修改 `specify.md`，确认会因快照不一致失效并要求再次确认。未闭合澄清应存在于临时澄清状态或最小草稿中，编排不得跳过。
- **Plan（无接口/字段依据）**：若规格与可引用材料中**仍无可落地**的接口与字段变更说明，`specflow-plan` **必须**生成技术澄清状态并结束本轮；**禁止**先写满 `plan.md` 再靠猜测字段与接口进入实现。用户闭合澄清后再派发 plan，结论写入 plan §1.3。
- **Implement / Group**：`confirm_start_group` 选 **自动托管** → `set-active-group <id> --auto`（`autoProceedGroups=true`），后续 Group 边界**免确认**直至完成；仅 **确认**（不带 `--auto`）则**每个**新 Group 都弹窗。取消托管：再次 `set-active-group <id>` **不带** `--auto`。
- **Group 确认**：`manage-state.cjs set-active-group ...` 后再跑引擎。
- **归档锚点（Archive）**：Roadmap 全绿后，引擎**不自动**开始任何合并/归档子代理，也**不弹 AskQuestion**；而是返回 `type: 'anchor'` + `next.action: 'set-archive-anchor'` 的文字提示。理由：测试期间需求可能仍在变动，过早合并知识/代码规范会把未冻结的结论灌入全局资产。编排层见到此 anchor **只展示文字并结束本轮**；当用户下一轮明确表达归档意图（「开始归档」「确认归档」等）后，再调 `manage-state.cjs set-archive-anchor [workspaceRoot] <需求号>` 并跑引擎；后续才会依次 `dispatch`：`specflow-domain-explorer`（Merge）→ `specflow-knowledge-reviewer` → `specflow-archive`。历史需求（`inHistory=true`）跳过此锚点直接 dispatch `specflow-archive`。
- **资源失败**：见 `docs/troubleshooting.md` 与 `resource-load-failed.json`。
- **业务知识库（尚无 `specify.md`）**：不再弹出旧单 slug 交互。引擎按需求内流程初始化知识库，领域身份统一为 `<scope>::<slug>`（如 `services/order::payment`），确认结果写入 `domainInitRefs`；若 `ai-docs/<需求号>/business-domains/<scope__slug>.md` 缺失时先 `dispatch specflow-domain-explorer`，完成后再 `specflow-specify`。

### 2. 行为决策

真相源：业务进度以 **`specify.md` / `plan.md`** 为准；编排门闩以 **`ai-docs/<需求号>/.temp/specflow-state.json`** 为准（字段与清洗见 `specflow-state.cjs`）。


| suggestedAction.type   | 动作 |
| ---------------------- | ---- |
| `dispatch`             | 运行 `print-protocol.cjs`（代理侧默认/`--agent`），再**显式调用**子代理（名称 = `suggestedAction.agent`）。对用户会话使用 `userFacing` / `--human` 渲染。 |
| `interaction_required` | **编排代理 MUST：在 Cursor 等对 `AskQuestion` 可用时，必须先调用 `AskQuestion`**，用引擎 JSON 的 `questions`（含 `confirm_start_plan` / `confirm_start_group` / `CQ-*` / 需求号 `init_requirement_*` 等）弹窗；**禁止**仅用聊天文字罗列选项代替工具。**注意**：归档入口已改为 `anchor`（不是 `interaction_required`），由用户主动表达归档意图后编排层再调 `set-archive-anchor`；见「归档锚点」段。拿到返回值后按 **question id** 处理（`manage-state` 参数顺序均为：`<workspaceRoot> <需求号> …`）：① **需求号**：`init_requirement_text` 非空则以其为需求号再跑 `specflow-engine`；否则用 `init_requirement_id` 所选。② `confirm_start_plan`：选 `confirm` 则执行 `PLUGIN_ROOT=/path/to/specflow node "$PLUGIN_ROOT/tools/manage-state.cjs" ack-specify-before-plan [workspaceRoot] <需求号>` 后再跑引擎；选 `cancel` 则结束本轮（先改 `specify.md`）。③ `confirm_start_group`：选 `confirm` 则 `set-active-group <groupId>` 后再跑引擎；选 `auto_proceed` 则 `set-active-group <groupId> --auto` 后再跑引擎。④ `CQ-*`（及配套的 `CQ-*__detail` 补充输入）：**优先**由用户在 AskQuestion/聊天中点选或填写；编排/助手将**点选结论与 `__detail` 文本**合并写入 `specify.md` 的 `#### **[User]:**`（**不要**默认要求用户亲手改 Markdown；无 AskQuestion 时再按文案等价收集）后跑引擎。⑥ `retry_limit_exceeded`：选 `reset_retry` 则 `reset-retry` 后跑引擎；`show_logs` / `force_pass` 按文案引导。**仅当环境确认无 AskQuestion 时**，才用 `prompt`/`options` 纯文案等价展示。 |
| `block`                | 展示 `reason`，禁止写操作与委派。 |
| `anchor`               | 展示 `message`，结束本轮。 |
| ~~`init`~~             | **已废弃**：需求号选择已合并至 `interaction_required`（`init_requirement_id`）。 |


**派发（代理侧）**：任务说明 = `print-protocol.cjs --agent` 输出 + `pending-protocol.json` 的 context / focusPlan / focusSpecify / focusArchive。**用户侧**仅展示 `userFacing` 渲染结果（或 `print-protocol.cjs --human`），保持渐进披露。

**锚点**：仅当用户在上轮看到锚点话术后本轮明确回复（如「继续」「归档」），再执行对应 `manage-state.cjs`，再跑引擎。

### 3. 同轮闭环与连续派发

- dispatch implement/qa/domain-explorer 后，子代理返回 → **同一轮内**再跑 `specflow-engine.cjs`，直到出现停止条件。
- `dispatch_array`（自动托管下 per-group 快照混合派发）：
  - 数组元素按各 Group 当前快照派 `specflow-implement`（含 Bug Fix 模式）或 `specflow-qa`，同一批可混合，每个元素带 `groupId` 与独立 `focusPlan`。
  - 调度遵循 `waitPolicy=any_done`：任一 Group 子代理返回后即先跑引擎，优先推进该 Group 下一步；**禁止**等待同批其他 Group 全部完成才继续。
  - **per-group 的 implement→QA→fix→QA 闭环由引擎在连续快照派发中推进**，不再引入"pipeline 中间子代理"；A/B/C 仅共享需求上下文，不存在跨 Group 完成依赖。
  - `pending-protocol.json` 为 `{ kind: 'dispatch_array', items: [...] }`；需要查看具体 Group 的 focusPlan/上下文时：`node print-protocol.cjs ... --group <GroupId>`。
- 停止条件：`anchor` / `block` / `interaction_required`（含需求号 init 弹窗）/ agent 并非自动闭环类型 / `groupRetryCount > 3`。

### 4. 任务状态机

Roadmap 任务复选框通过 `manage-state.cjs` 变更：**优先 `mark-group` 进行 Group 闭环**（整组送测/通过/失败），仅在同组混合结果等特殊场景回退 `mark-task`。详见 `tools/README.md`。

### 5. 特殊流程

- 外部 URL：飞书优先 MCP；失败写入 `resource-load-failed.json`。
- 需求变更：构造 `--updates`，运行 `sync-document.cjs`，再跑引擎。细节见技能 **syncing-specflow-docs**。

---

## 脚本与协议索引

- **脚本**：`tools/README.md`（直接执行目标脚本，勿跳过 orchestrator/change 分流）。
- **协议 JSON**：`protocols/specify.md`、`plan.md`、`implement.md`、`qa.md`、`archive.md`。
- **故障排查**：`docs/troubleshooting.md`。
