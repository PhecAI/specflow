/**
 * 读取引擎落盘的 pending-protocol.json，输出 Markdown。
 * 用法:
 *   统一: PLUGIN_ROOT=/path/to/specflow node "$PLUGIN_ROOT/tools/print-protocol.cjs" [workspaceRoot] <需求号> [--agent|--human|--task-prompt]
 *   默认 --agent：编排/子代理核对用（含 agent、phase、focus 等机读字段）
 *   --human：仅输出面向终端用户的下一步说明（渐进披露，不含内部字段名）
 *   --task-prompt：输出 Task tool 调用模板（含并行/串行标注），供 Cursor Agent 直接 copy 使用
 */

const fs = require('fs')
const path = require('path')
const { buildDispatchPreviewMarkdown } = require('./user-facing.cjs')
const { readState } = require('./specflow-state.cjs')
const { parseCliArgs, resolveWorkspace, resolveRequirementId } = require('./cli-args.cjs')

// Declare FOCUS_FIELDS at the top so it's available to all functions,
// regardless of which early-exit branch is taken below.
const FOCUS_FIELDS = ['knowledgePolicy', 'knowledgeContext', 'focusPlan', 'focusSpecify', 'focusArchive']

const { named, boolFlags, positional } = parseCliArgs(process.argv.slice(2))

// Output mode: --human | --agent | --task-prompt | --mode=<value>
let mode = named['mode'] || 'agent'
if (boolFlags.has('human') || named['mode'] === 'human') mode = 'human'
if (boolFlags.has('agent') || named['mode'] === 'agent') mode = 'agent'
if (boolFlags.has('task-prompt') || named['mode'] === 'task-prompt') mode = 'task-prompt'

// --group <id> or --group=<id>: both are now handled by parseCliArgs
let groupFilter = named['group'] || ''

const workspaceRoot = resolveWorkspace(named, positional, 0)
const reqId = resolveRequirementId(named, positional, 1)

if (!reqId) {
  console.error('用法: node print-protocol.cjs [workspaceRoot] <需求号> [--agent|--human|--task-prompt] [--group <id>]')
  console.error('      或: node print-protocol.cjs --workspace <path> --requirement-id <id> [--mode agent|human|task-prompt]')
  process.exit(1)
}

const protocolPath = path.join(workspaceRoot, 'ai-docs', reqId, '.temp', 'pending-protocol.json')
const scriptsDir = __dirname

if (mode === 'human') {
  const md = buildDispatchPreviewMarkdown(workspaceRoot, reqId, scriptsDir)
  process.stdout.write(md)
  process.exit(0)
}

if (mode === 'task-prompt') {
  if (!fs.existsSync(protocolPath)) {
    console.log('⚠️ 未找到待派发协议文件 (pending-protocol.json)，请先运行 specflow-engine.cjs')
    process.exit(0)
  }
  const taskData = JSON.parse(fs.readFileSync(protocolPath, 'utf-8'))
  console.log(buildTaskPromptOutput(taskData, groupFilter))
  process.exit(0)
}

if (!fs.existsSync(protocolPath)) {
  console.log('⚠️ 未找到待派发协议文件 (pending-protocol.json)，请先运行 specflow-engine.cjs')
  process.exit(0)
}

const data = JSON.parse(fs.readFileSync(protocolPath, 'utf-8'))

/** 构建单条协议的 Markdown 文本（返回字符串，不直接打印）。 */
function buildSingleProtocolText(payload, headingSuffix, dataRef) {
  const lines = []
  const contextSummary = Object.entries({
    context: payload.context,
    mode: payload.mode,
  })
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' | ')

  const heading = headingSuffix
    ? `## 本次派发协议 (Dispatch Protocol) — ${headingSuffix}\n`
    : '## 本次派发协议 (Dispatch Protocol)\n'
  lines.push(heading)
  lines.push(`- **agent**: \`${payload.agent}\``)
  lines.push(`- **requirementId**: \`${payload.requirementId || (dataRef && dataRef.requirementId)}\``)
  lines.push(`- **phase**: \`${payload.phase || (dataRef && dataRef.phase)}\``)
  if (payload.groupId) lines.push(`- **groupId**: \`${payload.groupId}\``)
  if (contextSummary) lines.push(`- **context 摘要**: ${contextSummary}`)

  for (const field of FOCUS_FIELDS) {
    if (!payload[field]) continue
    lines.push(`\n### ${field}\n`)
    lines.push(typeof payload[field] === 'string' ? payload[field] : JSON.stringify(payload[field], null, 2))
  }

  if (payload.knowledgePolicy && payload.knowledgePolicy.required) {
    lines.push('\n### Agent 执行提醒\n')
    lines.push('- 必须先完成相关性决策卡，再编码/验收。')
    lines.push('- 必须在日志存证中回填 Knowledge Rules Used。')
  }
  return lines.join('\n')
}

