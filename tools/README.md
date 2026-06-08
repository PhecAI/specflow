# SpecFlow 脚本用法 (Scripts Reference)

脚本位于插件根 `$PLUGIN_ROOT/tools/`。

## 参数解析原则

**Named flags 优先于位置参数（positional）。** 所有脚本均支持两种调用方式：

```bash
# 方式 A：Named flags（推荐，顺序无关，可扩展）
node script.cjs --workspace /path/to/project --requirement-id 8822

# 方式 B：位置参数（向后兼容保留）
node script.cjs /path/to/project 8822
```

**通用 Named Flags**（所有适用脚本均支持）：

| Flag | 别名 | 含义 |
|------|------|------|
| `--workspace <path>` | `--ws`, `-w` | workspaceRoot（默认 cwd） |
| `--requirement-id <id>` | `--requirementId`, `--rid`, `-r` | 需求号 |

---

## specflow-engine.cjs

```bash
PLUGIN_ROOT=/path/to/specflow
node "$PLUGIN_ROOT/tools/specflow-engine.cjs" \
  --workspace <workspaceRoot> --requirement-id <需求号>

# 兼容位置参数
node "$PLUGIN_ROOT/tools/specflow-engine.cjs" [workspaceRoot] [需求号]
```

## orchestrator.cjs

```bash
PLUGIN_ROOT=/path/to/specflow

# implement 模式
node "$PLUGIN_ROOT/tools/orchestrator.cjs" implement \
  --workspace <workspaceRoot> --requirement-id <需求号> [--human]

# change 模式
node "$PLUGIN_ROOT/tools/orchestrator.cjs" change \
  --workspace <workspaceRoot> --requirement-id <需求号> --payload '<描述>' \
  --target specify|plan|both \
  --change-type patch|refactor|conflict \
  [--updates '<json>'] \
  [--updates-file <path>]

# 兼容位置参数
node "$PLUGIN_ROOT/tools/orchestrator.cjs" implement [workspaceRoot] <需求号>
node "$PLUGIN_ROOT/tools/orchestrator.cjs" change [workspaceRoot] <需求号> <payload> ...
```

## print-protocol.cjs

```bash
PLUGIN_ROOT=/path/to/specflow
node "$PLUGIN_ROOT/tools/print-protocol.cjs" \
  --workspace <workspaceRoot> --requirement-id <需求号> \
  [--mode agent|human|task-prompt] [--group <GroupId>]

# 兼容位置参数
node "$PLUGIN_ROOT/tools/print-protocol.cjs" [workspaceRoot] <需求号> [--agent|--human|--task-prompt] [--group <GroupId>]
```

- `--mode agent`（默认）：编排/子代理核对用，输出含 agent、phase、focusPlan 等机读字段
- `--mode human`：面向用户的下一步说明（渐进披露，不含内部字段名）
- `--mode task-prompt`：输出 Task tool 调用模板；自动判断并行（dependsOn 为空）或串行（dependsOn 非空）

## manage-state.cjs

```bash
PLUGIN_ROOT=/path/to/specflow
node "$PLUGIN_ROOT/tools/manage-state.cjs" \
  --action <action> --workspace <workspaceRoot> --requirement-id <需求号> [action-specific flags]

# 兼容位置参数
node "$PLUGIN_ROOT/tools/manage-state.cjs" <action> [workspaceRoot] <需求号> [extras...]
```

**Action 专属 Named Flags**：

| Action | 专属 Flags |
|--------|-----------|
| `mark-task` | `--task <taskId>`, `--status <status>`, `--evidence <text>` |
| `mark-group` | `--group <groupId>`, `--status <status>`, `--evidence <text>` |
| `set-active-group` | `--group <groupId>`, `--auto`（布尔） |
| `ack-specify-review` | `--contract-evidence confirmed\|mock_allowed\|not_required`（可选，默认 `confirmed`） |
| `mark-specify-review-blocked` | `--reason <text>`（可选；用于阻止进入 Plan，仍需生成技术澄清状态） |
| `answer-clarifications` | `--answers <json>`：批量写回澄清答案，支持数组 `[{ "id": "CQ-1", "answer": "..." }]` 或对象 `{ "CQ-1": "..." }` |
| `ack-plan-before-implement` | `--group <groupId>`, `--auto`（布尔）；写入 `plan.implement_approved`，批准当前 plan 进入实现 |
| `set-domain-init-pref` | `--pref scan\|skip`, `--ref <scope>::<slug>`（scan 时必填，支持逗号分隔多个）。自动清空 `domainInitCandidateRefs` |
| `set-domain-init-candidates` | `--ref <csv>`：S1 阶段 agent 提交领域身份候选（尚未确认）；引擎下一轮基于候选生成 N 道 yes/no 采纳题 |
| `clear-domain-init-candidates` | 无参；清空 `domainInitCandidateRefs`（反悔/重新提交） |
| `clear-resource-failed` | `--url <url>`（可选，不传则清空全部） |

## gates.cjs

统一门禁状态机。门禁状态写入 `ai-docs/<需求号>/.temp/gates.json`；`specflow-state.json` 只保留运行态与旧字段兼容。

