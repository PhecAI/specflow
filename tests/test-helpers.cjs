const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** 插件根目录与运行时工具目录 */
const PLUGIN_ROOT = path.join(__dirname, '..');
const TOOLS_DIR = path.join(PLUGIN_ROOT, 'tools');
const ENGINE = path.join(TOOLS_DIR, 'specflow-engine.cjs');
const ORCHESTRATOR = path.join(TOOLS_DIR, 'orchestrator.cjs');
const MANAGE_STATE = path.join(TOOLS_DIR, 'manage-state.cjs');

/**
 * 解析引擎 stdout（仅 JSON）。
 */
function parseEngineJson(stdout) {
  const t = stdout.trim();
  const i = t.indexOf('{');
  if (i === -1) throw new Error(`No JSON in stdout: ${t.slice(0, 200)}`);
  return JSON.parse(t.slice(i));
}

/**
 * @param {string} workspaceRoot
 * @param {string} [requirementId] — 不传则引擎走「无需求号」分支
 */
function runEngine(workspaceRoot, requirementId) {
  const args = [ENGINE, workspaceRoot];
  if (requirementId !== undefined && requirementId !== null && requirementId !== '') {
    args.push(String(requirementId));
  }
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

/**
 * @param {string} workspaceRoot
 * @param {string} requirementId
 * @param {string} action - manage-state action
 * @param {string[]} [extraArgs]
 */
function runManageState(workspaceRoot, requirementId, action, extraArgs = [], options = {}) {
  const env = options.env ? { ...process.env, ...options.env } : process.env;
  return spawnSync(process.execPath, [MANAGE_STATE, action, workspaceRoot, requirementId, ...extraArgs], {
    encoding: 'utf8',
    env,
  });
}

function runOrchestratorImplement(workspaceRoot, requirementId) {
  return spawnSync(process.execPath, [ORCHESTRATOR, 'implement', workspaceRoot, requirementId], {
    encoding: 'utf8',
  });
}

function runOrchestratorBadMode(workspaceRoot) {
  return spawnSync(process.execPath, [ORCHESTRATOR, 'bad', workspaceRoot, 'x', 'y'], {
    encoding: 'utf8',
  });
}

/** 临时工作区（放在仓库根 `.tmp/` 下，便于 CI/沙箱仅允许写 workspace 时仍可跑需 git 的用例） */
function mkWorkspace() {
  const baseDir = path.join(os.tmpdir(), 'specflow-tests');
  fs.mkdirSync(baseDir, { recursive: true });
  return fs.mkdtempSync(path.join(baseDir, 'specflow-test-'));
}

/** 空模板：不安装 sample hooks，避免 CI/沙箱对 .git/hooks 写权限问题 */
const EMPTY_GIT_TEMPLATE = path.join(__dirname, 'fixtures', 'git-empty-template');

/** 初始化 git 并切到指定分支名（可含 /） */
function initGitWorkspace(root, branchName) {
  execSync('git init', {
    cwd: root,
    stdio: 'pipe',
    env: { ...process.env, GIT_TEMPLATE_DIR: EMPTY_GIT_TEMPLATE },
  });
  execSync('git config user.email "specflow-test@local"', { cwd: root, stdio: 'pipe' });
  execSync('git config user.name "specflow-test"', { cwd: root, stdio: 'pipe' });
  fs.writeFileSync(path.join(root, '.gitkeep'), '');
  execSync('git add . && git commit -m init --quiet', { cwd: root, stdio: 'pipe' });
  execSync(`git checkout -b ${branchName}`, { cwd: root, stdio: 'pipe' });
}

/** 在 ai-docs 下创建需求目录并写入占位文件（用于最近需求排序） */
function touchRequirementDir(workspaceRoot, id, content = 'x') {
  const d = path.join(workspaceRoot, 'ai-docs', id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'note.txt'), content, 'utf8');
}

module.exports = {
  PLUGIN_ROOT,
  TOOLS_DIR,
  ENGINE,
  ORCHESTRATOR,
  MANAGE_STATE,
  parseEngineJson,
  runEngine,
  runManageState,
  runOrchestratorImplement,
  runOrchestratorBadMode,
  mkWorkspace,
  initGitWorkspace,
  touchRequirementDir,
};
