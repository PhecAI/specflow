# 开发与本地安装

面向贡献者与内部试用，从本仓库安装 Cursor 本地插件。

## 前置

- Node.js ≥ 18
- Cursor（支持 Hooks）

## 安装步骤

```bash
git clone https://github.com/PhecAI/specflow.git
cd specflow
npm run install:local
```

脚本会将仓库复制到 `~/.cursor/plugins/local/specflow`（若已存在则覆盖）。

在 Cursor 执行 **Developer: Reload Window**。

## 验证

- Skills / Agents 列表中可见 `specflow`、`using-specflow` 等
- 新会话 `sessionStart` 会注入 `skills/using-specflow/SKILL.md` 全文

## 测试

```bash
npm test
```

## 路径约定

- Manifest：`.cursor-plugin/plugin.json`（`skills` / `agents` / `hooks` 为相对路径）
- Hook：`hooks/specflow-session-start.sh` 优先使用 `CURSOR_PLUGIN_ROOT`，否则由脚本位置反推插件根

## 业务工作区数据

`ai-docs/` 属于**用户业务项目**下的工作区目录，已加入 `.gitignore`，请勿提交到本插件仓库。
