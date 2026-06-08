# Archive Protocol

子代理：`specflow-archive`。派发时以引擎落盘的 `pending-protocol.json` 及本 Schema 为准。

## Schema

```json
{
  "requirementId": "<需求号>",
  "task": "archive_project",
  "context": {
    "confirmation": "all_tasks_completed",
    "focusArchive": "<引擎生成的精简版归档上下文>"
  }
}
```

## 约束

- **focusArchive**：MUST 将 `suggestedAction.focusArchive` 透传至 `context.focusArchive`。子代理优先使用此字段生成 summary.md，无需读取 specify/plan 全文；缺失时回退读取。  
  focusArchive 含：业务摘要（specify Section 1）、Plan Scope、Roadmap Groups 摘要。
- **归档产物**：归档脚本会精简 specify.md（仅保留 Section 1 & 2）、删除 plan.md；归档后目录仅含 `summary.md` + 精简版 `specify.md`。
- **标签**：STRICTLY PROHIBITED 在 `--tags` 中包含项目技术栈（框架、语言、UI 库、构建工具、子包名等）；仅允许业务领域标签，3–5 个。
