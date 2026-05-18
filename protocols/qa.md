# QA Protocol

子代理：`specflow-qa`。派发时以引擎落盘的 `pending-protocol.json` 及本 Schema 为准。引擎在检测到当前 Group 的 `[?]` 任务时自动路由；QA 验收后优先按 Group 批量标记 `[x]`（通过）或 `[!]`（失败）。

## Schema

```json
{
  "requirementId": "<需求号>",
  "task": "verify_implementation",
  "context": {
    "scope": "<待验收的 Group 或任务列表>",
    "planPath": "ai-docs/<ID>/plan.md",
    "focusPlan": "<引擎生成的精简版 Plan>",
    "knowledgeContext": "<引擎注入的知识上下文（局部 Patch / 归档 Patch / 全局资产）>",
    "previousAttempt": "<可选：上一轮失败记录摘要>"
  }
}
```

## 约束

- **focusPlan**：同 Implement Protocol。子代理**仅**使用 focusPlan 获取验收依据（Contract/Test Scope）；**禁止**为本次验收而读取 specify.md 或 plan.md 全文。`planPath` 仅用于写入验收存证或 Failure Report。
- **knowledgeContext**：用于设计更贴近业务规则的验收用例。子代理需标注"本轮验收采用了哪些知识规则"，并据此补强边界/异常用例。
- **相关性决策卡（强制）**：验收前输出 `采用规则(<=3) + 对应检查点 + 忽略理由`；PASS/FAIL 日志中的 Knowledge Rules Used 必须与该决策一致。
- **能力边界（硬性）**：当前**不支持**启动本地服务 / 端到端浏览器验证。任务只有 `[TDD]` 一种特殊标记；其他任务**无标记**，一律按**静态实现证据**验收，**不跑 e2e、不启服务、不调 Browser MCP**。
- **测试执行唯一性（跨阶段去重，硬性）**：同一个 spec 文件在 Implement 与 QA 之间**只执行一次**，禁止重复运行：
  - `[TDD]` 任务：Implement 已完成 Red→Green→Refactor 三段并留证，QA **不重跑**（仅证据可疑时按"证据补录"例外亲跑一次，详见下方）。
  - 非 `[TDD]` 任务：Implement 被禁止新建/修改/运行任何 spec；**测试用例的新增与更新由 QA 负责**（写入项目规范测试目录、遵循项目测试框架约定），随后**按路径**执行一次完成验收；通过后不得再次执行。
- **QA 可改测试，不可改实现（硬性）**：QA 可新增 / 修改 `*.spec.*`、`*.test.*`、`__tests__/**` 下的文件以补强 AC 覆盖；**禁止**修改 `src/` 业务代码（发现 bug → FAIL 打回 Implement 的 `fix` 模式）。
- **两段式验收（硬性）**：
  - **阶段 A · 每批 QA 常规动作**：
    - `[TDD]` 任务：**不重跑**本任务对应的 spec（Implement 已跑过并留三段证据），转而做"证据核对 + 测试质量审查 + 契约/AC 走读"。仅当证据可疑时按"证据补录"例外亲跑一次（见下方 `[TDD]` 任务验收指令）。
    - 非 `[TDD]` 任务：按 plan Test Scope 的 Min spec whitelist 或按 git diff 推断的最小受影响 spec 集 **按路径**跑 + `ReadLints` 变更文件。
    - **禁止**执行 `tsc --noEmit` 或任何项目级 / 模块级 vitest。
  - **阶段 B · 仅最后收口执行一次**：当引擎 context 含 `[FinalQA=true]`（或 `pending-protocol.json` item 含 `finalQa:true`）时，在阶段 A 通过之后**额外执行一次**：① `tsc --noEmit`（最小 project 范围）② plan 中 Final Gate 的回归 spec 白名单（若 plan 未给出则明确在 Log 写"无 Final Gate 白名单，跳过"）。**两段只执行一次**，通过即可 `mark-group ... x`。
  - **Bug Fix 再验收（Re-QA 模式）**：本轮 QA 若是对上一轮失败的复核（`previousAttempt` 非空 / 任务曾为 `[!]`），**固定流程**：先只跑**原失败 spec** → 通过后跑**同模块 2~3 个冒烟 spec**（按 plan 中 Smoke spec whitelist；未给出则按目录就近挑 2~3 个） → **停**。**禁止**回跑整组或项目级测试。
- **Lint 范围（硬性）**：**严禁**执行全量 lint（如无条件 `npm run lint` / `pnpm lint` / `yarn lint`），耗时过长且无必要；**仅**允许对**本轮变更文件**做增量检查，优先级：`ReadLints`（首选，最快）> `lint-staged` / `lint:changed` / `lintChanged` > 手工 `eslint <changed-files>`。类型检查同理：仅在阶段 B 最后收口时执行**一次** `tsc --noEmit`。
- **命令白名单 / 黑名单（硬性）**：
  - 允许：`pnpm vitest <spec-path>`、`pnpm test -- <spec-path>`（**仅**用于非 TDD 任务的白名单 spec，或 TDD 任务的"证据补录"例外）、`pnpm exec eslint <changed-files>`、`ReadLints`，以及阶段 B 的一次 `tsc --noEmit`。
  - 禁止：`pnpm exec vitest run --project=<...>` / `pnpm test`（无路径）/ `jest`（无路径）/ `eslint .` / `eslint src/` / 阶段 A 的 `tsc --noEmit` / **对 `[TDD]` 任务的默认重跑**（默认即不跑，证据可疑时才补录）。
  - 例外：仅当 plan 或需求明确要求（例如"本需求需整库类型回归"）时可例外，且必须在 QA Log 写 `Deviation: <命令> | 原因: <1 句>`；否则判违规回退 Implement。
