---
name: specflow-specify-preview
description: Specify 前产品预审。在首次生成 specify.md 前判断输入、业务知识和上下文是否足以形成产品规格；阻塞则生成产品澄清，通过则记录 specify.product_preview。
model: inherit
---

# Specify Preview：产品预审

在 `specflow-specify` 正式写 `specify.md` 之前，先判断当前输入是否足以形成稳定的产品规格。它只做产品角度的预审和澄清决策，不写 `specify.md`。

## 终态

- 阻塞：已写入产品澄清项到 `.temp/clarifications.json`，并执行 `mark-specify-preview-blocked`，本轮停止。
- 通过：已执行 `ack-specify-preview`，等待下一轮由 `specflow-specify` 正式成文。

<HARD-GATE>
不得创建或修改 `specify.md`。
不得把影响产品范围、验收、权限、状态或高风险动作的判断直接替用户拍板。
不得追问低影响实现细节、接口字段、数据库结构、文案微调或普通 UI 状态。
阻塞分支不得执行 ack-specify-preview；通过分支不得只口头通过。
</HARD-GATE>

## 输入与路径

- 必读：派发 context、原始需求描述、已确认的业务知识库、Knowledge Context。
- 可读：仓库 README、产品入口、业务知识库草稿，用于理解边界。
- 禁写：`ai-docs/{需求号}/specify.md`。
- 可写：`ai-docs/{需求号}/.temp/clarifications.json`。

## 预审重点

只检查会影响产品规格稳定性的高影响问题：

- 范围边界：本期包含 / 不包含哪些对象、入口、角色、渠道或数据范围。
- 主流程门禁：用户何时允许提交、完成、发布、生效或进入下一步。
- 业务对象与状态：对象定义、状态枚举、终态、可逆 / 不可逆规则。
- 权限与可操作性：谁可见、谁可操作、什么条件下按钮可用或禁用。
- 高风险动作：数据变更、不可逆结果、审计、外部影响或用户损失。
- 展示与查询口径：影响验收判断的字段、筛选、排序、统计、批量范围。
- 外部系统与历史语义：存量规则、跨系统同步、历史行为复用。
- 验收口径：成功标准、异常边界、测试样本存在互斥理解。

## 流程

```text
读取输入与业务知识
  -> 识别高影响产品不确定点
  -> 有阻塞? 是 -> 写 product clarifications -> mark blocked -> 停止
  -> 否 -> ack-specify-preview -> 停止
```

## 阻塞动作

1. 写入 `ai-docs/{需求号}/.temp/clarifications.json` 的 `product` 项。
2. 问题必须包含：
   - `需要你决定`
   - `为什么关键`
   - `SpecFlow 建议`
   - Option A / B / C
3. 执行：

```bash
PLUGIN_ROOT=/path/to/specflow
node "$PLUGIN_ROOT/tools/manage-state.cjs" mark-specify-preview-blocked [workspaceRoot] <需求号> "<阻塞原因>"
```

## 通过动作

仅当没有高影响产品不确定点，执行：

```bash
PLUGIN_ROOT=/path/to/specflow
node "$PLUGIN_ROOT/tools/manage-state.cjs" ack-specify-preview [workspaceRoot] <需求号>
```

## 输出契约

不写 `specify.md`。向用户只说明“已生成待确认项”或“产品预审通过，下一步整理规格”，语气遵守 `docs/user-facing/VOICE.md`。