```bash
PLUGIN_ROOT=/path/to/specflow

node "$PLUGIN_ROOT/tools/gates.cjs" status \
  --workspace <workspaceRoot> --requirement-id <需求号>

node "$PLUGIN_ROOT/tools/gates.cjs" pass \
  --workspace <workspaceRoot> --requirement-id <需求号> --gate plan.readiness_review \
  --evidence confirmed

node "$PLUGIN_ROOT/tools/gates.cjs" block \
  --workspace <workspaceRoot> --requirement-id <需求号> --gate plan.readiness_review \
  --reason "缺少接口契约依据"

node "$PLUGIN_ROOT/tools/gates.cjs" reset \
  --workspace <workspaceRoot> --requirement-id <需求号> --gate plan.readiness_review
```

当前已接入的关键门禁：
- `init.global_assets`
- `init.architecture_layers`
- `init.domain_refs`
- `plan.readiness_review`
- `plan.user_confirm_start`
- `implement.completion_packet_ready`
- `qa.lite_evidence_ready`
- `archive.user_anchor`
- `archive.domain_merged`
- `archive.knowledge_reviewed`

门禁契约：
- gate id 必须注册在 `tools/gates.cjs` 的 `GATE_DEFINITIONS`。
- 写入入口会强制使用定义中的 `stage` / `scope`，调用方传错会被覆盖。
- `passed` 必须包含 evidence。
- `blocked` 必须包含 reason。
- 标记为 `snapshotRequired` 的 gate 在 `passed` / `blocked` 时必须包含 snapshot。
- `implement.completion_packet_ready` 与 `qa.lite_evidence_ready` 由 `manage-state.cjs mark-group/mark-task` 在状态转换前自动判定；不要手工 pass/block 这两类运行门禁。
- Archive 阶段以 `archive.*` gates 作为调度真相源；`specflow-state.json` 中的同名兼容字段不会绕过归档门禁。

## sync-document.cjs

```bash
PLUGIN_ROOT=/path/to/specflow
node "$PLUGIN_ROOT/tools/sync-document.cjs" \
  --workspace <workspaceRoot> --requirement-id <需求号> --payload '<描述>' \
  [--target specify|plan|both] [--change-type patch|refactor|conflict] \
  [--updates '<json>'] [--updates-file <path>]

# 兼容位置参数
node "$PLUGIN_ROOT/tools/sync-document.cjs" [workspaceRoot] <需求号> <payload> ...
```

## archive.cjs

```bash
PLUGIN_ROOT=/path/to/specflow
node "$PLUGIN_ROOT/tools/archive.cjs" \
  --workspace <workspaceRoot> --requirement-id <需求号> [--name "需求名称"] [--tags "#a #b"]

# 兼容位置参数
node "$PLUGIN_ROOT/tools/archive.cjs" [workspaceRoot] <需求号> [--name ...] [--tags ...]
```

## merge-global-assets.cjs

```bash
PLUGIN_ROOT=/path/to/specflow
node "$PLUGIN_ROOT/tools/merge-global-assets.cjs" \
  --workspace <workspaceRoot> --requirement-id <需求号> [--allow-prearchive]

# 兼容位置参数
node "$PLUGIN_ROOT/tools/merge-global-assets.cjs" [workspaceRoot] <需求号> [--allow-prearchive]
```

## inventory-scan.cjs

职责边界：只做 IO 原语，**不**承担领域识别 / 命名（那是 `specflow-domain-explorer` 的活）。

```bash
PLUGIN_ROOT=/path/to/specflow

# 子命令 1: init —— 建 global-assets 空壳（空 index.md + 空 metadata.json + 默认 code-style.md）
node "$PLUGIN_ROOT/tools/inventory-scan.cjs" \
  --workspace <workspaceRoot>

# 等价简写（不带子命令视为 init）
node "$PLUGIN_ROOT/tools/inventory-scan.cjs" init \
  --workspace <workspaceRoot>

# 兼容位置参数
node "$PLUGIN_ROOT/tools/inventory-scan.cjs" [workspaceRoot]

# 子命令 2: add-domain —— 由 agent 在 Recommend 确认领域身份后调用的幂等落盘原语
#   --ref    <scope>::<slug>，如 services/order::payment
#   --source 领域证据路径或线索（由 agent 收集，不再假设 src/services/<name>）
node "$PLUGIN_ROOT/tools/inventory-scan.cjs" add-domain \
  --workspace <workspaceRoot> \
  --ref <scope>::<slug> \
  --source "<evidence-path-or-hint>"
```

`add-domain` 幂等语义：
- `<slug>.md` 已存在：不覆盖（返回 `created: false`）
- `index.md` 已有该 slug 行：不重复追加（返回 `indexAppended: false`）
- `metadata.json` 已有该 slug 条目：不覆盖（返回 `metadataUpdated: false`）

## utils.cjs

```bash
PLUGIN_ROOT=/path/to/specflow
node "$PLUGIN_ROOT/tools/utils.cjs" <action>
```

## render-user-facing.cjs

```bash
PLUGIN_ROOT=/path/to/specflow
node "$PLUGIN_ROOT/tools/specflow-engine.cjs" --workspace <ws> --requirement-id <id> \
  | node "$PLUGIN_ROOT/tools/render-user-facing.cjs"
node "$PLUGIN_ROOT/tools/render-user-facing.cjs" --file engine-output.json
```