function printSingleProtocol(payload, headingSuffix) {
  console.log(buildSingleProtocolText(payload, headingSuffix, data))
}

/** 构建 --task-prompt 模式输出：Task tool 调用模板，含并行/串行标注。 */
function buildTaskPromptOutput(data, groupFilter) {
  const lines = []
  lines.push('## Task Tool 调用模板（--task-prompt）')
  lines.push('')
  lines.push('> 将下方 Task tool 调用复制到编排消息中。')
  lines.push('> prompt 字段已包含子代理所需的完整协议上下文（来自 print-protocol --agent）。')
  lines.push('')

  if (data.kind === 'dispatch_array' && Array.isArray(data.items)) {
    const items = groupFilter
      ? data.items.filter((it) => String(it.groupId || '').trim() === groupFilter)
      : data.items

    // 判断是否有依赖：任一 item 含非空 dependsOn 则需串行
    const hasDeps = items.some((it) => Array.isArray(it.dependsOn) && it.dependsOn.length > 0)

    if (hasDeps) {
      lines.push(`**模式：dispatch_array（含依赖，必须串行执行）**`)
      lines.push('')
      // 拓扑排序：简单起见，对有 dependsOn 的 item 排在依赖方之后
      const sorted = topologicalSort(items)
      sorted.forEach((item, idx) => {
        const deps = (item.dependsOn || []).join(', ')
        const depsNote = deps ? `（前置: ${deps} 完成后再执行）` : '（无前置依赖，第一批执行）'
        const reqId = item.requirementId || data.requirementId
        const desc = `${item.agent} — ${item.groupId || 'Group'} [${reqId}]`
        const protocolText = buildSingleProtocolText(
          { ...item, requirementId: reqId, phase: item.phase || data.phase,
            knowledgeContext: item.knowledgeContext || data.knowledgeContext,
            knowledgePolicy: item.knowledgePolicy || data.knowledgePolicy },
          item.groupId,
          data
        )
        lines.push(`### 第 ${idx + 1} 步 ${depsNote}`)
        lines.push('')
        lines.push('```')
        lines.push(`Task(`)
        lines.push(`  subagent_type = "${item.agent}",`)
        lines.push(`  description  = "${desc}",`)
        lines.push(`  prompt       = """`)
        lines.push(protocolText)
        lines.push(`  """`)
        lines.push(`)`)
        lines.push('```')
        lines.push('')
      })
    } else {
      lines.push(`**模式：dispatch_array（${items.length} 个 Group，无依赖 → 同一消息内并行发起）**`)
      lines.push('')
      lines.push('> 在**同一消息**中同时发起以下所有 Task tool call（并行执行）。')
      lines.push('')
      items.forEach((item, idx) => {
        const reqId = item.requirementId || data.requirementId
        const desc = `${item.agent} — ${item.groupId || 'Group'} [${reqId}]`
        const protocolText = buildSingleProtocolText(
          { ...item, requirementId: reqId, phase: item.phase || data.phase,
            knowledgeContext: item.knowledgeContext || data.knowledgeContext,
            knowledgePolicy: item.knowledgePolicy || data.knowledgePolicy },
          item.groupId,
          data
        )
        lines.push(`### Task ${idx + 1} — ${item.groupId || `Group ${idx + 1}`} (${item.agent})`)
        lines.push('')
        lines.push('```')
        lines.push(`Task(`)
        lines.push(`  subagent_type = "${item.agent}",`)
        lines.push(`  description  = "${desc}",`)
        lines.push(`  prompt       = """`)
        lines.push(protocolText)
        lines.push(`  """`)
        lines.push(`)`)
        lines.push('```')
        lines.push('')
      })
    }
  } else {
    // 单 dispatch
    const reqId = data.requirementId
    const desc = `${data.agent} [${reqId}]`
    const protocolText = buildSingleProtocolText(data, undefined, data)
    lines.push(`**模式：单 dispatch（${data.agent}）**`)
    lines.push('')
    lines.push('```')
    lines.push(`Task(`)
    lines.push(`  subagent_type = "${data.agent}",`)
    lines.push(`  description  = "${desc}",`)
    lines.push(`  prompt       = """`)
    lines.push(protocolText)
    lines.push(`  """`)
    lines.push(`)`)
    lines.push('```')
    lines.push('')
  }

  return lines.join('\n')
}

