/**
 * 验证门禁：执行 Shell 命令，返回真实 Log；仅 ok === true 时允许更新 plan 进度。
 * ok === false 时附带 suggestion，便于 Subagent 针对性修复。
 *
 * 用法:
 *   统一: PLUGIN_ROOT=/path/to/specflow node "$PLUGIN_ROOT/tools/verify.cjs" [workspaceRoot] [--command "pnpm run lint:changed"]
 *   统一(带需求号): PLUGIN_ROOT=/path/to/specflow node "$PLUGIN_ROOT/tools/verify.cjs" [workspaceRoot] [--requirement-id <需求号>] [--command "pnpm run lint:changed"]
 *
 * 输出: JSON 到 stdout，{ ok, exitCode, stdout, stderr [, suggestion] }
 */

const child_process = require('child_process');
const fs = require('fs');
const path = require('path');

const UTF8 = 'utf-8';

function parseArgs() {
  const { parseCliArgs, resolveWorkspace, resolveRequirementId } = require('./cli-args.cjs');
  const { named, boolFlags, positional } = parseCliArgs(process.argv.slice(2));

  const workspaceRoot = resolveWorkspace(named, positional, 0);
  const requirementId = resolveRequirementId(named, positional, 1);
  const command = named['command'] || '';
  const commandProvided = Boolean(named['command']);

  return { workspaceRoot, command, commandProvided, requirementId };
}

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, UTF8));
  } catch {
    return fallback;
  }
}

