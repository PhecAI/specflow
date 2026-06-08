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
    "testStrategy": "<当前 Task Group 的 Test Strategy（TDD Units / Targeted Test / Mock Smoke / Static Diagnostics / Contract Check）>",
    "completionPacket": "<Implement 在 Ready-for-QA 日志中写入的结构化交接包>",
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
- **状态回写策略**：默认使用 `manage-state.cjs mark-group <groupId> ready-for-qa` 进行整组送测（一次门禁校验）；仅在同组混合结果等特殊场景回退 `mark-task` 按任务标记。
- **状态机硬门禁**：`ready-for-qa` 转换由 `manage-state.cjs` 强制校验 `implement.completion_packet_ready`。缺少完整 Completion Packet 时，命令会失败并在 `gates.json` 写入 `blocked`；不得用自然语言确认或手工改 checkbox 绕过。
- **focusPlan**：MUST 将 `suggestedAction.focusPlan` 透传至 `context.focusPlan`。子代理**仅**使用 focusPlan 完成本 Group 任务，**禁止**为完成本 Group 而读取 specify.md 或 plan.md 全文（以节省上下文与 Token）。
- focusPlan 仅包含当前 Task Group 的自足上下文：Goal / Depends on / User AC / Local Contract / Files / Test Strategy / Active Group 任务列表 / 最近失败或存证摘要。Task Group 缺少这些字段时视为 plan 结构不达标，不再拼接全局 Feature / Contract 回退上下文。
- **Test Strategy 是执行依据**：`[TDD]` 只是审计标签；实现时必须按当前 Group 的 Test Strategy 区分 TDD Units、Targeted Test、Mock Smoke、Static Diagnostics、Contract Check。
- **Completion Packet 是 QA 交接依据**：标记 `ready-for-qa` 前，Implement MUST 在 Ready-for-QA 日志中写入结构化 `Completion Packet`。QA 默认执行 `QA Lite`，只审 `focusPlan + Completion Packet`，不重新读全文 plan、不重新设计测试。
- **knowledgeContext**：MUST 参与实现决策，但不是“照单全收”。子代理需做二次筛选（适用/不适用），仅采用与当前任务相关的规则，并在 Log 中记录“采用了哪些知识规则 + 为什么”。
- **相关性决策卡（强制）**：编码前先生成 `任务意图 + 采用规则(<=3) + 忽略规则及理由`，并在 Ready-for-QA 日志中回填一致的规则清单。

## 验证门禁（硬性，Implement 阶段自证）

Implement 阶段的目标是**完成编码 + 最小证据链**。QA Lite 默认只审计 Completion Packet 与 Verification Matrix，不重新设计测试、不重复执行验证。本阶段按 Task Group 的 Test Strategy 与 Verification Contract 执行。SpecFlow 不规定项目技术栈，也不要求固定命令；验证方案由 agent 基于当前项目文件探索，只能执行安全、局部、可解释的目标。

### 两条全局硬约束（违反即判 Bug Fix 回滚）

1. **测试执行唯一性（跨阶段去重）**：同一个 spec 文件在 Implement 与 QA 之间**只执行一次**。
   - `[TDD]` 任务：由 Implement 执行（Red→Green→Refactor 三轮），QA **不重跑**（详见 `qa.md`）；
   - 非 `[TDD]` 任务：若 Test Strategy 把 Targeted Test 明确归给 QA，则 Implement 不跑对应目标；若 Group 中已有安全局部目标用于实现自检，Implement 仅可按 Strategy 指定范围运行一次并在 Log 标注，QA 不重复运行同一目标。
2. **禁止全量验证冒充局部证据**：任何可能覆盖整库、整模块、启动服务、访问真实环境或不可控扩大范围的命令，都不得作为 Implement 默认动作；除非 Verification Contract 明确要求且 Log 写明 Deviation、范围和原因。

### 允许的验证类型

- **Static Diagnostics**：只针对本轮变更文件或明确局部范围；若项目没有安全局部能力，则在 Completion Packet 中标注 CI/manual 承接。
- **Targeted Test**：只针对 Verification Contract 明确的单文件、单用例、单包或等价最小目标；不得执行未限定范围的测试套件。
- **Contract Check**：通过文件/符号定位证明字段、枚举、权限、接口路径等与 Local Contract 一致。
- **Smoke Evidence**：仅限 mock、替身、局部可观察记录；需要真实服务/环境的烟雾测试一律 Deferred。
- **Full Regression / Integration / E2E**：默认 Deferred to CI/manual，不在 Implement 阶段执行。

