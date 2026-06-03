---
name: orchestrating-specflow
description: Use when Specflow is active and the current turn should advance the workflow by running orchestrator/engine and acting on suggestedAction; do not use when you are a dispatched phase subagent (specflow-implement/qa/etc)
---

# 编排 Specflow

**低自由度 / 机器可验证路径**：只运行打包脚本，不要临场改流程顺序。

## Overview

本技能负责把脚本输出的 `suggestedAction` 变成**可验证动作**（派发/结束本轮/闭环），避免“凭感觉推进”。

**Core principle：** 引擎说什么就做什么；引擎让停就停。

**入口意图（与 `using-specflow` 对齐）**：在跑 `orchestrator implement` 之前，若用户带来的是 **接口/API 文档补全或更新**，应视为 **需求变动中的合约变更**，先走 **`orchestrator change` + `sync-document`**（`syncing-specflow-docs`），再进入本技能的实现闭环；引擎本身不会自动检测外部文档，**编排侧**必须在入口完成归类。

**派发 specflow-specify 时（可选但推荐）**：若你已知本仓库仅为 **前端 / 后端 / 移动端** 等，在子代理 Prompt 中**用一句话写明「本项目职责边界」**（例如「本仓仅 Web 前端，不写服务端实现」），可显著减少 PRD 非结构化时的跑偏；与 `agents/specflow-specify.md` Phase 0 对齐。

**Violating the letter of this process is violating the spirit of this process.**

---

## The Iron Law

```
每个要推进流程的回合：
必须运行 `orchestrator.cjs` 并依据 suggestedAction 行动。

STRICTLY PROHIBITED：在未获取 suggestedAction 的情况下执行 dispatch、manage-state 或写生产代码。
STRICTLY PROHIBITED（Cursor Agent）：dispatch 时主会话直接读写实现文件——
  dispatch = Task tool call，subagent_type = suggestedAction.agent；
  主会话本轮禁止直接操作仓库代码/规格文档，违者视为绕过子代理闭环。
```

---

## Human-in-the-loop：AskQuestion 优先（与引擎 `interaction_required` 对齐）

当 `suggestedAction.type === 'interaction_required'` 且 `questions` 非空时，本轮属于 **必须人机确认**；在 **Cursor Agent**（及一切提供 **`AskQuestion` / 多选提问工具** 的环境）中：

- **MUST** **先调用 `AskQuestion` 工具**，用引擎给出的 `questions`（含 `id`、`prompt`、`options`）发起选择；**再**根据返回值执行 `manage-state` / 再跑引擎 / 或让用户补充输入。
- **STRICTLY PROHIBITED** 仅用自然语言把选项复述一遍、假装「已询问用户」却**不调用** `AskQuestion`（除非当前环境**确认不存在**该工具——此时才允许用 `prompt`+`options` 纯文案等价展示）。

涵盖的 **`questions[].id`**（引擎侧，含澄清 CQ 动态 id）：`init_requirement_id`（至多 2 候选）、`init_requirement_text`（`responseType: 'text'` 手动输入框）、`confirm_start_plan`、`confirm_start_group`、`retry_limit_exceeded`、以及 **`CQ-*`**（澄清点选）、**`CQ-*__detail`**（`responseType: 'text'`，与 `CQ-Contract*` / `CQ-Tech-*` 非 Init 配套，供「其他」或补充说明）。需求号合并：**`init_requirement_text` 非空优先**。业务知识库在无 `specify.md` 时由引擎默认按需求内流程自动初始化（默认领域 `general`）。归档入口**不**走 `interaction_required`——Roadmap 全绿后引擎返回 `anchor` 文字提示，由用户主动表达归档意图后编排层再调 `set-archive-anchor`（见下文「归档锚点」段）。

对 **`CQ-*` / `CQ-*__detail`**：用户点选、输入框文字或聊天输入后，**由编排/助手合并写入** `specify.md` 的 `#### **[User]**` 再跑引擎；**默认不要求**用户自己打开文档编辑（与 `agents/specflow-plan.md` 中「少让用户操作文档」一致）。

**Red Flag：**「进 Plan / 进 Group / 归档 / 选需求号」用聊天问一句代替工具 —— **停止**，回到上条 MUST。

