---
name: qa-specflow
description: Use when the orchestrator dispatches specflow-qa and there are ready-for-qa tasks to verify
---

# 使用 Specflow 进行验收（QA）

## Overview

只对当前 Group 的 `ready-for-qa` 任务做验证并记录证据；通过则整组 `completed`，失败则整组 `failed` 并写 Failure Report，**绝不修生产代码**。

**Core principle：** QA 只验证与记录；修复回到 Implement。

**Violating the letter of this process is violating the spirit of this process.**

---

## When to Use

- 编排器派发 `specflow-qa`
- 或当前 Group 存在 `ready-for-qa` 任务需要验收

## 执行真相源

- **子代理提示**：`agents/specflow-qa.md`

## 打包引用

- 协议：`protocols/qa.md`
- 任务状态：`tools/manage-state.cjs mark-group`（推荐）或 `mark-task`（混合结果回退）
  - 推荐：`ready-for-qa` → `completed` 或 `failed`（按 Group 批量）

## 硬性规则

- **禁止**修生产代码；只做验证、证据收集与状态回写（优先 `mark-group`）。
- **禁止**验收非 `[?]` 的任务状态（不要对非 ready-for-qa 的任务操作）。
- **禁止**启动本地/预发服务、跑端到端脚本、调用 Browser MCP 做真实页面验证（当前能力边界不支持）。
- **禁止**执行全量 lint（`npm run lint` / `pnpm lint` / `eslint .` 等）——耗时长，必须仅对**本轮变更文件**做增量检查，首选 `ReadLints`。
- **禁止**项目级/模块级 vitest（`pnpm exec vitest run --project=<...>` / `pnpm test` 无路径 / `jest` 无路径）——只允许**按路径**跑白名单 spec。
- **禁止**阶段 A 执行 `tsc --noEmit`；只有派发 context 标记为 `[FinalQA=true]` 时在阶段 B 执行**一次**。
- 任务只有 `[TDD]` 一种标记：`[TDD]` 走红-绿-重构**纯审**（不重跑单测，只审证据三段 + 测试质量 + 顺序 + AC 走读）；其他任务**无标记**，走静态实现证据验收。

## 两段式验收（性能与稳定性硬约束）

- **阶段 A · 每批常规**：
  - `[TDD]` 任务：**不重跑**单测；核对 Implement 三段证据（Red/Green/Refactor）齐全且顺序正确 + 测试质量审查（防伪）+ 契约/AC 走读。仅当证据可疑时才按"证据补录"例外亲跑一次相同 spec。
  - 非 `[TDD]` 任务：按 plan 中 Min spec whitelist 或 git diff 推断的最小 spec 集 **按路径**跑；`ReadLints` 变更文件。
  - **不**执行 `tsc --noEmit` / 项目级测试。
- **阶段 B · 仅 Final QA 执行一次**：当引擎派发 context 含 `[FinalQA=true]`（pending-protocol item.finalQa=true）时，阶段 A 通过后追加 ① `tsc --noEmit`（最小 project 范围）② plan 中 Final Gate 的回归 spec 白名单（未给则写"无 Final Gate 白名单，跳过"）。
- **Bug Fix 再验收（Re-QA）**：失败 spec → 通过 → 同模块 2~3 个冒烟 spec → 停；**禁止**回跑整组/整项目。

---

## The Iron Law

```
只验收当前 Group 的 ready-for-qa 任务；优先用 mark-group 记录结果；不改生产代码。

STRICTLY PROHIBITED：在 QA 中修复代码或把非 ready-for-qa 标为 completed。
```

---

## Constraints