### 硬性禁止原则

- 不执行无范围参数的项目级/模块级测试、检查、构建或类型验证。
- 不启动开发/生产服务，不做端到端浏览器验证，不访问真实网络或数据库。
- 不把“命令通过”当成唯一证据；必须能映射到 Verification Contract 的某一项。
- 非 TDD 任务不得自行扩展验证范围；除 Test Strategy 明确要求外，禁止新增、修改或运行测试目标。

### 例外

如确实需要违反上述清单（例如跨文件重构引发的连锁编译错误），必须在 plan Log 的 Implement Evidence 区写明：
  `Deviation: <命令> | 原因: <1 句> | 范围: <涉及文件数>`

## Completion Packet（Ready-for-QA 交接包，MUST）

Implement 在调用 `mark-group <groupId> ready-for-qa` 之前，必须在 plan Log 写入以下结构。该结构由 `manage-state.cjs` 在状态转换前硬校验；任一关键小节缺失会拒绝进入 `ready-for-qa`。

```markdown
#### Completion Packet — Group <ID>
- **Changed Files**:
  - `<path>`: <关键改动 / 符号 / 组件>
- **AC Mapping**:
  - <User AC 摘要> → `<path>:<line-or-symbol>` → <处理方式>
- **Local Contract Mapping**:
  - <接口 / 字段 / 枚举 / 权限 / 常量> → `<path>:<line-or-symbol>` → <一致性结论>
- **Test Strategy Execution**:
  - TDD Units: <spec path + Red/Green/Refactor 证据位置 / 无>
  - Unit/Component Checks: <执行者 Implement/QA + 目标验证范围/结果 / 无>
  - Mock Smoke: <准备/执行步骤 + 可观察结果 / 环境限制 / 无>
  - Static Diagnostics: <变更文件诊断/规则核对结果 / 无安全局部能力则说明承接>
- **Verification Matrix**:
  - Static Diagnostics: <scope> → <evidence/pass/deferred>
  - Targeted Test: <scope> → <evidence/pass/deferred>
  - Contract Check: <scope> → <evidence/pass>
  - Smoke Evidence: <scope> → <evidence/pass/deferred>
- **Not Run / Deferred**:
  - <未执行项> → <原因> → <交给 QA / FinalQA / 人工验收>
- **Knowledge Rules Used**:
  - <规则名/来源> → <落点>
```

## TDD 模式指令 (Test Strategy 指定 TDD Units / 任务含 [TDD] 时 MUST 遵守)

必须按 **红 → 绿 → 重构** 三段**严格顺序**走完，且每段都在 plan Log 留下证据。

### 核心语义（MUST 理解正确）

- **Red 阶段的失败是 "预期状态"，不是 Bug**。因为业务代码尚未实现，测试**必须失败**；这正是 TDD 的第一步红。
- **严禁**"写完测试一看失败就立即编码/改测试去消除失败"——这会跳过 Red 落盘，直接混入 Green，破坏红绿证据链。
- **三段必须按顺序**：`Red 证据落盘 → 再开始 Green 编码 → Green 证据落盘 → 再做 Refactor`。任何顺序倒置或阶段合并都视为违规，QA 判 FAIL 回 `fix` 模式。

### 具体步骤

1. **先写测试 (Red-Setup)**：在项目规范测试目录（如 `__tests__/unit/`、`tests/`、`spec/`）创建测试文件，断言业务逻辑与 AC 边界。**此时 `src/` 不得有任何实现改动。**
2. **验证失败 (Red)**：只执行项目支持的最小目标验证（单文件、单用例、单包或等价局部范围），确认失败（失败关键字/断言差异/缺失实现等）；若一上来就过，必为断言无效，**重写测试**（不是实现）。**禁止**使用未限定范围的项目级/模块级命令。**MUST** 把 Red 输出作为代码块写入 plan Log 的 "Implement Evidence / Red" 小节。**Red 证据未落盘前，不得开始第 3 步。**
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
