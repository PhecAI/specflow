# Implementation Plan: [需求名称]

<!-- specflow:requirement=[需求号] -->
<!--
Plan 写作原则（架构师视角，单一 plan.md）：
1. Implement 读 plan 即可开干：先建立心智模型（Goal/决策/目录），再给契约，最后给可执行 Task。
2. 技术澄清在写 plan 之前完成；闭合结论写入「已确认技术决策」，plan 正文不写未闭合 [?]。
3. Feature 写「做什么、测什么」；Roadmap 写「改哪个文件、怎么验」——避免两段重复粘贴。
4. 后端未定时走 Mock 主线：Contract 先给 Mock 表 + 联调替换清单，不要每个接口重复「待确认」。
-->

---

## 1. Architecture & Tech Stack (架构与技术栈)
<!-- specflow:section=architecture -->

### 1.1 方案摘要

- **Goal**: [一句话：本方案交付什么、联调前能否本地演示]
- **PRD**: [链接或「见 specify §1」]
- **Specify**: `ai-docs/[需求号]/specify.md`
- **Delivery**: [Mock 先行可本地演示 | 直接联调 | 混合：UI mock + 部分真实接口]

### 1.2 技术非目标

> 从架构师视角声明本期**不做**什么（与 specify 非目标互补，写技术边界即可）。

- [例：不做前端字节渠道尺寸本地校验；失败原因来自接口]
- [例：不抽象到 packages/common；仅在当前子应用实现]

### 1.3 已确认技术决策

> 技术澄清（CQ-Tech / CQ-Contract）闭合后的结论汇总；Implement **以本表为准**，勿回查澄清过程。

| 项 | 决策 | 依据 |
|----|------|------|
| [例：接口策略] | [Mock 先行 / 正式契约] | [PRD / 用户 Option B / 存量 API] |
| [例：片单来源] | [A 路 albumSuggest，禁止 B 路] | [specify + 知识库] |

### 1.4 架构与分层

- **Architecture**: [总体方案：模块边界、分层、状态归属、与存量模块关系]
- **Tech Stack**: [Vue 3 + TS + …]
- **目录结构**（新建/修改范围）:

```text
[相对仓库根或子应用根的目录树，只列本需求触及路径]
```

- **边界红线**:
  - **不得** [禁止引用的模块/错误复用路径]
  - **不得** [禁止的行为]
- **参考实现（SOP）**:
  - [能力]: [仓库内具体文件路径]（[可选：`.cursor/rules/.../sop-*.mdc`]）
- **CodeStyle 基线**: `ai-docs/global-assets/standards/code-style.md` + `ai-docs/global-assets/standards/architecture-layers.md`；需求内 `code-style.md` 仅记录新增/覆盖规则

---

## 2. Technical Contracts (技术契约)
<!-- specflow:section=contract -->

> 与 specify 业务规则一致。有 Mock 边界时 **§2.1 为 Implement 默认对接面**；正式接口差异集中在 §2.5 联调替换清单。

### 2.1 Mock / 默认 API（联调前）

> 当 Delivery 含 Mock 时必填。路径、方法、用途一张表说清；Implement Task 1 即对接此表。

| 接口 | 方法 | 用途 |
|------|------|------|
| `/api/.../page` | POST | 列表分页 |

**Mock 文件**: `[mock 路径]`（对齐项目既有 mock 接入方式）

### 2.2 业务常量与枚举

**文件**: `[config 路径]` — 单一事实源；枚举成对维护 `*_MAP` + `*_LIST`。

| 常量/枚举 | 值或语义 | 依据 |
|-----------|----------|------|
| | | specify / PRD |

### 2.3 数据模型与领域规则

**Domain**: `[domain 路径]`

| 字段/概念 | 类型 | 说明 |
|-----------|------|------|
| | | |

**领域衍生（纯函数 / getters，供列表选择与批量操作复用）**:

- `[flagName]`: [判定规则，Plain Language]

### 2.4 正式 API（有依据时填写；Mock 阶段可整节省略或标「联调时启用」）

