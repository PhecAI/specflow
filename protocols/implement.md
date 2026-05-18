# Implement Protocol

子代理：`specflow-implement`。派发时以引擎落盘的 `pending-protocol.json` 及本 Schema 为准。

## Schema

```json
{
  "requirementId": "<需求号>",
  "task": "implement_group",
  "context": {
    "targetGroup": "<Group ID>",
    "mode": "normal | fix",
    "focusPlan": "<引擎生成的精简版 Plan>",
    "knowledgeContext": "<引擎注入的知识上下文（局部 Patch / 归档 Patch / 全局资产）>",
    "knowledgePolicy": {
      "required": true,
      "decisionCardFormat": "任务意图 | 采用规则(<=3) | 忽略规则及理由",
      "logRequirement": "Ready-for-QA 或 QA Evidence 中必须回填 Knowledge Rules Used"
    },
    "bugContext": "<可选：引擎 context 中的 Bug Fix 信息>"
  }
}
```

## 约束

- **mode**：`normal` = 编码新任务（`[ ]`→`[?]`）；`fix` = 根据 QA Failure Report 修复（`[!]`→`[?]`）。引擎 context 含 Bug Fix 时为 fix。
- **状态回写策略**：默认使用 `manage-state.cjs mark-group <groupId> ready-for-qa` 进行整组送测（一次 verify）；仅在同组混合结果等特殊场景回退 `mark-task` 按任务标记。
- **focusPlan**：MUST 将 `suggestedAction.focusPlan` 透传至 `context.focusPlan`。子代理**仅**使用 focusPlan 完成本 Group 任务，**禁止**为完成本 Group 而读取 specify.md 或 plan.md 全文（以节省上下文与 Token）。
- focusPlan 含：全局 Scope、当前 Group 的 Feature（Design/Contract/Test Scope）、Active Group 任务列表、Log 存证。
- **knowledgeContext**：MUST 参与实现决策，但不是“照单全收”。子代理需做二次筛选（适用/不适用），仅采用与当前任务相关的规则，并在 Log 中记录“采用了哪些知识规则 + 为什么”。
- **相关性决策卡（强制）**：编码前先生成 `任务意图 + 采用规则(<=3) + 忽略规则及理由`，并在 Ready-for-QA 日志中回填一致的规则清单。

## 静态门禁（硬性，Implement 阶段默认零测试）

Implement 阶段的目标是**完成编码 + 最小证据**，完整验证留给 QA 关口统一执行。本阶段的静态检查必须满足：

### 两条全局硬约束（违反即判 Bug Fix 回滚）

1. **测试执行唯一性（跨阶段去重）**：同一个 spec 文件在 Implement 与 QA 之间**只执行一次**。
   - `[TDD]` 任务：由 Implement 执行（Red→Green→Refactor 三轮），QA **不重跑**（详见 `qa.md`）；
   - 非 `[TDD]` 任务：由 QA 执行（按 Min spec whitelist / git diff 推断），Implement **不跑、不改、不新建任何测试文件**。
2. **禁止全量 lint**：只允许 `ReadLints <changed-files>` / `pnpm exec eslint <changed-files>` 增量形式；仓库级 `npm/pnpm/yarn run lint`、`eslint .`、`eslint src/` 一律禁止。

### 允许的静态检查

- **首选顺序**：`ReadLints <changed-files>`（IDE 内存诊断，最快、零命令）→ 不足时再 `pnpm exec eslint <changed-files>`（字面 changed-files 或明确 glob，支持 `--fix`）
- **仅 TDD 任务**（Test Scope 含 `[TDD]`）才运行测试，且 **只跑本任务对应的单个 spec 文件**（Red → Green → Refactor 三轮都只用这一个文件路径）

### 硬性禁止清单

- `pnpm test`（无路径）/ `npm test` / `yarn test`
- `pnpm exec vitest run --project=<...>` / `vitest run`（无路径）/ `jest`（无路径）
- `eslint .` / `eslint src/` 等目录级或项目级 lint
- `npm/pnpm/yarn run lint`（仓库级全量 lint 脚本）；仅允许 `lint:changed` 等增量脚本
- `tsc --noEmit`（全量类型检查，留给 QA 最后收口）
- 任何启动本地 dev server / 端到端测试 / Browser MCP 的操作
- **非 `[TDD]` 任务下** 新建 / 修改 / 运行任何 `*.spec.*`、`*.test.*`、`__tests__/**` 文件（测试用例归属 QA）

