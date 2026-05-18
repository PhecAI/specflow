# Implementation Plan: [需求名称]

<!-- 
AI 模板使用说明：
1. 采用资深系统架构师视角，负责将业务需求转化为可执行的技术方案。
2. 定义核心的技术契约（API、数据模型、状态机等），作为开发的唯一依据。
3. 任务拆解必须保持原子化，严格按照 Group 顺序执行。
-->

---

## 1. Architecture & Tech Stack (架构与技术栈)
<!-- specflow:section=architecture -->

- **Architecture**: [简述总体架构方案或设计模式。例如：BFF层聚合+后端微服务，或基于Vue3+Pinia的纯前端存储等]
- **Tech Stack**: [列出核心技术栈、框架、关键依赖包]

---

## 2. Technical Contracts (技术契约)
<!-- specflow:section=contract -->

> **说明**：这是前后端、模块间的刚性技术接口，必须严谨。包括 API 定义、数据结构、状态机枚举等。**必须与 specify.md 的业务规则一致**。

### 2.1 Data Models / State Machines (数据模型与状态机)
- **[模型/状态机名称]**
  - [字段/状态]: [类型/约束描述] (例如: `status` Enum { PENDING=0, APPROVED=1 })

### 2.2 API / Interfaces (接口定义)
- **[接口名称]** (`GET /api/v1/example`)
  - **Request**: `{ "id": string }`
  - **Response**: `{ "success": boolean, "data": [...] }`

---

## 3. Feature Breakdown (功能与验证拆解)
<!-- specflow:section=feature -->

> **说明**：将 specify 的 AC (验收标准) 映射到具体的技术实现方案。

### [F-01] [功能模块名称]
- **Ref (关联 AC)**: `specify.md -> AC-01, AC-02`
- **Design (实现方案)**: 修改 `[具体文件]`, 实现 [核心算法/逻辑描述]。
- **Test Scope (测试验证范围)**:
  > **标记说明**：**只有**需要走 TDD（红-绿-重构）的任务才标 `[TDD]`；其他任务**不加任何标记**，由 QA 以静态实现证据验收即可。
  - **TS-01 [TDD]**: [测试场景描述。如：输入为空数组时返回默认值 0]
  - **TS-02**: [测试场景描述。如：弹窗打开时，背景遮罩不可点击。无需标记，走静态验收]

  > **QA 执行建议（soft；给出则直接用，未给出时 QA 自行按 git diff 推断）**：
  - **Affected paths**: [glob 描述，例如 `src/content-library/**`、`packages/mini-program/src/content-library/**`]
  - **Min spec whitelist（阶段 A 每批必跑）**: [逐条列出本 Group 日常 QA 必跑的 spec 路径，总量 ≤ 5 条]
    - `[__tests__/unit/xxx.spec.ts]`
  - **Smoke spec whitelist（Bug Fix 再验收用）**: [失败 spec 通过后跑的同模块冒烟 spec，≤ 3 条；可与 Min 重叠]
    - `[__tests__/unit/yyy.spec.ts]`

---

## 4. Implementation Roadmap (执行路径)
<!-- specflow:section=roadmap -->

> **任务状态机**：
> - `[ ]` **Pending** — 待开发（Implement 领取）
> - `[?]` **Ready for QA** — 编码完成，待 QA 验收
> - `[!]` **Failed** — QA 验证失败，需修复
> - `[x]` **Completed** — QA 验证通过
>
> **要求**：按 Group 顺序执行。每个 Task 必须明确且原子化，必须指明要操作的具体文件。

### 📦 Group A: [基础基建/前置模块]
- **Goal**: [本组交付目标]
- [ ] **T-A1** | **Create**: `[文件路径]` | [动作描述，如：实现基础数据模型与类型定义] | Ref: F-01
- [ ] **T-A2** | **Test**: `[测试文件路径]` | [动作描述，如：完成 TS-01 单元测试] | Ref: F-01

### 📦 Group B: [核心业务逻辑] (Depends on Group A)
- **Goal**: [本组交付目标]
- [ ] **T-B1** | **Modify**: `[文件路径]` | [动作描述] | Ref: F-02

### 🏁 Final Gate（soft；仅**最后一个 Group** 需要填写，用于 QA 阶段 B 收口）
> **说明**：当最后一批 QA 通过后 Roadmap 将全绿，引擎会给 QA 加上 `[FinalQA=true]` 提示；QA 会在阶段 A 基础上额外执行**一次** `tsc --noEmit` 与下方回归白名单。未填写则只跑 tsc，跳过回归白名单。
- **Regression spec whitelist（≤ 5 条）**:
  - `[__tests__/unit/core.spec.ts]`

---

## 5. Execution Log (执行摘要与存证)
<!-- specflow:section=execution-log -->

> **说明**：由 AI 实时维护。QA 在验证通过或失败时记录证据。

### ✅ 验收存证 (Evidence)
- （格式：**[Group ID]**: YYYY-MM-DD | Result: [Pass] | Verification: [验证方式] OK | Evidence: [测试日志摘要或证明]）

### ❌ 异常记录 (Blocks)
- （格式：**[Failed] T-xx**: [报错信息，用于 Bug Fix 修复上下文]）

---

## 6. Changelog (修改日志)
<!-- specflow:section=changelog -->

> **说明**：仅记录开发者主动修改或因需求变更引起的技术方案调整。

- **YYYY-MM-DD**: [变更摘要]
