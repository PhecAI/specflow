# Implementation Plan: [需求名称]

<!-- specflow:requirement=[需求号] -->
<!--
Plan 写作原则（架构师视角，单一 plan.md）：
1. Implement 读 plan 即可开干：§1 建立心智模型，§2 的每个 Group 都是自足执行单元。
2. 技术澄清在写 plan 之前完成；闭合结论优先写入对应 Group 的 Local Contract / Files / Test Strategy。只有跨多个 Group、且不在 Roadmap 中自然闭合的非显然结论，才写入「已确认技术决策」。
3. Group 是唯一落地单元：User AC / Local Contract / Test Strategy 都直接挂在 Group 下。
4. 后端未定时走 Mock 主线：§1.4 只保留一句话级 Mock 心智模型，具体对接数据写入各 Group 的 Local Contract。
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

> 可选。只记录跨 Group 生效、且不会在 Implementation Roadmap 中完整体现的非显然技术结论。若所有结论已在各 Group 的 Local Contract / Files / Test Strategy / Verification Contract 中闭合，则写“无，技术结论已随 Group 内联”。

| 项 | 决策 | 依据 |
|----|------|------|
| [例：跨组状态归属] | [统一由某稳定 store/composable 承载，避免多 Group 各自维护] | [技术澄清 / 存量架构] |

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
- **CodeStyle 基线**: `ai-docs/global-assets/standards/architecture-layers.md`（分层画像）+ `ai-docs/global-assets/standards/code-style.md`（编码规则 + `## SOPs`）；需求内 `code-style.md` 仅记录新增/覆盖规则

#### Mock 接入

> 仅作为心智模型，不全面罗列接口。实际 API / DTO / 枚举 / 权限 / 常量必须写在各 Group 的 **Local Contract**。

- **Mock 前缀**: `[例：/api/mock 或项目既有 mock base]`
- **Mock 文件**: `[mock 路径；没有则写“无”]`
- **Mock 总览**:
  - `[一句话：Group A 使用列表分页 mock 支撑首屏与筛选]`
  - `[一句话：Group B 使用详情 mock 支撑编辑回显]`

---

## 2. Implementation Roadmap (执行路径)
<!-- specflow:section=roadmap -->

> **任务状态机**：`[ ]` Pending · `[?]` Ready for QA · `[!]` Failed · `[x]` Completed  
> **执行单元**：Task Group。Group 必须是 LLM 可直接执行的自足信息集合；`Ref: F-xx` 只做追踪，不作为实现上下文依赖。  
> **执行顺序**：默认严格按 Group 顺序。仅当用户选择自动托管且 Group 依赖/文件冲突检查通过时，才允许并行。

### 📦 Group A: [组名 — 如：骨架与 Mock 数据层]

- **Goal**: [本组结束时用户/开发者能看到什么]
- **Depends on**: [无 / Group X]
- **User AC**:
  - `AC-001`: [本组覆盖的用户可观察验收点，Plain Language]
- **Local Contract**:
  - [本组所需 API / DTO / 枚举 / 权限 / 常量 / 业务约束，直接写全]
- **Files**:
  - **Create**: `[路径]`
  - **Modify**: `[路径]`
  - **Test**: `[spec 路径；没有则写“无”]`
- **Test Strategy**:
  - **TDD Units**: [任务 ID + spec + Red/Green 范围；没有则写“无”]
  - **Unit / Component Checks**: [按项目能力执行的最小目标验证；没有则写“无”]
  - **Mock Smoke**: [Mock 数据、替身服务或最小可观察记录；没有则写“无”]
  - **Static Diagnostics**: [本轮变更文件的诊断/规则核对；没有安全局部能力则写 CI/manual 承接]
- **Verification Contract**:
  - **Static Diagnostics**: [changed files / none / CI/manual]
  - **Targeted Test**: [specific behavior or file / none / CI/manual]
  - **Contract Check**: [fields + enum + permission mapping]
  - **Smoke Evidence**: [mock/manual observable evidence / none]
  - **Deferred**: [full regression / integration / e2e by CI/manual]
- **Group Verify**: [验证意图 + 范围 + 证据要求；避免写死项目命令]

- [ ] **T-A1** | **Create**: `[文件路径]` | [一句话动作] | Ref: F-01
  - **Step 1**: [具体动作；可含关键代码片段]
  - **Step 2**: […]
  - **Verify**: [目标验证范围] → `Expected: ...`

- [ ] **T-A2 [TDD]** | **Test**: `[spec 路径]` | [先写失败测试再实现的纯逻辑/状态机] | Ref: F-01
  - **Step 1**: 写失败单测（覆盖本组 Test Strategy 的 TDD Units）
  - **Verify**: [运行项目支持的单文件/单用例目标验证] → `Expected: FAIL`
  - **Step 2**: 实现使测试通过
  - **Verify**: [同一目标验证] → `Expected: PASS`
  - **Step 3**: 重构或声明无需重构
  - **Verify**: [同一目标验证] → `Expected: PASS`

### 📦 Group B: [组名] (Depends on A)

- **Goal**: […]
- **Depends on**: Group A
- **User AC**:
  - `AC-002`: […]
- **Local Contract**:
  - [本组所需 API / DTO / 枚举 / 权限 / 常量 / 业务约束，直接写全]
- **Files**:
  - **Create**: `无`
  - **Modify**: `[...]`
  - **Test**: `[...]`
- **Test Strategy**:
  - **TDD Units**: 无
  - **Unit / Component Checks**: […]
  - **Mock Smoke**: […]
  - **Static Diagnostics**: […]
- **Verification Contract**:
  - **Static Diagnostics**: […]
  - **Targeted Test**: […]
  - **Contract Check**: […]
  - **Smoke Evidence**: […]
  - **Deferred**: […]
- **Group Verify**: […]

- [ ] **T-B1** | **Modify**: `[文件路径]` | […] | Ref: F-02

### 🏁 Final Gate

- **Regression evidence whitelist（≤ 5）**:
  - `[目标验证项 / 文件 / 行为]`
- **Final Verify**: [仅执行本项目已证明安全的收口验证；无法安全本地执行则 CI/manual 承接]

### CodeStyle 增量（归档候选）

- [CodeStyle] [section]: [仅当本需求发现全局未覆盖、且可归属到 architecture-layers.md ## Layers 的横切规则时填写] (layers: [layer-id]) (applies: [来自该 layer 的分层级 glob])