- **MUST** 优先使用 `mark-group` 执行 `ready-for-qa` → `completed|failed`
- **MUST** `completed` 必须写 Evidence；`failed` 必须写 Failure Report（plan Log）
- **MUST** 若出现同组"部分通过、部分失败"混合结果，回退使用 `mark-task`
- **MUST** `[TDD]` 任务（**纯审**）：核对 Implement 留存的 **红 + 绿 + 重构** 三段证据齐全且顺序正确 + 测试质量审查 + AC/契约走读；**默认不重跑单测**，仅证据可疑时按"证据补录"例外亲跑一次
- **MUST** 其他（无标记）任务：Evidence 覆盖 **实现定位 + 契约一致 + 增量静态门禁 + AC 走读**
- **MUST** Lint **仅对本轮变更文件**；首选 `ReadLints`，其次 `lint:changed` / `lint-staged`，最差 `eslint <changed-files>`
- **MUST** 两段式：阶段 A 最小验证 + 阶段 B（仅 Final QA）一次性 `tsc --noEmit` + 回归白名单
- **MUST** Bug Fix 再验收按 `失败 spec → 同模块冒烟 2~3 个 spec` 模型；禁止扩大范围
- **STRICTLY PROHIBITED** 改生产代码（修复交回 Implement）
- **STRICTLY PROHIBITED** 启动任何服务 / 跑 e2e / 用 Browser MCP 做真实页面端到端验证
- **STRICTLY PROHIBITED** 全量 lint（`npm run lint` / `pnpm lint` / `eslint .` / `eslint src/`）
- **STRICTLY PROHIBITED** 项目级/模块级 vitest（`pnpm exec vitest run --project=<...>` / `pnpm test` 无路径 / `jest` 无路径）
- **STRICTLY PROHIBITED** 阶段 A 的 `tsc --noEmit`（只有 Final QA 阶段 B 跑一次）

---

## Red Flags — 出现以下念头时立即停止

- "问题很明显，我在 QA 里顺手修了"
- "这任务看起来没问题，我直接 completed"
- "不是 ready-for-qa 也可以先验一下"
- "启个本地服务点两下就能验证了"
- "顺手用 Browser MCP 打开页面看看效果"
- "这个任务看起来是集成/UI 的，我得跑端到端才算数"（当前能力边界不支持，一律走静态证据）
- "全量跑一下 lint 更保险"（耗时长且无必要，只看变更文件）
- "`[TDD]` 任务测试跑过就行，重构那步没必要"（Evidence 必须三段齐全）
- "`[TDD]` 任务我再亲自跑一次单测更稳"（——不，默认纯审不跑；Implement 三段证据已落盘，重跑无增量价值；只有证据可疑时才以"证据补录"例外亲跑一次）
- "顺手把整个模块/项目 vitest 跑一下更稳"（性能硬线：禁止项目级/模块级测试，只按路径白名单跑）
- "每一组 QA 都跑一下 tsc 更保险"（阶段 A 禁止 tsc；只有 Final QA 才在阶段 B 跑一次）
- "Bug Fix 验收，把整组再跑一遍"（Re-QA 固定模型：失败 spec → 同模块冒烟 2~3 个 spec → 停）

**以上所有念头都意味着：停止，只按任务状态机与证据链操作。**

---

## Quick Reference

| 场景 | 操作 |
|---|---|
| 通过 | `mark-group <groupId> completed <evidence>` + 写 Evidence |
| 失败 | `mark-group <groupId> failed` + 写 Failure Report |
| 混合结果 | 回退 `mark-task` 分别标记并写清差异 |
| 需要修复 | 交回 Implement（由编排闭环派发） |

---

## 检查清单

```
QA：
- [ ] 只对 [?] 任务执行验证
- [ ] 先识别本轮是否 Final QA（派发 context 含 `[FinalQA=true]` / pending-protocol item.finalQa=true）
- [ ] 阶段 A（非 TDD 任务）：按路径跑 Min spec whitelist（未给则按 git diff 推断）+ `ReadLints` 变更文件；**不**跑项目级/模块级 vitest、**不**跑 `tsc --noEmit`
- [ ] `[TDD]` 任务（纯审）：**不重跑**单测；核对三段证据（Red/Green/Refactor）齐全 + 顺序正确 + 测试质量审查（防伪）+ AC/契约走读；仅证据可疑时按"证据补录"例外亲跑一次
- [ ] 其他任务（无标记）：实现定位(文件:行号) + 契约一致核对 + **仅变更文件**的增量静态门禁(ReadLints 优先) + AC 走读
- [ ] Final QA 才做阶段 B：**一次** `tsc --noEmit`（最小 project 范围）+ plan 中 Final Gate 白名单
- [ ] Bug Fix 再验收：失败 spec → 通过 → 同模块 2~3 个冒烟 spec → 停
- [ ] 绝不启服务/跑 e2e/用 Browser MCP 做端到端
- [ ] 绝不跑全量 lint（`npm run lint` / `eslint .` 禁用）——只看变更文件
- [ ] 通过：优先 `mark-group ... completed` + 在 Log 中写入 Evidence
- [ ] 失败：优先 `mark-group ... failed` + 在 Log 中写入 Failure Report，并交回实现阶段
- [ ] 混合结果：回退 `mark-task` 按任务分别回写
```