---

## 执行协议（决策流）

## 检查清单（建议复制并逐条核对）

```
Specflow 编排：
- [ ] 区分 implement（实现） vs change（变更），并用正确参数运行 orchestrator
- [ ] 不走冷启动；知识库与规范统一在需求迭代（change/implement）过程中持续更新
- [ ] 若为 dispatch：先运行 `print-protocol --agent`（或 `--task-prompt` 获取 Task 调用模板），对用户会话仅展示 `userFacing` 渲染或 `print-protocol --human`；再用 **`Task` tool**（`subagent_type=suggestedAction.agent`，`prompt` 含 print-protocol 输出）显式调用子代理；**禁止主会话直接写实现文件**（不要只描述，不要主会话包办）
- [ ] 若为 dispatch_array（**自动托管下的 per-group 快照派发**）：数组内每个元素带 `groupId` / `agent` / 独立 `focusPlan` / `dependsOn`；这是用户选择自动托管后的高级模式，默认单 Group 确认模式不会触发。**执行规则**：① item.dependsOn 为空且无明显文件/契约冲突 → 可在同一消息内并行发起多个 `Task` tool call（每批最多 2 个）；② item.dependsOn 非空或存在共享容器/Mock/API contract → 串行调用；按 `waitPolicy=any_done`：任一 Task 返回即先跑一轮引擎，仅推进该 Group 的下一步。**每个 Group 的 implement→QA→fix→QA 闭环独立运行**
- [ ] 若为 anchor/block：对用户只展示 `userFacing` / `fallbackMessage` 或引擎 `reason` 的**人话润色**，然后结束本轮（不要 manage-state / 不要同轮 dispatch）；**禁止**向用户粘贴 JSON 或 `suggestedAction` 字段名
- [ ] 若为 interaction_required：**必须先 AskQuestion**（用引擎 JSON 的 questions）；无 AskQuestion 工具时才用文字等价展示；**禁止**只复述选项不调工具
- [ ] 若 implement/qa 的 dispatch 返回：同一轮内再次运行引擎直到停止条件
- [ ] 若 implement/qa 的 dispatch/dispatch_array 返回：同一轮内再次运行引擎直到停止条件
- [ ] 任一脚本非零退出码：直接看 troubleshooting.md，不要盲目重试
```

```mermaid
flowchart TB
  start([Start turn]) --> run[Run orchestrator.cjs\nRead engine JSON]
  run --> t{suggestedAction.type?}

  t -->|anchor| a[Show message\nEnd turn]
  t -->|block| b[Show reason\nEnd turn]
  t -->|interaction_required| ir[MUST AskQuestion tool\nwith engine questions;\nelse text fallback only\nif tool missing]
  ir -->|Tool Result: init_requirement_id| i_res[Run engine with chosen ID\nor ask for text input]
  ir -->|Tool Result: CQ-*| cq_res[Update specify.md\nRun engine]
  ir -->|Tool Result: confirm_start_plan| sp_ack[manage-state.cjs ack-specify-before-plan\nRun engine]
  ir -->|Tool Result: start_group| sg_res[manage-state.cjs set-active-group\nRun engine]
  ir -->|Tool Result: auto_proceed| sg_auto_res[manage-state.cjs set-active-group --auto\nRun engine]

  t -->|anchor next=set-archive-anchor| ar_wait[Show message;\nWait for user intent 归档]
  ar_wait -->|User confirms archive next turn| ar_trigger[manage-state.cjs set-archive-anchor\nRun engine]

  t -->|dispatch| p[print-protocol --agent\n+ userFacing/render for user]
  p --> call[Explicitly dispatch subagent\n(suggestedAction.agent)]
  call --> loop{agent is specflow-implement\nor specflow-qa\nor specflow-domain-explorer?}
  loop -->|no| end([Stop for this turn])
  loop -->|yes| again[Same turn:\nrun engine again]
  again --> t
```



---

## 架构师反向打回（强制门禁，含接口/对接文档补全）

