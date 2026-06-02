# Plan Protocol

子代理：`specflow-plan`。派发时以引擎落盘的 `pending-protocol.json` 及本 Schema 为准。

## Schema

```json
{
  "requirementId": "<需求号>",
  "task": "generate_plan",
  "context": {
    "specifyPath": "ai-docs/<ID>/specify.md",
    "focusSpecify": "<引擎生成的精简版 Specify>",
    "knowledgeContext": "<引擎注入的知识上下文（局部 Patch / 归档 Patch / 全局资产）>",
    "projectType": "frontend | backend | fullstack",
    "tddStrategy": {
      "instruction": "仅对需要红-绿-重构单元测试的任务打 [TDD] 标记；[TDD] 是审计标签，不是完整测试设计。每个 Task Group 必须生成 Test Strategy 与 Verification Contract，覆盖 TDD、Targeted Test、Mock Smoke、Static Diagnostics、Contract Check 等适用验证意图。判定原则如下：",
      "rules": [
        { "type": "Pure Logic & Algorithms", "description": "涉及复杂计算、正则解析、数据转换、业务规则判断的核心逻辑", "action": "Must mark as [TDD]" },
        { "type": "Data Models", "description": "涉及 DTO 定义、Entity 状态流转、数据清洗与映射（含有可单测的纯函数）", "action": "Must mark as [TDD]" },
        { "type": "Integration & Other", "description": "接口定义、路由配置、Mock API、跨模块协作、以及不具备可单测纯函数的任务", "action": "不加 [TDD]，但必须在 Test Strategy 中写明 Targeted Test、Mock Smoke、Static Diagnostics 或 Contract Check" }
      ]
    }
  }
}
```

## 约束

- **focusSpecify**：MUST 将 `suggestedAction.focusSpecify` 透传至 `context.focusSpecify`。子代理优先使用此字段；`specifyPath` 仅用于回退（focusSpecify 缺失时）。  
- focusSpecify 由引擎从正式 specify.md 提取；新结构含 Requirement Overview、Product Decisions、Capabilities、Business Objects，旧结构兼容 Executive Summary、User Scenarios、Business Rules、Acceptance Criteria；不含 Decision Log / Clarification Log 与 Changelog。
- **knowledgeContext**：用于约束契约设计与 Roadmap 拆解。子代理需先筛选适用规则，再写入 plan（不要机械复制全部知识片段）。
- **相关性决策卡（强制）**：在输出 plan 前提供 `采用规则(<=3) -> Contract/Verification 映射`，并写明忽略规则原因；plan 内容须与该映射一致。
- **契约依据（强制）**：若用户未在规格或可引用材料中提供可落地的 **接口/字段变更** 依据，子代理 **不得** 在 `plan.md` 中编造具体接口路径与字段；**必须**按 `agents/specflow-plan.md` Phase 0 生成技术澄清状态并 blocked，待用户闭合后再生成 plan。用户授权 Mock 时，plan 以 §2.1 Mock 表 + §2.5 联调清单为 Implement 默认对接面。
- **可读性（强制）**：`plan.md` 仍为单一产物。§1 写 Goal/技术决策/目录/SOP；§3 写 Feature 意图与 Verification Intent；§4 Roadmap 使用 **Task Group** 作为唯一执行单元，每组必须含 Goal / Depends on / User AC / Local Contract / Files / Test Strategy / Group Verify / Task Step+Verify，避免 Feature 与 Roadmap 大段重复。
- **Task Group 自足（强制）**：Roadmap 中每个 Group 必须内联执行所需的最小业务验收与本地契约。`Ref: F-xx` 只做追踪，不得作为 Implement 获取上下文的唯一入口。
- **Verification Contract（强制）**：每个 Group 的 Test Strategy 必须覆盖非 TDD 任务的验证路径，包括但不限于 Targeted Test、Mock Smoke、Static Diagnostics、Contract Check。不得把非 TDD 任务笼统写成“静态验收”，也不得写入项目无关的固定命令。
- **并发策略（强制）**：默认串行 Task Group；只有 Depends on 为空且文件集合无交集、无共享容器/聚合文件、无共享 Mock/API contract 时，才可标注为可并行候选。最大并发建议 2。
