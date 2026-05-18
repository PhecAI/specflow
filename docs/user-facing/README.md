# 用户可见话术（User-facing）

面向**终端用户 / 业务方**的会话文案，与机读 JSON 解耦。

## 必读

- **`VOICE.md`**：**话术风格与禁用词的单一事实来源**。改任何用户可见句前请先读；避免「发现一处改一处」导致口径不一致。
- **渲染**：`tools/render-user-facing.cjs` 或 `tools/user-facing.cjs` 的 `renderUserFacingMarkdown`。
- **命名**：`templateId` 点分命名 → 本目录 `点分改短横线.md`。

## 文件分工

| 类型 | 文件 | 说明 |
|------|------|------|
| 编排层 | `orchestration-*.md`（少量白名单） | 仅保留高风险确认/阻塞类模板，其余走 `user-facing.cjs` 通用自然语言渲染 |
| 子阶段汇报 | `completion-output-*.md` | 各子代理结束时的**极简**用户汇报结构（**禁止**路径/脚本/运行机制，见 `VOICE.md` 第 2.1 节） |
| 规范 | `VOICE.md` | 全局用语、禁止项、自检清单 |

**代理操作约束**（如必须跑脚本、显式子任务）写在 **`orchestrating-specflow`** 技能中，**不要**写进对用户展示文案模板。
