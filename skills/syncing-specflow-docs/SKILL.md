---
name: syncing-specflow-docs
description: Use when specs, contracts, behavior, plan/design change, or API/interface documentation arrives or updates—all are requirement-side changes; specify.md/plan.md must be updated via sync-document script before continuing implementation
---

# Syncing SpecFlow Docs：需求变更同步

把需求变动原子化落盘到 `specify.md` / `plan.md`：包含业务口径、AC、合约与接口事实、方案设计变更，并重置受影响任务，避免代码与文档漂移。

## 设计思想

| 原则 | 含义 |
| --- | --- |
| Docs Before Code | 任何外部行为、合约或方案变化，都先同步文档再实现。 |
| Script Only | 结构化变更必须走 `sync-document.cjs`，不手工 patch specify/plan。 |
| Knowledge Loop | 同步时提取知识与代码规范 patch，供后续注入和归档。 |

## 使用时机

- 用户提出改 AC、外部行为、接口字段、数据模型、兼容策略或方案设计。
- Swagger/OpenAPI、后端说明、飞书/Confluence 接口章节新到或更新。
- Implement 阶段出现“想改需求但还没同步”的信号。
- 需要走 `orchestrator.cjs change` 或直接跑 `sync-document.cjs`。

## 终态

- `specify.md` / `plan.md` 已按目标更新。
- 相关 changelog、任务重置、知识 patch 已按脚本规则完成。
- 同步后重新运行编排，刷新 `suggestedAction`。

<HARD-GATE>

任何会改变外部行为、合约或方案的请求，必须先同步文档。
不得用手工编辑代替 `sync-document.cjs` 做结构化变更。
不得先改生产代码再补文档。
脚本非零退出时，先查 `docs/troubleshooting.md`，不得盲目重试。

</HARD-GATE>

## 执行真相源

- `tools/sync-document.cjs`
- `tools/orchestrator.cjs change`
- `docs/implement-vs-change.md`
- `docs/troubleshooting.md`
- `orchestrating-specflow`

## 流程

1. 区分 change vs implement；若涉及行为、AC、合约、接口、字段或方案，按 change 处理。
2. 选择 `--target specify|plan|both`。
3. 准备 payload 与 `--updates` / `--updates-file`。
4. 运行 `sync-document.cjs`，必要时带 `--extract`。
5. 成功后运行 `orchestrator.cjs implement` 或回到 `orchestrating-specflow`。

命令：

```bash
node "$PLUGIN_ROOT/tools/sync-document.cjs" [workspaceRoot] <requirementId> <payload> \
  [--target specify|plan|both] [--change-type patch|refactor|conflict] \
  [--updates '<json>'] [--updates-file <path>] [--extract]
```

将 `$PLUGIN_ROOT` 替换为 SpecFlow 插件根目录（含 `tools/`、`protocols/`、`templates/`、`docs/`）。

## 知识闭环

- `--extract` 会把已解决澄清提取到需求级 `.temp/knowledge-patch.json`。
- plan Log 中的 `[CodeStyle]` 规范条目会提取到 `coding-standard-patch.json`。
- `orchestrator change` 默认应携带提取能力，避免只改文档不沉淀知识。

## 反模式

- 手工改两行文档替代脚本。
- 先改代码，文档之后再说。
- 把后到的接口文档当作实现细节。
- 同步后不重新运行编排。

## 自检

- 是否已区分 change vs implement？
- `--target` 是否匹配变更意图？
- payload 与 updates 是否与用户口径一致？
- 脚本退出码是否为 0？
- 是否已重新运行 orchestrator/engine？

## 输出契约

- 成功：文档同步完成，并回到编排获取下一步。
- 失败：报告脚本失败或变更冲突，不继续实现。
- 用户可见文本遵循 `docs/user-facing/VOICE.md`。