### 例外

如确实需要违反上述清单（例如跨文件重构引发的连锁编译错误），必须在 plan Log 的 Implement Evidence 区写明：
  `Deviation: <命令> | 原因: <1 句> | 范围: <涉及文件数>`

## TDD 模式指令 (Test Scope 含 [TDD] 时 MUST 遵守)

必须按 **红 → 绿 → 重构** 三段**严格顺序**走完，且每段都在 plan Log 留下证据。

### 核心语义（MUST 理解正确）

- **Red 阶段的失败是 "预期状态"，不是 Bug**。因为业务代码尚未实现，测试**必须失败**；这正是 TDD 的第一步红。
- **严禁**"写完测试一看失败就立即编码/改测试去消除失败"——这会跳过 Red 落盘，直接混入 Green，破坏红绿证据链。
- **三段必须按顺序**：`Red 证据落盘 → 再开始 Green 编码 → Green 证据落盘 → 再做 Refactor`。任何顺序倒置或阶段合并都视为违规，QA 判 FAIL 回 `fix` 模式。

### 具体步骤

1. **先写测试 (Red-Setup)**：在项目规范测试目录（如 `__tests__/unit/`、`tests/`、`spec/`）创建测试文件，断言业务逻辑与 AC 边界。**此时 `src/` 不得有任何实现改动。**
2. **验证失败 (Red)**：**只**跑本任务新增的那一个 spec 文件路径（例如 `pnpm vitest <file>` 或等价命令），确认失败（`FAIL` / `AssertionError` / `expected ... received ...` / `Cannot find module` / `is not a function`）；若一上来就过，必为断言无效，**重写测试**（不是实现）。**禁止**使用项目级 / 模块级（`vitest run --project=...`）或无路径命令。**MUST** 把 Red 终端输出作为代码块写入 plan Log 的 "Implement Evidence / Red" 小节。**Red 证据未落盘前，不得开始第 3 步。**
3. **编写实现 (Green-Setup)**：Red 证据落盘**之后**，编写 `src/` 下的最小可用代码使测试通过，**不过度设计**。
4. **验证通过 (Green)**：**仍然只跑同一个 spec 文件**至全绿；失败则**修正实现代码**直至通过（**不得**为了通过而弱化或删除测试断言）。**MUST** 把 Green 终端输出写入 plan Log 的 "Implement Evidence / Green" 小节。
5. **重构 (Refactor)**：在 Green 基础上做小步重构（消除重复 / 抽函数 / 命名 / 分层）；重构后**必须重跑**同一个 spec 文件保持全绿（仍然**不跑**整个项目或模块级测试）。**MUST** 在 plan Log 的 "Implement Evidence / Refactor" 小节中二选一：
   - 列出重构动作清单 + 重跑 Green 的终端输出；或
   - 明确写 `无需重构，理由：<简短说明>`（例如"实现已是单一 pure function，无重复"）。
6. **交付**：把测试文件路径、三段证据写入 Log，再用 `mark-group <groupId> ready-for-qa` 送测。

### 硬禁令（违反即判 Bug Fix 回滚）

- Red 阶段写测试**同时**动 `src/` 业务代码（等价于跳过 Red，直接到 Green）。
- Red 运行出现失败**立即**改测试去消除失败（测试写错是少数情况，多数是实现未就绪——先落盘 Red，再进 Green）。
- 未落盘 Red 证据就开始 Green 编码。
- Green 阶段通过删减/弱化测试断言来让测试过绿。
- 任一段证据与 spec 文件路径/时间序列矛盾（例如 Green 输出早于 Red）。

> QA 会验证红/绿/重构三段齐全且**顺序正确**；缺任一段或顺序颠倒即判 FAIL 并回到 Implement（`fix` 模式）。
> QA **不再重复运行** `[TDD]` 任务的单测（见 `qa.md`）；证据可信度完全由 Implement 保证——故本阶段必须如实留证。