**Iron Law：** Specify 阶段澄清的单一真相源是 `.temp/clarifications.json`。只要其中存在未闭合澄清，引擎 **全局**返回 `interaction_required`，**先于** Plan / Implement / Archive。编排 **MUST** 先 `AskQuestion` 或等价收集用户决策；**STRICTLY PROHIBITED** 跳过澄清、由主对话代答、或继续派发 plan/implement。

- **澄清回答写回（强制顺序）**：用户回答 AskQuestion 后，编排层必须调用 `manage-state.cjs answer-clarification [workspaceRoot] <需求号> <cqId> "<answer>"` 写回 `.temp/clarifications.json`，然后重新运行引擎。编排层不得直接派发 `specflow-specify`，不得把答案只写在聊天上下文里。
- **澄清闭合后**：引擎检测到 json 全部闭合后，会自动派发 `specflow-specify`，并在 dispatch context 中注入已闭合答案摘要。Agent 只能读取 json / context 中的 `answer`，不得根据对话历史猜测答案。

- **Plan 前架构评审（机器顺序）**：尚无 `plan.md` 且规格已就绪时，引擎 **先** `dispatch` **`specflow-specify-review`**（`agents/specflow-specify-review.md`）。无阻塞则子代理执行 `manage-state.cjs ack-specify-review <confirmed|mock_allowed|not_required>`，写入 `gates.json: plan.readiness_review`（兼容写旧 state）；**之后**才可能出现 `confirm_start_plan`，再 `specflow-plan`。`specify.md` 变更导致快照不一致时，须重新评审。有阻塞则必须生成技术澄清状态，并执行 `mark-specify-review-blocked`；未闭合前不允许进入 Plan。
- **机制**：`specflow-plan` 按 `agents/specflow-plan.md` 生成技术澄清状态（接口文档缺失、对接信息不足、**接口/字段依据不足**等）并结束、不写 plan → 下一轮引擎 `interaction_required` 或 block，直至闭合。
- **契约**：若用户未提供可落地的接口/字段变更依据，**禁止**在 `plan.md` 中臆造 Contract；必须先打回技术澄清。
- **plan 已存在** 又新增 CQ 时：**`gates.planExistsWhileSpecifyIncomplete`** 为真；`dispatch` → `specflow-specify` 的 `context` 含 **强制**对齐说明；闭合后 **`sync-document`** 或重跑 Plan。
- **引擎已加强**：未闭合 `[?]` 的 `reason`、`specify-plan` 的 dispatch `context` 均标明不可跳过；Implement 入口含防御性 **block**（防漏网）。
- **子代理**：`dispatch` 仍须 **print-protocol + 显式子代理**；用户可见文案由 `user-facing.cjs` 统一渲染，避免为单一内部状态新增模板文件。

## Group 确认与自动托管（状态：`autoProceedGroups`）

- **未托管**（`autoProceedGroups=false`）：每个新 Group 在 `activeGroup` 与 `nextPendingGroup` 不一致时，引擎 **`confirm_start_group`**。
- **自动托管**（用户在弹窗选「自动托管」→ `manage-state.cjs set-active-group <id> --auto`）：置 `autoProceedGroups=true`，后续 Group **静默对齐** `activeGroup`，**不再弹窗**，直至任务全部跑完或用户用 **不带 `--auto` 的 `set-active-group`** 清回单 Group 模式（`manage-state` 会 `autoProceedGroups=false`）。
- **自动托管下的并行派发（per-group 快照）**：引擎在每一轮根据所有未完成 Group 的**当前快照**产出 `dispatch_array`——按 Group 状态分别派 `specflow-implement`（含 Bug Fix 模式）或 `specflow-qa`，同一批内**可以混合**（例如 A 已经 `[?]` 派 `specflow-qa`，B 还在 `[ ]` 派 `specflow-implement`）。这是自动托管下的提效能力，不是默认执行方式；每批最多 2 个 Group。编排层按 `waitPolicy=any_done` 执行：谁先返回先推进谁，不等待其余 Group；每次推进后立刻再跑引擎生成该 Group 的下一步。
- **per-group 闭环由引擎在快照间推进**：单个 Group 的 `implement → QA →（失败则 Bug Fix → QA）` 不再由额外的"pipeline 子代理"串起来，而是引擎在连续快照派发中自然形成。执行顺序以 Group 为单位独立闭环：A/B/C 可交错推进，但互不阻塞、互不等待。
- **Cursor Agent 并行/串行执行规则**：`dispatch_array` ≠ 必须并发——编排层**必须**主动判断：
  - items 中所有 `dependsOn` 均为空，且 focusPlan Files/Local Contract 不重叠 → 可在**同一消息**内并行发起多个 `Task` tool call（每 item 对应一个 Task，最多 2 个）
  - 任一 item 含非空 `dependsOn`，或存在共享页面容器/聚合文件/Mock/API contract → 按依赖顺序**串行**调用 Task，依赖方先完成再启动被依赖方
  - 引擎已在 items 中附带 `dependsOn: string[]`（由 plan.md Group 标题中"依赖 Group X"声明解析）
