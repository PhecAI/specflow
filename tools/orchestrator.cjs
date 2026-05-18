/**
 * SpecFlow Orchestrator
 *
 * 统一入口，将「实现流程」与「需求变更同步」两类操作分流。
 * 「需求变更」在业务上包含：PRD/AC/规则变更，以及 **接口/API 文档到货或更新**（均属需求变动；后者通常落 plan Contract 与代码，入口仍走 change + sync-document，而非直接 implement）。
 *
 * 用法：
 *   实现流程（遵守 specflow-engine 门控）：
 *     统一: PLUGIN_ROOT=/path/to/specflow node "$PLUGIN_ROOT/tools/orchestrator.cjs" implement <workspaceRoot> <需求号>
 *
 *   需求变更（直接同步文档 + 状态刷新；**含合约/接口文档类变更**）：
 *     统一: PLUGIN_ROOT=/path/to/specflow node "$PLUGIN_ROOT/tools/orchestrator.cjs" change <workspaceRoot> <需求号> <payload>
 *       [--target specify|plan|both]
 *       [--change-type patch|refactor|conflict]
 *       [--updates '<json>']
 *       [--updates-file <path>]
 *
 * 输出：
 *   implement 模式：默认透传 specflow-engine.cjs 的 JSON 输出；加 `--human` 时仅输出用户可见 Markdown（由 render-user-facing.cjs 渲染）
 *   change 模式：输出形如
 *     {
 *       "mode": "change",
 *       "sync": { ...sync-document 输出... },
 *       "engine": { ...specflow-engine 输出... }
 *     }
 */

const path = require('path');
const { spawnSync } = require('child_process');
const {
  parseCliArgs,
  resolveWorkspace,
  resolveRequirementId,
} = require('./cli-args.cjs');

function runNodeScript(scriptPath, args, options = {}) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf-8',
    env: options.env || process.env,
  });

  if (result.error) {
    throw result.error;
  }

  return {
    code: typeof result.status === 'number' ? result.status : 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function parseArgs() {
  const { named, boolFlags, positional } = parseCliArgs(process.argv.slice(2));

  // mode: --mode implement|change  OR  first positional
  const mode = (named['mode'] || positional[0] || '').toLowerCase();

  // workspaceRoot / requirementId: named flags OR positional fallback
  // positional layout (without --mode): [workspaceRoot?, requirementId?, payload?]
  const modeFromNamed = Boolean(named['mode']);
  const wsIdx = modeFromNamed ? 0 : 1;
  const ridIdx = modeFromNamed ? 1 : 2;
  const workspaceRoot = resolveWorkspace(named, positional, wsIdx);
  const requirementId = resolveRequirementId(named, positional, ridIdx);

  // payload (change mode only): --payload OR next positional after requirementId
  const hasNamedRid = Boolean(
    named['requirement-id'] ||
    named['requirementId'] ||
    named['rid'] ||
    named['r'],
  );
  const hasNamedWs = Boolean(named['workspace'] || named['ws'] || named['w']);
  const payloadIdx =
    (modeFromNamed ? 0 : 1) + (hasNamedWs ? 0 : 1) + (hasNamedRid ? 0 : 1);
  const payload = named['payload'] || positional[payloadIdx] || '';

  // Collect remaining --flags (pass-through to sub-scripts)
  const flags = [];
  for (const [k, v] of Object.entries(named)) {
    // Skip flags already consumed above
    if (
      [
        'mode',
        'workspace',
        'ws',
        'w',
        'requirement-id',
        'requirementId',
        'rid',
        'r',
        'payload',
      ].includes(k)
    )
      continue;
    flags.push(`--${k}`, v);
  }
  for (const f of boolFlags) {
    flags.push(`--${f}`);
  }

  return { mode, workspaceRoot, requirementId, payload, flags };
}

function main() {
  const { mode, workspaceRoot, requirementId, payload, flags } = parseArgs();

  if (!mode || (mode !== 'implement' && mode !== 'change')) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: '缺少或非法的 mode 参数，应为 "implement" 或 "change"',
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  if (!requirementId) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: '缺少参数: 需求号',
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  const scriptDir = __dirname;
  const enginePath = path.join(scriptDir, 'specflow-engine.cjs');
  const syncPath = path.join(scriptDir, 'sync-document.cjs');

  if (mode === 'implement') {
    const { code, stdout, stderr } = runNodeScript(enginePath, [
      workspaceRoot,
      requirementId,
    ]);
    if (stderr) process.stderr.write(stderr);
    if (flags.includes('--human')) {
      const renderPath = path.join(scriptDir, 'render-user-facing.cjs');
      const rendered = spawnSync(process.execPath, [renderPath], {
        input: stdout,
        encoding: 'utf-8',
      });
      if (rendered.stdout) process.stdout.write(rendered.stdout);
      process.exit(code);
    }
    if (stdout) process.stdout.write(stdout);
    process.exit(code);
  }

  // mode === 'change'：先同步文档，再刷新引擎状态
  const passthroughFlags = flags.filter((f) => f !== '--no-extract');
  if (!passthroughFlags.includes('--extract')) {
    passthroughFlags.push('--extract');
  }
  const syncArgs = [workspaceRoot, requirementId, payload, ...passthroughFlags];
  const syncResult = runNodeScript(syncPath, syncArgs);

  let syncJson = null;
  try {
    syncJson = syncResult.stdout ? JSON.parse(syncResult.stdout) : null;
  } catch {
    // ignore parse error,按失败处理
  }

  if (syncResult.code !== 0 || !syncJson || syncJson.ok === false) {
    const errorPayload = {
      ok: false,
      mode: 'change',
      step: 'sync-document',
      error:
        (syncJson && syncJson.error) ||
        syncResult.stderr ||
        'sync-document 执行失败',
      raw: syncResult.stdout || '',
    };
    console.log(JSON.stringify(errorPayload, null, 2));
    process.exit(1);
  }

  const engineResult = runNodeScript(enginePath, [
    workspaceRoot,
    requirementId,
  ]);

  let engineJson = null;
  try {
    engineJson = engineResult.stdout ? JSON.parse(engineResult.stdout) : null;
  } catch {
    // ignore parse error
  }

  const output = {
    ok: true,
    mode: 'change',
    sync: syncJson,
    engine: engineJson || null,
  };

  if (engineResult.stderr) {
    // 保留引擎 stderr 供调试
    output.engine_stderr = engineResult.stderr;
  }

  console.log(JSON.stringify(output, null, 2));
  process.exit(engineResult.code);
}

if (require.main === module) {
  main();
}
