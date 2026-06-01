# SpecFlow 故障排查与异常处理指南 (Troubleshooting Guide)

当执行过程中遇到工具报错、资源无法读取或非预期行为时，请匹配以下场景并输出对应提示。

## 🌐 外部链接/资源读取失败

### 场景：飞书文档 (feishu.cn / larksuite.com)
- **特征**：URL 包含 `feishu.cn` 或 `larksuite.com`。
- **Action**：
  1. **优先尝试**：检查是否有 **飞书 MCP** 工具（如 `docx_v1_document_rawContent`）。若存在则调用；**成功**则对该 URL 执行 `manage-state.cjs clear-resource-failed <url>` 从失败映射中移除，继续流程。
  2. **失败**：读取 `ai-docs/<需求号>/.temp/resource-load-failed.json`（不存在则 `{}`），为该 URL 新增一条 `{ "<url>": { "reason": "feishu_fetch_failed", "message": "<下方话术>" } }` 并写回，再运行引擎；引擎检测到映射非空即 block。
  3. **重试**：再次尝试拉取；成功则 `clear-resource-failed <url>` 后运行引擎；仍失败则更新映射中该 URL 的记录并运行引擎。
- **话术模板**（写入 `message` 或直接展示时使用）：
  > 🚫 **[BLOCKER] 飞书文档读取失败**
  > - **链接**: {URL}
  > - **诊断**: 飞书文档需要专用鉴权，当前无法直接抓取。
  > - **建议**:
  >   1. 请检查是否已配置并连接 **飞书 MCP**。
  >   2. 检查该文档权限是否允许 MCP 账号访问。
  >   3. 备选方案：将内容导出为 Markdown/PDF 后直接上传，或复制全文粘贴。修复后可回复「重试」再次拉取。

### 场景：通用链接读取失败 (403/404/Network Error)
- **特征**：HTTP 请求返回非 200 状态码，或内容抓取为空。
- **Action**：在失败映射中为该 URL 新增一条记录（格式同上），写回 `resource-load-failed.json` 后运行引擎。重试成功则 `clear-resource-failed <url>` 再运行引擎。
- **话术模板**：
  > 🚫 **[BLOCKER] 远程内容读取失败**
  > - **链接**: {URL}
  > - **原因**: {失败的具体报错信息}
  > - **建议**:
  >   - 请确保 MCP 拥有网络权限 (`full_network`)。
  >   - 链接可能需要登录，请直接将内容粘贴在此处。修复后可回复「重试」再次拉取。

## 🔧 脚本非零退出 (Engine / manage-state / sync-document / print-protocol)

### 场景：运行脚本后得到非零退出码或 JSON 解析失败
- **特征**：脚本入口（统一写法：`PLUGIN_ROOT=/path/to/specflow node "$PLUGIN_ROOT/tools/*.cjs" ...`）执行后 process 退出码非 0，或 stdout 非合法 JSON（引擎）。
- **Action**：
  1. **不要**在同一轮内反复重试同一命令。
  2. 将本排查指南（`docs/troubleshooting.md`）中与当前操作匹配的章节展示给用户（资源读取失败、流程异常、锚点异常等）。
  3. 提示用户检查：需求号与路径是否正确、`ai-docs/<需求号>` 及 `.temp` 是否存在、plan.md/specify.md 是否存在且可读；修复后请用户明确回复「重试」再执行脚本。
- **话术模板**：
  > ⚠️ **脚本执行异常**（退出码非 0 / 输出无法解析）
  > 请根据上方排查步骤检查环境与参数。修复后可回复「重试」再次运行。

## 🛠 流程异常

### 场景：澄清未闭合强行继续
- **特征**：Specify 阶段存在未闭合 `[?]`，或正式 `specify.md` 正文散落内联 `[?]`，但用户未回答直接要求进入 Plan。
- **Action**：**拒绝**，引用 `specflow-specify.md`：必须询问与建议确认都必须由用户闭合；引擎交互会一次性展示全部未闭合 CQ，也可在 `specify.md` 中逐项填写 **[User]**。
- **话术模板**：
  > ✋ **流程暂停**
  > 存在未闭合澄清（`[?]`）。请先通过交互工具选择或补充决策，全部闭合后再进入 Plan。若为低影响且已有依据的细节，应删去 `[?]` 并直接写入正文；Decision Log 只记录用户澄清后的结论。

### 场景：锚点丢失或解析异常
- **特征**：Console 输出 `[SpecFlow] Warning: Fixed missing anchors...` 或文档结构解析不符合预期。
- **Action**：
  1. **自动修复**：SpecFlow Engine 会尝试自动识别章节并补全 `<!-- specflow:section=... -->`。请检查文档确认修复位置是否正确。
  2. **手动修复**：若自动修复失败，请手动在对应章节标题下方插入锚点注释。参考 `specify-template.md`。
- **建议**：使用 `specify-template.md` 生成完整文档。