- **协议落盘**：`dispatch_array` 以 `{ kind: 'dispatch_array', items: [{ groupId, agent, context, focusPlan, dependsOn }] }` 写入 `pending-protocol.json`；每个元素自带 per-group `focusPlan` 与 `dependsOn`；需要单独查看某个 Group 的派发协议可用 `print-protocol.cjs ... --group <GroupId>` 过滤；用 `--task-prompt` 可直接输出 Task tool 调用模板（含并行/串行标注）。

## 归档锚点（门禁：`archive.user_anchor`）

- **Roadmap 全绿 ≠ 可归档**：测试期间仍可能产生需求变更，过早合并知识库/代码规范会把"未冻结"的产物灌入全局资产。因此引擎 **不自动开始合并，也不弹 AskQuestion**。
- **引擎侧**：当所有 Group 完成、`archive.user_anchor` 未通过时返回 `anchor`（`next.action === 'set-archive-anchor'`），并在 `message` 里说明「请在确认测试通过、需求不再变更时主动告知归档」。
- **编排侧**：
  - 收到此 anchor **只展示文字**，结束本轮；**不要**在此时自动调 `set-archive-anchor`；**不要**派发任何子代理。
  - 下一轮当用户明确表达归档意图（例如「开始归档」「确认归档」「现在归档吧」等），编排层调 `manage-state.cjs set-archive-anchor [workspace] <需求号>`，再跑引擎。
- **锚点落地后**：引擎依次 `dispatch`：`specflow-domain-explorer`（Merge，完成后写 `archive.domain_merged`）→ `specflow-knowledge-reviewer`（完成后写 `archive.knowledge_reviewed`）→ `specflow-archive`；全局资产合并由 `specflow-archive` 统一执行，任何 merge 步骤都**不会**先于 `set-archive-anchor` 发生。
- **历史需求（`inHistory=true`）**：跳过归档锚点（已归档材料复审场景，不引入人机确认）。

## Constraints

- **MUST** 对用户展示**仅**使用引擎渲染后的 `userFacing` / `--human` 文案；**用户可见用语**以 `docs/user-facing/VOICE.md` 为准（禁止向用户堆内部字段名、脚本名、CQ/锚点等，见该文件）。
- **MUST** 在总结子代理产出、或向用户说明「下一步」时，同样遵守 `VOICE.md` 与对应 `completion-output-*.md`：**禁止**把 `manage-state`/`confirm_*`/路径/脚本名等运行机制写进对用户可见段落（见 `VOICE.md` 第 2.1 节）。
- **MUST** `dispatch` → 先 `print-protocol.cjs`（代理核对，可加 `--task-prompt` 获取 Task 调用模板），对用户会话用 `userFacing`/`render-user-facing` 或 `--human`；再用 **`Task` tool**（`subagent_type=suggestedAction.agent`）显式派发子代理；**主会话本轮禁止直接操作实现文件**（不要只描述，不要主会话包办）
- **MUST** `anchor/block` → 对用户只展示人话（`userFacing` / 润色后的 `reason`）并结束本轮（不要同轮 manage-state / dispatch）
- **MUST** `interaction_required` → **先 `AskQuestion`**（`init_requirement_id` / `confirm_start_plan` / `confirm_start_group` / `CQ-*` / `retry_limit_exceeded` 等）；**禁止**仅用聊天复述选项；无 AskQuestion 时再展示 `prompt`/`options`
- **MUST** Archive 阶段的 `anchor(next.action='set-archive-anchor')` → 仅展示文字提示并结束本轮；**禁止**同轮自动调 `set-archive-anchor`；**禁止**在用户未主动要求归档前派发 domain-explorer / knowledge-reviewer / archive 任一子代理
- **MUST** implement/qa 返回 → **同一轮内**再次运行引擎直至停止条件（anchor/block/interaction_required/非 implement|qa/重试超限）