- **验收证据 (Evidence)**：标记 `[x]` 前，MUST 在 plan.md 的 Log（验收存证区）中附加证据，分两套：
  - **`[TDD]` 任务（纯审，不重跑单测）**：核对 Implement 留存的红-绿-重构三段证据完整且顺序正确；审查测试质量；做契约 & AC 走读。证据包含（a）**三段引用**：指向 plan Log 已有的 Red / Green / Refactor 位置（无需复制）；（b）**测试质量评审结论**：防伪检查通过（无 `expect(true).toBe(true)`、无循环论证、无永真断言）、断言覆盖 AC 关键点；（c）**契约一致性**：spec 断言与 focusPlan Contract 字段/枚举/错误码一致；（d）**AC 走读**：每条 AC 对应 spec 用例 + 实现位置。
  - **其他（无标记）任务**：只需"已实现"的静态证据。包含（a）**实现定位**：按任务列出 `<文件路径>:<起-止行>`（或关键符号）；（b）**契约一致性结论**：逐条核对 Contract 字段/接口/枚举；（c）**静态门禁**：**仅本轮变更文件**的类型检查 / 增量 lint 结论（`ReadLints` 输出为首选）；（d）**AC 覆盖走读**：每条 AC 对应的代码位置与处理方式。**禁止**包含 e2e / 服务启动 / 浏览器脚本日志。
- **回写策略（强制）**：优先 `mark-group`（整组 PASS/FAIL）；若同组存在"部分通过、部分失败"，回退 `mark-task` 按任务分别标记并记录差异原因。若失败原因为代码规范问题，evidence 中追加 `"[CodeStyle] <section>: <rule>"`（可多行），用于自动沉淀到当前需求 `coding-standard-patch.json` 并在归档时并入全局规范。

## `[TDD]` 任务验收指令（**纯审模式 / 禁止重跑单测**）

> **核心原则**：Implement 阶段已完成 Red→Green→Refactor 三段并留证，QA **不再重复执行** `pnpm vitest <spec>`——重复执行对"已通过的单测"无增量价值。QA 的职责是**审计证据 + 审查测试质量 + 走读 AC/契约**。

### QA 动作清单（MUST 全部完成）

1. **三段证据核对（顺序 & 完整性）**：读 plan Log 的 "Implement Evidence / Red · Green · Refactor" 小节：
   - **Red**：存在失败输出（含 `FAIL` / `AssertionError` / `expected ... received ...` / `Cannot find module` / `is not a function` / `is not defined` 等特征），且指向本任务对应的 spec 文件路径。
   - **Green**：存在通过输出（`PASS` / `ok` / `passed`），spec 文件路径与 Red 一致。
   - **Refactor**：明确的重构动作 + 二次 Green 输出，或显式声明"无需重构，理由：..."。
   - **顺序**：三段按 Red → Green → Refactor 依次出现（时间戳 / 行序 / git 提交序任一可佐证即可）。
   - 任一缺失 / 顺序颠倒 / 证据可疑（如 Green 日志与 spec 路径不符、Red 输出被截断至看不出失败关键字）→ **FAIL**（类型：`TDD 证据缺失` / `TDD 证据可疑`）。
2. **测试质量审查（防伪）**：读 spec 源码：
   - 无 `expect(true).toBe(true)` / `expect(anything).toBeDefined()` 等空洞断言。
   - 无循环论证（把被测函数的返回值直接作为期望值，例如 `expect(fn(x)).toBe(fn(x))`）。
   - 无永真断言 / 仅断言 `typeof` 而不校验值。
   - 断言覆盖 `focusPlan` / `specify` 中本任务关联的 AC + 关键边界。
3. **契约一致性**：spec 断言字段/枚举/错误码与 focusPlan Contract 一致；不一致 → FAIL（类型：`契约不一致`）。
4. **AC 覆盖走读**：每条 AC 指向 spec 用例 + 实现位置（文件:行号），写入 Evidence。

### 证据可疑例外（唯一的亲跑场景）

仅当出现以下"证据可疑"情况时，QA 可亲跑**一次**相同 spec 文件作为补录；需在 Evidence 明确标注 `Deviation: 证据补录 | 原因: <Red 输出被截断 / Green 输出与 spec 路径不符 / ...>`：

- Red 或 Green 日志明显截断、缺失特征关键字。
- 日志中 spec 路径与 plan Log 声明不一致。
- 重构后只有动作清单、无二次 Green 输出，且代码审读存疑。

**没有以上异常时，严禁重跑单测**（违反者视为浪费执行预算，但不判 FAIL）。

### 硬禁令

- **严禁**把"再跑一次确认下"作为默认动作——默认即"不跑"。
- **严禁**以 QA 身份修改 spec 或 `src/` 以影响 Green 判定（发现问题只能 FAIL 回 Implement）。

## 其他任务（无 `[TDD]` 标记）验收指令

1. **不启服务、不跑 e2e、不调 Browser MCP**；一律按静态实现证据验收。
2. **最小必要动作**：实现定位（文件 + 行号）→ 契约一致性核对 → **本轮变更文件**的静态门禁（`ReadLints`）→ AC 覆盖走读。
3. **Lint 性能硬约束**：首选 `ReadLints`（最快且天然仅看变更相关文件）；**严禁**触发全量 lint；若项目无 `lint:changed` 类脚本，回退到 `eslint <changed-files>` 显式传文件路径，切勿 `eslint .`。
4. **Implement 自检可复用**：Implement 阶段已贴出的类型 / lint 证据可直接引用，不必重复执行。
5. **不做阶段 B 收口**，除非派发 context 明确含 `[FinalQA=true]`（见"两段式验收"）。