function detectPackageManager(workspaceRoot, pkg) {
  const pm = String((pkg && pkg.packageManager) || '').toLowerCase();
  if (pm.startsWith('pnpm')) return 'pnpm';
  if (pm.startsWith('yarn')) return 'yarn';
  if (pm.startsWith('npm')) return 'npm';
  if (fs.existsSync(path.join(workspaceRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(workspaceRoot, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function detectValidationCommands(workspaceRoot) {
  const commands = [];
  /** 用户可见提示：当检测到 ESLint 但仓库未配置增量脚本时给出配置建议 */
  const hints = [];
  const lintRulesDetected = {
    eslint: false,
    prettier: false,
    tsconfig: false,
  };
  lintRulesDetected.eslint =
    fs.existsSync(path.join(workspaceRoot, '.eslintrc')) ||
    fs.existsSync(path.join(workspaceRoot, '.eslintrc.json')) ||
    fs.existsSync(path.join(workspaceRoot, '.eslintrc.js')) ||
    fs.existsSync(path.join(workspaceRoot, '.eslintrc.cjs')) ||
    fs.existsSync(path.join(workspaceRoot, 'eslint.config.js')) ||
    fs.existsSync(path.join(workspaceRoot, 'eslint.config.cjs')) ||
    fs.existsSync(path.join(workspaceRoot, 'eslint.config.mjs'));
  lintRulesDetected.prettier =
    fs.existsSync(path.join(workspaceRoot, '.prettierrc')) ||
    fs.existsSync(path.join(workspaceRoot, '.prettierrc.json'));
  lintRulesDetected.tsconfig = fs.existsSync(path.join(workspaceRoot, 'tsconfig.json'));

  const pkgPath = path.join(workspaceRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = safeReadJson(pkgPath, {});
    const scripts = (pkg && pkg.scripts) || {};
    const pm = detectPackageManager(workspaceRoot, pkg);
    const run = (name) =>
      pm === 'pnpm' ? `pnpm run ${name}` : pm === 'yarn' ? `yarn ${name}` : `npm run ${name} --silent`;

    // === 硬约束：禁止全量 lint ===
    // 仅允许增量脚本 lint:changed / lintChanged；已删除原 scripts.lint / scripts.check 全量 fallback。
    let lintScheduled = false;
    if (scripts['lint:changed']) {
      commands.push(run('lint:changed'));
      lintScheduled = true;
    } else if (scripts.lintChanged) {
      commands.push(run('lintChanged'));
      lintScheduled = true;
    }
    if (lintRulesDetected.eslint && !lintScheduled) {
      hints.push(
        '检测到 ESLint 配置但未提供 lint:changed / lintChanged 脚本；按硬约束禁止全量 lint，本轮跳过 lint。建议在 package.json 增加 "lint:changed": "eslint --max-warnings=0 $(git diff --name-only --diff-filter=ACMR HEAD | grep -E \\"\\\\.(js|jsx|ts|tsx|vue)$\\" || echo)" 或类似增量脚本。',
      );
    }

    // typecheck（tsc 自带 incremental，非"全量 lint"范畴，保留）
    if (scripts.typecheck) commands.push(run('typecheck'));
  }

  if (fs.existsSync(path.join(workspaceRoot, 'go.mod'))) {
    commands.push('go test ./...');
  }
  if (
    fs.existsSync(path.join(workspaceRoot, 'pyproject.toml')) ||
    fs.existsSync(path.join(workspaceRoot, 'requirements.txt'))
  ) {
    commands.push('python -m pytest -q');
  }
  if (commands.length === 0) {
    commands.push('node -e "process.exit(0)"');
  }
  return { commands, lintRulesDetected, hints };
}

function extractCodeStyleHints(workspaceRoot) {
  const codeStylePath = path.join(
    workspaceRoot,
    'ai-docs',
    'global-assets',
    'standards',
    'code-style.md'
  );
  if (!require('fs').existsSync(codeStylePath)) return [];
  try {
    const content = require('fs').readFileSync(codeStylePath, UTF8);
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => line.replace(/^- /, '').trim())
      .filter(Boolean)
      .slice(0, 20);
  } catch {
    return [];
  }
}

function parseCodeStyleHardRules(workspaceRoot) {
  const codeStylePath = path.join(
    workspaceRoot,
    'ai-docs',
    'global-assets',
    'standards',
    'code-style.md'
  );
  if (!fs.existsSync(codeStylePath)) return { hardRules: [], missingHardRules: [] };
  const content = fs.readFileSync(codeStylePath, UTF8);
  const lines = content.split('\n');

  // 1) 解析 “模式描述模板” 的映射：STYLE-XXXX -> verify
  // 形如：
  // > **规范编号**：STYLE-0001
  // > **验证方式**：command: npm run lint
  const styleVerify = new Map();
  let currentId = '';
  for (const raw of lines) {
    const line = raw.trim();
    const idMatch = line.match(/^>\s*\*\*规范编号\*\*：\s*(STYLE-\d{4,})\s*$/);
    if (idMatch) {
      currentId = idMatch[1];
      continue;
    }
    const verifyMatch = line.match(/^>\s*\*\*验证方式\*\*：\s*(.+)\s*$/);
    if (verifyMatch && currentId) {
      const v = verifyMatch[1].trim();
      if (v.toLowerCase().startsWith('command:')) {
        styleVerify.set(currentId, { type: 'command', value: v.slice('command:'.length).trim() });
      } else if (v.toLowerCase().startsWith('regex:')) {
        styleVerify.set(currentId, { type: 'regex', value: v.slice('regex:'.length).trim() });
      } else {
        // 允许直接写命令
        styleVerify.set(currentId, { type: 'command', value: v });
      }
      currentId = '';
    }
  }

  // 2) 解析 [Hard] 规则行
  const hardRules = [];
  for (const raw of lines) {
    const line = raw.trim();
    const hardMatch = line.match(/^\[Hard\]\s*(STYLE-\d{4,})\s*:\s*(.+)\s*$/);
    if (!hardMatch) continue;
    const id = hardMatch[1];
    const desc = hardMatch[2];
    const verify = styleVerify.get(id);
    hardRules.push({ id, desc, verify: verify || null });
  }

  const missingHardRules = hardRules.filter((r) => !r.verify).map((r) => r.id);
  return { hardRules, missingHardRules };
}

/** 从 stdout/stderr 提取首条可定位错误，供 Subagent 针对性修复 */
/** 从测试/构建输出粗估失败用例数（verify 未通过时）；无法解析则至少为 1 */
function extractFailedTestCount(ok, stdout, stderr) {
  if (ok) return 0
  const combined = `${stderr || ''}\n${stdout || ''}`
  const patterns = [
    /(\d+)\s+failed/i,
    /Tests:\s+[^,\n]*,\s*(\d+)\s+failed/i,
    /=\s*(\d+)\s+failed/i,
    /\b(\d+)\s+errors?\b/i,
  ]
  for (const re of patterns) {
    const m = combined.match(re)
    if (m) return Math.min(99, Math.max(1, parseInt(m[1], 10)))
  }
  return 1
}

function resolveVerifyLastDir(workspaceRoot, requirementId) {
  if (requirementId) return path.join(workspaceRoot, 'ai-docs', requirementId, '.temp')
  return path.join(workspaceRoot, 'ai-docs', '.temp')
}

function writeVerifyLastArtifact(workspaceRoot, requirementId, payload) {
  const dir = resolveVerifyLastDir(workspaceRoot, requirementId)
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'verify-last.json'), JSON.stringify(payload, null, 2), UTF8)
  } catch (_) {
    // 忽略落盘失败
  }
}

function extractSuggestion(stdout, stderr) {
  const combined = (stderr + '\n' + stdout).trim();
  if (!combined) return undefined;

  // 1. ESLint/TS Error: src/foo.ts:10:5: error message
  const lintMatch = combined.match(/([a-zA-Z0-9_\-\/]+\.(ts|js|vue|css|scss)):(\d+):(\d+):(.+)/);
  if (lintMatch) {
    return `请检查 ${lintMatch[1]} 第 ${lintMatch[3]} 行: ${lintMatch[5].trim()}`;
  }

  // 2. Build Error
  if (combined.includes('Error:') || combined.includes('Failed to')) {
    const lines = combined.split('\n').filter(line => line.includes('Error:') || line.includes('Failed to'));
    return `构建/执行失败: ${lines[0] || '未知错误'}`;
  }

  return undefined;
}

function normalizeGateCommand(command) {
  const raw = String(command || '').trim();
  if (!raw) return raw;

  // 门禁阶段只需要通过性验证：若命令基于 vitest，默认关闭覆盖率统计和 HTML 报告产物。
  const mentionsVitest =
    /\bvitest\b/.test(raw) ||
    /\b(?:pnpm|npm|yarn)\s+(?:run\s+)?test\b/.test(raw);
  if (!mentionsVitest) return raw;

  const hasCoverageArg =
    /--coverage(?:\b|[.=])/.test(raw) ||
    /--no-coverage\b/.test(raw) ||
    /--coverage\.enabled(?:=|\s+)/.test(raw);
  if (hasCoverageArg) return raw;

  return `${raw} --coverage.enabled=false`;
}

function main() {
  const { workspaceRoot, command, commandProvided, requirementId } = parseArgs();
  const detected = commandProvided
    ? { commands: [], lintRulesDetected: null, hints: [] }
    : detectValidationCommands(workspaceRoot);
  const autoDetectedCommands = commandProvided ? [] : detected.commands;
  const detectionHints = Array.isArray(detected.hints) ? detected.hints : [];
  const selectedCommand = commandProvided ? command : autoDetectedCommands[0];
  const effectiveCommand = normalizeGateCommand(selectedCommand);
  const { hardRules, missingHardRules } = parseCodeStyleHardRules(workspaceRoot);
  const contractOk = missingHardRules.length === 0;

  try {
    // 限制 timeout 60s
    const result = child_process.spawnSync(effectiveCommand, {
      cwd: workspaceRoot,
      shell: true,
      encoding: UTF8,
      timeout: 60000,
    });

    const ok = result.status === 0 && contractOk;
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';

    const evidenceMarkers = [];
    const evRe = /\[SPECFLOW-EVIDENCE\]\s*:\s*(.+)\s*$/gm;
    let ev;
    while ((ev = evRe.exec(stdout)) !== null) {
      const s = String(ev[1] || '').trim();
      if (s) evidenceMarkers.push(s.slice(0, 500));
      if (evidenceMarkers.length >= 10) break;
    }
    
    const failedTestsCount = ok ? 0 : Math.max(1, extractFailedTestCount(false, stdout, stderr))

    const output = {
      ok,
      exitCode: result.status,
      failedTestsCount,
      stdout: stdout.slice(0, 2000), // 截断防爆
      stderr: stderr.slice(0, 2000),
      codeStyleHints: extractCodeStyleHints(workspaceRoot),
      hardRules,
      missingHardRules,
      evidenceMarkers,
      selectedCommand: effectiveCommand,
      originalCommand: selectedCommand,
      autoDetectedCommands,
      lintRulesDetected: detected.lintRulesDetected,
      detectionHints,
    }

    writeVerifyLastArtifact(workspaceRoot, requirementId, {
      ok,
      exitCode: result.status,
      failedTestsCount,
      selectedCommand: effectiveCommand,
      originalCommand: selectedCommand,
      at: new Date().toISOString(),
    })

    if (!ok) {
      if (!contractOk) {
        output.suggestion = `code-style.md 存在 [Hard] 规则但缺少“验证方式”映射: ${missingHardRules.join(', ')}`;
      } else {
      output.suggestion = extractSuggestion(stdout, stderr);
      }
    }

    console.log(JSON.stringify(output, null, 2));

  } catch (e) {
    const errPayload = {
      ok: false,
      exitCode: -1,
      failedTestsCount: 1,
      stdout: '',
      stderr: String(e),
      suggestion: '命令执行异常，请检查环境或命令拼写',
    }
    writeVerifyLastArtifact(workspaceRoot, requirementId, {
      ok: false,
      exitCode: -1,
      failedTestsCount: 1,
      selectedCommand: selectedCommand || '',
      originalCommand: selectedCommand || '',
      at: new Date().toISOString(),
    })
    console.log(JSON.stringify(errPayload, null, 2))
  }
}

if (require.main === module) {
  main();
}