---

## Red Flags — 出现以下念头时立即停止

- “我先把下一步派发说一下，工具调用等会儿再做”
- “进 Plan 我直接问用户一句话就行，不用 AskQuestion”
- “锚点我顺手把 manage-state 也做了吧”
- “子代理已经回来了，这轮可以收工了”
- “我不用 print-protocol，直接告诉子代理做什么”
- “反向打回的 CQ 我先帮用户选一个，好快点进 Plan”
- “接口文档缺就缺，plan 里先瞎写一个接口继续实现”
- “规格里没写字段名，我帮用户在 plan 里编一套字段和接口先开发”
- “主会话直接读 plan.md 改代码比调 Task 快，dispatch 这一步我跳了”
- “dispatch_array 出来了，我不看依赖和文件冲突就全并行”

**以上所有念头都意味着：停止，回到 suggestedAction 分支决策，按协议执行。**

---

## Common Rationalizations


| Excuse                    | Reality                                    |
| ------------------------- | ------------------------------------------ |
| “print-protocol 太麻烦，省略也行” | 省略会导致任务上下文丢失/偏航，闭环不可验证                     |
| “锚点顺手推进更快”                | 锚点的存在就是为了等 your human partner 确认；同轮推进会破坏协议 |
| “这一轮不必再跑引擎”               | implement/qa 的闭环靠“同轮再跑引擎”保证，不跑就会半途而废       |
| “主会话做比 Task 快，省略 dispatch” | 省略 Task 破坏隔离上下文与闭环验证；子代理才是执行主体，主会话是编排者 |
| “dispatch_array 一定要全并行”      | 只有无依赖、无文件/契约冲突时才并行；否则管理成本和冲突风险会超过收益      |


---

## Quick Reference


| suggestedAction.type        | 操作                         |
| --------------------------- | -------------------------- |
| `dispatch`                  | `print-protocol.cjs --agent`（或 `--task-prompt` 获取 Task 调用模板）→ 用 **`Task` tool**（`subagent_type=agent`）显式派发；**主会话禁止直接实现**；对用户用 `userFacing`/`--human` |
| `interaction_required`      | **必须先 `AskQuestion`**（用引擎 `questions`）；**禁止**仅用聊天罗列选项代替工具调用。① 需求号：`init_requirement_text` 非空优先，否则 `init_requirement_id`。② `confirm_start_plan` → `confirm` 则 `manage-state.cjs ack-specify-before-plan` 再跑引擎。③ `confirm_start_group` / `CQ-*` / `retry_limit_exceeded` 见 `orchestration-full.md`。仅当环境无 AskQuestion 时用文案等价。 |
| `anchor`（一般）           | 只展示 message/reason，引导并结束本轮 |
| `anchor(next.action='set-archive-anchor')` | 只展示 message（归档入口）；**本轮不得** dispatch 或调 manage-state；待用户主动表达「归档」意图后，下轮调 `manage-state.cjs set-archive-anchor` 再跑引擎 |
| `block`                     | 只展示 reason，引导并结束本轮 |

### `orchestrator` 模式补充（知识闭环）

- 不使用 `init --scan` 作为主流程入口；知识骨架与规范基线通过 `change/implement` 在需求迭代中持续沉淀（`inventory-scan` 仅保留为独立按需工具）。
- `change`：默认执行文档同步并提取 patch（`--extract`），供后续注入与归档演进使用。
- `implement`：读取引擎建议；若有知识上下文，应透传给下游子代理。


---

## 完整协议

若要了解约束、锚点规则、Group 闭环、任务状态机等细节，请阅读：

**[docs/orchestration-full.md](../docs/orchestration-full.md)**

## 索引

- 脚本：`tools/README.md`
- 协议 Schema：`protocols/*.md`
- 故障排查：`docs/troubleshooting.md`