/** 按 dependsOn 做简单拓扑排序（Kahn 算法）；无依赖项排在前面。 */
function topologicalSort(items) {
  const idMap = {}
  items.forEach((it) => { if (it.groupId) idMap[it.groupId] = it })

  const inDegree = {}
  const adj = {}
  items.forEach((it) => {
    inDegree[it.groupId || it.agent] = 0
    adj[it.groupId || it.agent] = []
  })
  items.forEach((it) => {
    const key = it.groupId || it.agent
    ;(it.dependsOn || []).forEach((dep) => {
      if (adj[dep]) {
        adj[dep].push(key)
        inDegree[key] = (inDegree[key] || 0) + 1
      }
    })
  })

  const queue = items.filter((it) => (inDegree[it.groupId || it.agent] || 0) === 0)
  const result = []
  while (queue.length) {
    const cur = queue.shift()
    result.push(cur)
    const key = cur.groupId || cur.agent
    ;(adj[key] || []).forEach((next) => {
      inDegree[next]--
      if (inDegree[next] === 0) {
        const nextItem = items.find((it) => (it.groupId || it.agent) === next)
        if (nextItem) queue.push(nextItem)
      }
    })
  }
  // 若有循环依赖，把剩余 item 追加到末尾
  items.forEach((it) => { if (!result.includes(it)) result.push(it) })
  return result
}

if (data.kind === 'dispatch_array' && Array.isArray(data.items)) {
  const items = groupFilter
    ? data.items.filter((it) => String(it.groupId || '').trim() === groupFilter)
    : data.items
  if (groupFilter && items.length === 0) {
    console.log(`⚠️ 未找到 groupId=\`${groupFilter}\` 的派发协议；本批可用 groupId：${data.items.map((it) => it.groupId).filter(Boolean).join(', ') || '（无）'}`)
  } else {
    console.log(`## 本批并行派发（共 ${data.items.length} 个 Group Pipeline${groupFilter ? `，已按 groupId=${groupFilter} 过滤` : ''}）\n`)
    if (data.waitPolicy || data.groupIsolation === true) {
      const waitPolicy = data.waitPolicy || 'unspecified'
      const isolation = data.groupIsolation === true ? 'enabled' : 'disabled'
      console.log(`- 调度策略: waitPolicy=\`${waitPolicy}\` | groupIsolation=\`${isolation}\``)
      console.log('')
    }
    for (const item of items) {
      printSingleProtocol(
        {
          ...item,
          requirementId: data.requirementId,
          phase: data.phase,
          knowledgeContext: data.knowledgeContext,
          knowledgePolicy: data.knowledgePolicy,
        },
        item.groupId ? `${item.groupId}` : undefined,
      )
      console.log('\n---\n')
    }
  }
} else {
  printSingleProtocol(data)
}

try {
  const reqDir = path.join(workspaceRoot, 'ai-docs', reqId)
  const st = readState(reqDir)
  if (st.residual && typeof st.residual.totalScore === 'number') {
    const r = st.residual
    console.log('\n### 结构化残差 (residual)\n')
    console.log(
      `- totalScore: ${r.totalScore}（AC 未闭环 ${r.unmetAcCount} | verify 未过 ${r.failedTestsCount} | 门禁 ${r.openGatesCount} | 待验收证据 ${r.missingEvidencesCount}）`,
    )
    if (Array.isArray(st.metricsHistory) && st.metricsHistory.length > 0) {
      const last = st.metricsHistory[st.metricsHistory.length - 1]
      console.log(`- 最近快照: turn ${last.turn} → totalResidual ${last.totalResidual}`)
    }
  }
} catch (_) {}
