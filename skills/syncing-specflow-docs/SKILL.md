---
name: syncing-specflow-docs
description: Use when specs, contracts, behavior, plan/design change, or API/interface documentation arrives or updates—all are requirement-side changes; specify.md/plan.md must be updated via sync-document script before continuing implementation
---

# 同步 Specflow 文档（sync-document）

**低自由度**：必须使用现有脚本；对结构化变更请不要手工 patch specify/plan。

## Overview

把“需求变动”原子化落盘到 `specify.md` / `plan.md`：含 **业务口径/AC**、**合约与接口事实**（含 **后补接口文档/OpenAPI**）、以及 **方案设计** 变更；并重置受影响任务，避免代码与文档漂移。

**Core principle：** 先同步文档，再改生产代码。

**Violating the letter of this process is violating the spirit of this process.**

---

## When to Use

- 用户提出改 AC/外部行为/接口字段/数据模型/兼容策略/方案设计
- **接口文档**（Swagger/OpenAPI、后端说明、飞书/Confluence 接口章节）**新到或更新**——与 PRD 变更同属需求变动，通常先更新 **plan Contract**（`--target plan` 或 `both`）
- Implement 阶段出现“想改需求但还没同步”的信号
- 需要走 `orchestrator.cjs change` 或直接跑 `sync-document.cjs`

---

## The Iron Law

```
任何会改变外部行为/合约/方案的请求：
先 sync-document 更新 specify/plan，再推进 implement/qa。

STRICTLY PROHIBITED：用手工编辑代替 sync-document 做结构化变更。
```

---

## 命令

```bash
node "$PLUGIN_ROOT/tools/sync-document.cjs" [workspaceRoot] <requirementId> <payload> \
  [--target specify|plan|both] [--change-type patch|refactor|conflict] \
  [--updates '<json>'] [--updates-file <path>] [--extract]
```

将 `$PLUGIN_ROOT` 替换为 **SpecFlow 插件根目录**（含 `tools/`、`protocols/`、`templates/`、`docs/`）；与 IDE 安装方式无关。

## Updates JSON（概览）

完整格式请看 `tools/sync-document.cjs` 文件头注释：`specify` 区块更新、`plan` block 字段更新，以及脚本追加变更日志（changelog）。

## 同步后

运行 `orchestrator.cjs implement`（或需要串联时再运行 `change`），让 `specflow-engine` 读取到新的门禁与状态。

## 知识闭环约定（新增）

- `--extract` 开启后，脚本会把已解决澄清提取到 `knowledge-patch.json`（需求级 `.temp`）。
- 若 plan Log 中包含 `[CodeStyle]` 规范条目，会提取到 `coding-standard-patch.json`。
- `orchestrator change` 默认应携带提取能力，避免“只改文档不沉淀知识”。

---

## Constraints

- **MUST** `--target` 选对（specify/plan/both），并确保 updates 与意图一致
- **MUST** 脚本退出码为 0；否则先查 `docs/troubleshooting.md`
- **MUST** 同步后重跑编排（`orchestrating-specflow`）刷新 `suggestedAction`

---

## Red Flags — 出现以下念头时立即停止

- “我手动改两行文档更快，不用脚本”
- “先改代码，文档同步之后再说”
- “这个变更不算变更，就当实现细节”

**以上所有念头都意味着：停止，先走 sync-document。**

---

## 检查清单

```
同步：
- [ ] 已区分为 change vs implement（或用户已确认是变更）
- [ ] payload 与 updates 与用户意图匹配
- [ ] 脚本退出码为 0；否则查 troubleshooting.md
- [ ] 重新跑 orchestrator/engine
```

## 相关技能

- 入口门禁：**Using Specflow**
- 常规轮执行：**Orchestrating Specflow**