#### [接口名]

- **POST** `[path]`
- **Request**: [字段表或 JSON 骨架]
- **Response**: [字段表或 JSON 骨架]
- **约束**: [与 specify 一致的门禁]

### 2.5 联调替换清单

> Mock 切真实接口时**只改本节 + api 层**；避免全文搜索替换。

- **Base path**: [正式前缀]
- **字段映射**: [mock 字段 → 正式字段]
- **分页/排序**: [差异说明]
- **权限 URI**: [占位 → 正式 xauth]

---

## 3. Feature Breakdown (功能与验证拆解)
<!-- specflow:section=feature -->

> **只写设计与测试意图**，不写逐步操作（逐步操作只在 §4 Roadmap）。每个 Feature 对应 specify 一个功能切片。

### [F-01] [功能名称]

- **Ref**: `specify.md §3.x` / [验收要点摘要，Plain Language，勿堆 AC 编号]
- **Design**:
  - [组件/组合式职责，1–3 条]
  - [关键交互或状态，1–3 条]
- **Test Scope**:
  - **TS-01 [TDD]**: [可单测的纯逻辑场景]
  - **TS-02**: [静态/UI 验收场景，不加 [TDD]]
- **QA 执行建议（soft）**:
  - **Affected paths**: `[glob]`
  - **Min spec whitelist**: `[spec 路径，≤5]`

---

## 4. Implementation Roadmap (执行路径)
<!-- specflow:section=roadmap -->

> **任务状态机**：`[ ]` Pending · `[?]` Ready for QA · `[!]` Failed · `[x]` Completed  
> **执行顺序**：严格按 Group 顺序。Implement 每完成一 Task 应跑对应 **Verify** 再勾选。

### 📦 Group A: [组名 — 如：骨架与 Mock 数据层]

- **Goal**: [本组结束时用户/开发者能看到什么]
- **Group Verify**: `Run: [命令]` → `Expected: [可观察结果]`

- [ ] **T-A1** | **Create**: `[文件路径]` | [一句话动作] | Ref: F-01
  - **Step 1**: [具体动作；可含关键代码片段]
  - **Step 2**: […]
  - **Verify**: `Run: ...` → `Expected: ...`

- [ ] **T-A2** | **Test**: `[spec 路径]` | [TDD：先写失败测试再实现] | Ref: F-01
  - **Step 1**: 写失败单测（覆盖 TS-01）
  - **Verify**: `Run: vitest ...` → `Expected: FAIL`
  - **Step 2**: 实现使测试通过
  - **Verify**: `Run: vitest ...` → `Expected: PASS`

### 📦 Group B: [组名] (Depends on A)

- **Goal**: […]
- **Group Verify**: `Run: ...` → `Expected: ...`

- [ ] **T-B1** | **Modify**: `[文件路径]` | […] | Ref: F-02

### 🏁 Final Gate

- **Regression spec whitelist（≤ 5）**:
  - `[__tests__/...]`
- **Final Verify**: `Run: [lint + 全量单测命令]` → `Expected: PASS`

### CodeStyle 增量（归档候选）

- [CodeStyle] [section]: [仅当本需求发现全局未覆盖、且可归属到 architecture-layers 的横切规则时填写] (layers: [architecture-layer-id]) (applies: [来自该 layer 的分层级 glob])

### Spec 覆盖自检

| specify 能力 / 验收 | Group / Task |
|---------------------|--------------|
| [Plain Language] | T-A1, T-B2 |

---

## 5. Execution Log (执行摘要与存证)
<!-- specflow:section=execution-log -->

### ✅ 验收存证 (Evidence)

- （格式：**[Group ID]**: YYYY-MM-DD | Result: Pass | Verification: [方式] | Evidence: [摘要]）

### ❌ 异常记录 (Blocks)

- （格式：**[Failed] T-xx**: [报错摘要]）

---

## 6. Changelog (修改日志)
<!-- specflow:section=changelog -->

- **YYYY-MM-DD**: [变更摘要]
