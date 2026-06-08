# SpecFlow

SpecFlow 是一套**引擎驱动**的 **SDD（Spec-Driven Development）** AI Coding 流程，面向**大型团队日常迭代**。

- **核心：引擎驱动** — `specflow-engine` / `orchestrator` 读取 `ai-docs` 与状态机，输出 `suggestedAction`（能否推进、派发到哪一阶段、人机确认项）。澄清未闭合、评审未通过、未送测/未验收时**脚本级阻塞**，不是把流程写进 Prompt 碰运气。
- **Harness 承载执行** — Skills、Agents、Hooks，负责「怎么做」；**「做什么、能不能做」由引擎说了算**。
- **SDD 产物链** — 从 `specify.md` → `plan.md` → Roadmap 分组实现 → QA 证据 → 归档，规格与契约先于代码，变更与 implement 分轨。

全链路：**Specify → Plan → Implement → QA → Archive**，配合严格阶段门禁。

## Quickstart

在支持的工具中启用 SpecFlow：

| 平台                         | 状态      |
| ---------------------------- | --------- |
| [Cursor](https://cursor.com) | ✅ 已支持 |
| 其他 IDE / CLI               | 🔜 规划中 |

## How it works

**引擎 + Harness 分工**：Harness（Agent / Skills / Hooks）负责对话、编码与阶段执行；**引擎**根据工作区 `ai-docs` 判定环节并门禁。Agent 解析引擎 JSON 后行动，而不是自行猜测「现在该写码还是该写规格」。

从你描述一个需求开始，Agent **不会**默认直接改仓库里的代码。

1. **先判定意图**：本轮是需求交付、规格/合约变更，还是与产品无关的技术排错？需求驱动场景下必须先运行 `specflow-engine` / `orchestrator`，依据 JSON 中的 `suggestedAction` 决策。
2. **再绑定需求号**：可以尚无编号；引擎通过 `interaction_required` 引导选择或输入，产物写入业务项目的 `ai-docs/<需求号>/`（**不**随本插件仓库分发）。
3. **Specify**：先闭合产品/验收澄清，再把模糊意图收敛为可验收的 `specify.md`；正式文档只保留答案，未闭合问题不得进入 Plan。
4. **Plan**：在规格评审与代码规范评估通过后，产出 `plan.md`（设计、契约、Roadmap）。
5. **Implement / QA**：按 Roadmap **Group** 推进实现；整组 `ready-for-qa` 后由验收子代理把关，通过才标记完成。
6. **Change（并行轨）**：PRD、接口字段、契约变动走 `sync-document`，与 implement 链**互斥**——先同步文档，再继续实现。
7. **Archive**：任务全部完成后归档，演进全局业务与规范资产。

编排层在关键人机点使用 **AskQuestion**（或与引擎 `questions` 对齐的确认项）。**违反流程的字面步骤，等于违反流程的精神。**

## Installation

安装方式因宿主而异；若使用多个 IDE，需在各自环境中分别安装。

### Cursor

**Marketplace（推荐）**

1. 打开 Cursor **Marketplace**，搜索 **SpecFlow** 并安装。
2. 执行 **Developer: Reload Window**。

尚未上架时，可向 [Cursor 插件发布页](https://cursor.com/marketplace/publish) 提交本仓库：[github.com/PhecAI/specflow](https://github.com/PhecAI/specflow)。

**从源码安装**

```bash
git clone https://github.com/PhecAI/specflow.git
cd specflow
npm run install:local
```

复制到 `~/.cursor/plugins/local/specflow` 后 Reload Window。详见 [docs/development.md](docs/development.md)。

### 环境要求

- **Node.js** ≥ 18（`tools/*.cjs` 编排脚本）
- **Cursor Hooks**：`sessionStart` 脚本需 **bash**（macOS / Linux；Windows 建议 WSL）

## The Basic Workflow

下列阶段由引擎与编排器衔接；**未满足门禁则不会派发下一阶段子代理**。

1. **using-specflow** — 总闸。识别 PRD、验收点、接口字段、`ai-docs` 等需求驱动输入；**先跑引擎再行动**。可由 `sessionStart` Hook 自动注入上下文。

2. **specflow-engine / orchestrator** — 读取 `ai-docs` 物理状态与 `specflow-state.json`，输出当前环节、`suggestedAction`（含 `dispatch`、`interaction_required`、`anchor` 等）。

3. **Init** — 需求初始化。确定需求号，初始化 `global-assets` 骨架，确认业务领域，确保 `architecture-layers.md` 存在。

4. **specifying-specflow** — Specify 阶段。先管理产品/验收澄清，再产出不含未闭合问题的 `specify.md`。

5. **Plan Readiness** — 技术方案准备。架构师级规格评审，技术澄清或放行；门禁状态进入 `.temp/gates.json`。

6. **planning-specflow** — Plan 阶段。参考全局 `code-style` 与 `architecture-layers`，产出 `plan.md`；需求内 code-style 只记录增量。

7. **implementing-specflow · qa-specflow** — 按 Group 实现与验收；`manage-state` / `verify` 驱动状态迁移。

8. **syncing-specflow-docs** — 需求/合约/方案变更。`sync-document` 更新 `specify` / `plan`，**禁止**与首轮 implement 混用。

9. **archiving-specflow** — 归档。`archive.cjs` 搬运需求目录、更新历史索引、合并全局资产。

**显式入口**：用户说「开始 Specflow 交付」时，使用 **`specflow`** 技能启动 implement 链（非 change 链）。

## What's Inside

### Skills Library

| 技能                       | 作用                                      |
| -------------------------- | ----------------------------------------- |
| **using-specflow**         | 总闸：需求驱动场景默认启用                |
| **specflow**               | 交付主线显式入口（implement 链）          |
| **orchestrating-specflow** | 编排：解析引擎 JSON、派发子代理、人机确认 |
| **specifying-specflow**    | Specify 阶段指引                          |
| **planning-specflow**      | Plan 阶段指引                             |
| **implementing-specflow**  | Implement 阶段指引                        |
| **qa-specflow**            | QA 验收指引                               |
| **syncing-specflow-docs**  | 文档同步（change 路径）                   |
| **archiving-specflow**     | Archive 阶段指引                          |

### Agents

阶段子代理（独立上下文，由编排器 `dispatch`）：

`specflow-specify` · `specflow-specify-review` · `specflow-code-style-explorer` · `specflow-plan` · `specflow-implement` · `specflow-qa` · `specflow-archive` · `specflow-domain-explorer` · `specflow-knowledge-reviewer` · `inventory-scanner`

### Tools & Engine

可执行脚本位于 `tools/`（需 Node ≥ 18）：

| 脚本                  | 作用                                   |
| --------------------- | -------------------------------------- |
| `specflow-engine.cjs` | 环节判定、门禁、`interaction_required` |
| `orchestrator.cjs`    | `implement` / `change` 编排入口        |
| `gates.cjs`           | 统一门禁状态机（`.temp/gates.json`）   |
| `manage-state.cjs`    | 运行态、Group、评审 ack 兼容入口       |
| `sync-document.cjs`   | 结构化更新 specify / plan              |
| `verify.cjs`          | 送测前校验                             |
| `archive.cjs`         | 物理归档                               |

协议与模板：`protocols/`、`templates/`。运维与用户可见话术：`docs/`。

### Hooks

`hooks/hooks.json` 在 **`sessionStart`** 注入 `using-specflow` 全文，保证新会话即具备总闸约束。

## Philosophy

- **引擎驱动为先** — 流程真相在 `tools/*.cjs` 与状态机，不在聊天里的「我记得下一步」
- **Harness 只做执行面** — 宿主上的 Skills / Agents / Hooks 服从引擎 `suggestedAction`，不越权改阶段
- **SDD：规格先行** — 可验收规格与技术方案落盘后再实现；`ai-docs` 为单一事实来源
- **变更与实现分离** — 改规格/契约走 sync；写代码走 implement，禁止混轨
- **分组交付与证据** — Roadmap Group + QA 闭环；未送测、未验收、未闭合澄清，不得标记完成

## License

MIT License — 见 [LICENSE](LICENSE) 文件。

## Links

- **仓库**：https://github.com/PhecAI/specflow
- **问题反馈**：https://github.com/PhecAI/specflow/issues
