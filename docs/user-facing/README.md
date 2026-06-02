# 用户可见话术（User-facing）

面向**终端用户 / 业务方**的会话文案，与机读 JSON 解耦。

## 必读

- **`VOICE.md`**：**话术风格与禁用词的单一事实来源**。改任何用户可见句前请先读；避免「发现一处改一处」导致口径不一致。
- **进度模型**：`tools/progress-model.cjs` 负责把流程事实转成 `goal / why / tasks / userAction / next`，这是用户引导和 LLM 润色的事实源。
- **声明式目录**：`tools/progress-catalog.cjs` 维护 `progressKey` 对应的引导定义；流程节点优先输出 `progressKey + progressVariables`。
- **渲染**：`tools/render-user-facing.cjs` 或 `tools/user-facing.cjs` 的 `renderUserFacingMarkdown`。
- **命名**：`templateId` 点分命名 → 本目录 `点分改短横线.md`。

## 文件分工

| 类型 | 文件 | 说明 |
|------|------|------|
| 编排层 | `orchestration-*.md`（少量白名单） | 仅保留高风险确认/阻塞类模板，其余走 `user-facing.cjs` 通用自然语言渲染 |
| 进度目录 | `tools/progress-catalog.cjs` | 声明式维护 `progressKey` 到 `goal / why / tasks / userAction / next` 的映射 |
| 进度模型 | `tools/progress-model.cjs` | 根据 `progressKey`、`progressVariables`、阶段、问题和派发目标生成结构化引导；流程可直接提供 `suggestedAction.progress` 覆盖默认推导 |
| 子阶段汇报 | `completion-output-*.md` | 各子代理结束时的**极简**用户汇报结构（**禁止**路径/脚本/运行机制，见 `VOICE.md` 第 2.1 节） |
| 规范 | `VOICE.md` | 全局用语、禁止项、自检清单 |

**代理操作约束**（如必须跑脚本、显式子任务）写在 **`orchestrating-specflow`** 技能中，**不要**写进对用户展示文案模板。

## LLM 引导方式

- 流程事实由状态机或 `progress-model` 生成，LLM 只负责把 `userFacing.progress` 润色成更自然的说明。
- LLM 必须以 `progress.goal / why / tasks / userAction / next` 为事实源，不得自行推断当前阶段、任务列表或用户下一步。
- 如果流程变更需要更精确的介绍，优先让流程输出 `progressKey + progressVariables`，并在 `progress-catalog.cjs` 新增或调整声明。
- 只有少数高度动态、无法被 catalog 表达的节点，才直接输出 `suggestedAction.progress` 覆盖默认推导。

## 任务列表机制评估

- 当前 SpecFlow 的真实执行任务来源是技术方案里的 Roadmap、Group 状态、gates 和 residual；不要再引入一套会和 Roadmap 竞争事实源的任务状态。
- 用户可见的“任务列表”应优先由 `userFacing.progress.tasks` 派生，表达当前环节要做什么，而不是单独持久化。
- 如果要接入平台原生任务列表，应只做镜像：从 Roadmap / progress 生成展示任务，并在状态变化时同步；禁止让原生任务列表反向成为 SpecFlow 的流程判定依据。
