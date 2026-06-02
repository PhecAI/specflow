# QA Protocol

子代理：`specflow-qa`。派发时以引擎落盘的 `pending-protocol.json` 及本 Schema 为准。QA 的默认职责不是重新测试，而是审计 Implement 交付证据是否足以支持 `[?] -> [x]`。

## Schema

```json
{
  "requirementId": "<需求号>",
  "task": "verify_implementation",
  "context": {
    "scope": "<待验收的 Group 或任务列表>",
    "planPath": "ai-docs/<ID>/plan.md",
    "focusPlan": "<当前 Task Group 的 Goal / User AC / Local Contract / Test Strategy / Verification Contract>",
    "knowledgeContext": "<引擎注入的知识上下文>",
    "qaMode": "lite",
    "completionPacket": "<Ready-for-QA 日志中的 Completion Packet>",
    "previousAttempt": "<可选：上一轮失败记录摘要>"
  }
}
```

## Core

- **Evidence over claims**：不能因为 Implement 说“完成了”就通过，必须能在 Completion Packet 中看到物理证据。
- **Plan as verification contract**：QA 只对照 `focusPlan` 的 User AC、Local Contract、Test Strategy、Verification Contract。
- **Packet-first audit**：默认不重新读全文 plan/specify，不重新设计测试，不重复执行 Implement 已完成的验证。
- **Scope first**：任何验证动作都必须有明确 intent、scope、evidence；范围不明的项目级/模块级验证一律禁止。
- **No live system**：默认不启动服务、不做端到端、不访问真实环境；这些只能在 Final Gate 中按 plan 承接到 CI/manual。

## QA Lite Checklist

QA 默认只做以下 6 项：

1. **Packet 完整性**：`Changed Files / AC Mapping / Local Contract Mapping / Test Strategy Execution / Verification Matrix / Not Run / Knowledge Rules Used` 齐全。
2. **AC Mapping**：每条 User AC 都能指向实现位置或明确 Deferred 理由。
3. **Contract Check**：接口、字段、枚举、权限、错误码等与 Local Contract 不矛盾。
4. **Verification Matrix**：必须覆盖 `Static Diagnostics / Targeted Test / Contract Check / Smoke Evidence`，每项都有 `pass` 或 `deferred` 结论。
5. **TDD Evidence**：若任务标 `[TDD]`，只审 Red -> Green -> Refactor 三段证据、顺序和测试质量；默认不重跑。
6. **Knowledge Rules Used**：采用的知识规则与 `knowledgeContext` 相关，且没有用 Draft/Unknown 规则单独判 Fail。

## 补录规则

只有出现证据可疑时，QA 才允许做一次**同范围补录**：

- Packet 缺失或互相矛盾。
- TDD Red/Green/Refactor 证据缺失、顺序异常或无法看出结果。
- Verification Matrix 某项写了 pass 但没有 scope/evidence。
- previousAttempt 指向某个明确失败验证项，需要复核同一目标范围。

补录必须写入 Evidence：`Deviation: 证据补录 | 原因: <...> | Scope: <...>`。不得扩大到整库、整模块、真实服务或端到端。

## Final Gate

只有当派发 context 含 `[FinalQA=true]` 或 `pending-protocol.json` item 含 `finalQa:true` 时，QA 才执行 Final Gate：

- 先完成 QA Lite。
- 再按 Final Gate / Verification Contract 执行**一次**项目已证明安全的收口验证。
- 若无法安全本地执行，写明 `Deferred to CI/manual`，不得临时猜命令。

## 状态回写

- PASS：写入 QA Lite Evidence，且 evidence 必须包含 `QA Lite / Completion Packet / AC / Contract / Test Strategy / Verification Matrix` 摘要，然后调用：

```bash
PLUGIN_ROOT=/path/to/specflow
node "$PLUGIN_ROOT/tools/manage-state.cjs" mark-group [workspaceRoot] <需求号> <GroupId> completed <evidence>
```

- FAIL：写 Failure Report，说明预期、实际、证据、建议回到哪个 Verification Matrix 项，然后调用：

```bash
PLUGIN_ROOT=/path/to/specflow
node "$PLUGIN_ROOT/tools/manage-state.cjs" mark-group [workspaceRoot] <需求号> <GroupId> failed
```

QA 严禁修改生产代码；发现问题只能 FAIL 回 Implement。
