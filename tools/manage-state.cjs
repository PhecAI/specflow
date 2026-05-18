/**
 * SpecFlow 状态管理器：统一处理 .temp/specflow-state.json 的读写操作与 plan.md 任务状态变更。
 *
 * 用法（统一）: PLUGIN_ROOT=/path/to/specflow node "$PLUGIN_ROOT/tools/manage-state.cjs" <action> [workspaceRoot] <需求号> [额外参数...]
 *
 * Actions:
 *   get              — 输出当前 state JSON
 *   set-archive-anchor  — 设置 archiveAnchorDone: true（用户主动确认归档后调用）
 *   clear-archive-anchor — 删除 archiveAnchorDone 属性（归档完成后调用）
 *   set-code-style-explored — 由 specflow-code-style-explorer 完成需求级规范评估后回写（codeStyleExplored=true + 当前 specify.md mtime）
 *   set-active-group <groupId> [--auto] — 设置当前活跃的 Group ID；**--auto** 开启自动托管（`autoProceedGroups=true`，后续 Group 边界免 confirm）；不带 --auto 会清除自动托管
 *   mark-task <taskId> <status> [evidence] — 变更 plan.md 中指定任务的状态（含转换校验与日志）
 *     status: pending | ready-for-qa | failed | completed
 *     合法转换: pending→ready-for-qa, ready-for-qa→completed, ready-for-qa→failed, failed→ready-for-qa
 *     当 status=completed 时，必须传入 evidence（验收证据摘要，如测试路径或输出摘要），否则拒绝
 *   mark-group <groupId> <status> [evidence] — 以 Group 为单位批量变更状态（闭环推荐）
 *     status: ready-for-qa | failed | completed
 *     ready-for-qa: 批量 pending/failed -> ready-for-qa（只执行一次 verify）
 *     failed/completed: 批量 ready-for-qa -> failed/completed
 *     当 status=completed 时，必须传入 evidence
 *   clear-resource-failed [url] — 从 .temp/resource-load-failed.json 的失败映射中移除：指定 url 则只删该 key；不传 url 则清空整个文件
 *   reset-retry — 重置 groupRetryCount 为 0（死循环保护后人工修复用）
 *   ack-specify-before-plan — 记录用户已在弹窗确认进入 Plan（写入 ackSpecifyBeforePlan + specify.md 的 mtime）
 *   ack-specify-review — 记录架构师已完成对 specify 的评审且无阻塞（写入 specifyReviewPassedMtime = 当前 specify.md mtime；spec 变更后失效）
 *   ack-auto-clarifications — 记录用户已审阅并确认自动解决的澄清（写入 autoClarificationAckMtime = 当前 specify.md mtime）
 *   set-domain-init-pref <scan|skip> [领域标识] — 记录业务知识库领域初始化结果。scan 时必须提供领域标识（如 payment，支持逗号分隔），写入 domainInitSlugs + domainInitSlug(=首个)；并清空 domainInitCandidates。skip 时清除所有领域字段
 *   set-domain-init-candidates <slug_csv> — S1 阶段：agent 分析项目后提交领域候选（逗号分隔），写入 domainInitCandidates；引擎下一轮基于候选生成 N 道 yes/no 采纳题
 *   clear-domain-init-candidates — 清空 domainInitCandidates（用于反悔 / 重新提交）
 *
 * 输出: JSON 到 stdout
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { readState, writeState, mergeState, normalizeDomainInitSlug } = require('./specflow-state.cjs')
const { syncResidualToState } = require('./residual-metrics.cjs')
const { parseMarkdownTree, findByKey, renderNode } = require('./plan-parser.cjs')
const {
  normalizeCodingPatchSection,
  normalizeCodingPatchContent,
  mergeCodingPatches: mergeCodingPatchesShared,
  writeRequirementCodeStyleArtifacts,
} = require('./code-style.cjs')
const { parseDomainMd } = require('./domain-knowledge.cjs')

const ACTIONS = [
  'get',
  'set-archive-anchor',
  'clear-archive-anchor',
  'set-domain-merged',
  'set-knowledge-reviewed',
  'set-code-style-explored',
  'ack-specify-before-plan',
  'ack-specify-review',
  'ack-auto-clarifications',
  'set-domain-init-pref',
  'set-domain-init-candidates',
  'clear-domain-init-candidates',
  'mark-task',
  'mark-group',
  'set-active-group',
  'clear-resource-failed',
  'reset-retry',
]

/** 状态标记与 Markdown checkbox 的映射 */
const STATUS_TO_MARKER = { pending: ' ', 'ready-for-qa': '?', failed: '!', completed: 'x' }
const MARKER_TO_STATUS = { ' ': 'pending', '?': 'ready-for-qa', '!': 'failed', x: 'completed' }

/** 合法的状态转换规则 */
const VALID_TRANSITIONS = {
  pending: ['ready-for-qa'],
  'ready-for-qa': ['completed', 'failed'],
  failed: ['ready-for-qa'],
  completed: [],
}

function fail(error) {
  console.log(JSON.stringify({ ok: false, error }))
  process.exit(1)
}

function resolveDir(workspaceRoot, requirementId) {
  const dir = path.join(workspaceRoot, 'ai-docs', requirementId)
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    fail(`需求目录不存在: ${dir}`)
  }
  return dir
}

function runQualityGateBeforeQA(workspaceRoot, requirementId) {
  const verifyScript = path.join(__dirname, 'verify.cjs')
  const customCommand = (process.env.SPECFLOW_VERIFY_COMMAND || '').trim()
  const args = [verifyScript, workspaceRoot]
  if (requirementId) {
    args.push('--requirement-id', requirementId)
  }
  if (customCommand) {
    args.push('--command', customCommand)
  }
  const result = spawnSync(process.execPath, args, { encoding: 'utf-8' })
  if (result.status !== 0) {
    return { ok: false, error: result.stderr || result.stdout || 'verify 执行失败' }
  }
  try {
    const json = JSON.parse(result.stdout || '{}')
    if (json.ok === true) return { ok: true, verify: json }
    return {
      ok: false,
      error: json.suggestion || json.stderr || '代码规范校验未通过',
      verify: json,
    }
  } catch (e) {
    return { ok: false, error: `verify 输出解析失败: ${e.message || e}` }
  }
}

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return fallback
  }
}

function parseDomainSlugList(input) {
  const raw = String(input || '')
  if (!raw.trim()) return []
  const out = []
  const seen = new Set()
  for (const item of raw.split(',')) {
    const slug = normalizeDomainInitSlug(item)
    if (!slug || seen.has(slug)) continue
    seen.add(slug)
    out.push(slug)
  }
  return out
}

function extractCodingStandardPatchesFromEvidence(evidence) {
  const lines = String(evidence || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const patches = []

  for (const line of lines) {
    // 推荐格式: [CodeStyle] naming: 使用语义化命名
    let m = line.match(/^(?:[-*]\s*)?\[(?:CodeStyle|CodingStyle|代码规范)\]\s*([^:\]]*?)\s*:\s*(.+)$/i)
    if (m) {
      const section = normalizeCodingPatchSection(m[1] || 'general')
      const content = normalizeCodingPatchContent(m[2])
      if (content) {
        patches.push({ section, content, extractedAt: new Date().toISOString() })
      }
      continue
    }

    // 兼容简化格式: CodeStyle: 禁止 any
    m = line.match(/^(?:[-*]\s*)?(?:CodeStyle|CodingStyle|代码规范)\s*:\s*(.+)$/i)
    if (m) {
      const content = normalizeCodingPatchContent(m[1])
      if (content) {
        patches.push({ section: 'general', content, extractedAt: new Date().toISOString() })
      }
    }
  }

  return patches
}

function appendCodingStandardPatchFromFailure(workspaceRoot, requirementId, evidence, planContent) {
  const incoming = extractCodingStandardPatchesFromEvidence(evidence)
  if (incoming.length === 0) {
    return { generated: false, count: 0, appended: 0, path: null }
  }

  const reqTempDir = path.join(workspaceRoot, 'ai-docs', requirementId, '.temp')
  const patchPath = path.join(reqTempDir, 'coding-standard-patch.json')
  const existing = safeReadJson(patchPath, [])
  const merged = mergeCodingPatchesShared(existing, incoming, { sourceRequirementId: requirementId })
  const changed = JSON.stringify(existing || []) !== JSON.stringify(merged)
  if (changed) {
    fs.mkdirSync(reqTempDir, { recursive: true })
    fs.writeFileSync(patchPath, JSON.stringify(merged, null, 2), 'utf-8')
  }
  // 失败补充后刷新需求内 code-style.md，保持“主规范 + 增量”可读视图
  writeRequirementCodeStyleArtifacts(workspaceRoot, requirementId, planContent || '', { mergePatch: true })
  return {
    generated: changed,
    count: incoming.length,
    appended: merged.length - (Array.isArray(existing) ? existing.length : 0),
    path: patchPath,
  }
}

function ensureCodingStandardPatch(workspaceRoot, requirementId, planContent) {
  const out = writeRequirementCodeStyleArtifacts(workspaceRoot, requirementId, planContent || '', {
    mergePatch: true,
  })
  return {
    generated: out.generated,
    count: out.additionsCount || 0,
    extractedCount: out.extractedCount || 0,
    reusedFromGlobalCount: out.reusedFromGlobalCount || 0,
    path: out.patchPath || null,
    requirementCodeStylePath: out.requirementCodeStylePath || null,
  }
}

function normalizeDomainName(raw) {
  return (
    String(raw || 'general')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\-]/g, '-')
      .replace(/\-+/g, '-')
      .replace(/^\-|\-$/g, '') || 'general'
  )
}

function parseSourceRequirementIds(cell) {
  return String(cell || '')
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function rowToPatch(category, row, domain, requirementId) {
  if (!Array.isArray(row)) return null
  const rid = String(requirementId || '').trim()
  switch (category) {
    case 'entity': {
      const term = String(row[0] || '').trim()
      const content = String(row[1] || '').trim()
      const enumText = String(row[2] || '').trim()
      const sourceIds = parseSourceRequirementIds(row[3])
      if (!term && !content && !enumText) return null
      const patch = { domain, category: 'entity', term, content }
      if (enumText) patch.enum = enumText
      patch.sourceRequirementId = sourceIds[0] || rid || null
      return patch
    }
    case 'rule': {
      const scope = String(row[0] || '').trim()
      const content = String(row[1] || '').trim()
      const strengthRaw = String(row[2] || '').trim().toLowerCase()
      const sourceIds = parseSourceRequirementIds(row[3])
      if (!scope && !content) return null
      const patch = { domain, category: 'rule', scope: scope || '通用', content }
      if (strengthRaw === 'hard' || strengthRaw === 'soft') patch.strength = strengthRaw
      patch.sourceRequirementId = sourceIds[0] || rid || null
      return patch
    }
    case 'stateMachine': {
      const from = String(row[0] || '').trim()
      const condition = String(row[1] || '').trim()
      const to = String(row[2] || '').trim()
      const sourceIds = parseSourceRequirementIds(row[3])
      if (!from && !condition && !to) return null
      const patch = { domain, category: 'stateMachine', from, condition, to, content: `${from} -> ${to}`.trim() }
      patch.sourceRequirementId = sourceIds[0] || rid || null
      return patch
    }
    case 'techDebt': {
      const id = String(row[0] || '').trim()
      const content = String(row[1] || '').trim()
      const owner = String(row[2] || '').trim()
      const sourceIds = parseSourceRequirementIds(row[3])
      if (!id && !content && !owner) return null
      const patch = { domain, category: 'techDebt', id, content }
      if (owner) patch.owner = owner
      patch.sourceRequirementId = sourceIds[0] || rid || null
      return patch
    }
    default:
      return null
  }
}

function dedupeKnowledgePatches(existing, incoming) {
  const map = new Map()
  const all = [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]
  for (const patch of all) {
    if (!patch || typeof patch !== 'object') continue
    const domain = normalizeDomainName(patch.domain || 'general')
    const category = String(patch.category || 'rule').trim()
    const content = String(patch.content || '').trim()
    const scope = String(patch.scope || '').trim()
    const term = String(patch.term || '').trim()
    const from = String(patch.from || '').trim()
    const condition = String(patch.condition || '').trim()
    const to = String(patch.to || '').trim()
    const id = String(patch.id || '').trim()
    const key = `${domain}::${category}::${term}::${scope}::${from}::${condition}::${to}::${id}::${content}`.toLowerCase()
    if (!map.has(key)) {
      map.set(key, { ...patch, domain })
      continue
    }
    const prev = map.get(key)
    if (!prev.sourceRequirementId && patch.sourceRequirementId) {
      prev.sourceRequirementId = patch.sourceRequirementId
    }
    if (!prev.strength && patch.strength) prev.strength = patch.strength
    if (!prev.enum && patch.enum) prev.enum = patch.enum
    if (!prev.owner && patch.owner) prev.owner = patch.owner
  }
  return Array.from(map.values())
}

function buildKnowledgePatchFromBusinessDomains(workspaceRoot, requirementId) {
  const domainDir = path.join(workspaceRoot, 'ai-docs', requirementId, 'business-domains')
  if (!fs.existsSync(domainDir) || !fs.statSync(domainDir).isDirectory()) return []
  const files = fs.readdirSync(domainDir).filter((f) => f.endsWith('.md') && f !== 'index.md')
  const patches = []
  for (const file of files) {
    const fullPath = path.join(domainDir, file)
    const content = fs.readFileSync(fullPath, 'utf-8')
    const parsed = parseDomainMd(content)
    const domain = normalizeDomainName(parsed?.frontmatter?.domain || file.replace(/\.md$/i, ''))
    for (const category of ['entity', 'rule', 'stateMachine', 'techDebt']) {
      const rows = (parsed && parsed.buckets && parsed.buckets[category]) || []
      for (const row of rows) {
        const patch = rowToPatch(category, row, domain, requirementId)
        if (patch) patches.push(patch)
      }
    }
  }
  return patches
}

function readPlanContent(dir) {
  const planPath = path.join(dir, 'plan.md')
  if (!fs.existsSync(planPath)) {
    fail('plan.md 不存在')
  }
  return { planPath, content: fs.readFileSync(planPath, 'utf-8') }
}

function extractGroupTasksFromPlan(content, groupId) {
  const tree = parseMarkdownTree(content)
  const roadmap = findByKey(tree, 'roadmap')
  if (!roadmap) return null

  for (const node of roadmap.children || []) {
    const gid = ((node.title.match(/(Group\s+\w+)/i) || [])[1] || '').trim()
    if (gid !== groupId) continue

    const groupText = renderNode(node)
    const rows = []
    const taskRegex = /^\s*-\s+\[([\s?!x])\]\s+\*\*([^*]+)\*\*/gm
    let match
    while ((match = taskRegex.exec(groupText)) !== null) {
      const marker = match[1]
      const taskId = String(match[2] || '').trim()
      const status = MARKER_TO_STATUS[marker]
      if (!taskId || !status) continue
      rows.push({ taskId, status })
    }
    return rows
  }
  return null
}

function applyTaskStatus(content, taskId, targetStatus) {
  const escapedId = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const taskRegex = new RegExp(`^(\\s*-\\s+)\\[([\\s?!x])\\](\\s+\\*\\*${escapedId}\\*\\*)`, 'm')
  const match = content.match(taskRegex)
  if (!match) {
    fail(`未找到任务: ${taskId}（请确认 plan.md 中任务格式为 - [ ] **${taskId}** ...）`)
  }

  const currentMarker = match[2]
  const currentStatus = MARKER_TO_STATUS[currentMarker]
  if (currentStatus === targetStatus) {
    return { content, changed: false, from: currentStatus, to: targetStatus }
  }

  const allowed = VALID_TRANSITIONS[currentStatus] || []
  if (!allowed.includes(targetStatus)) {
    fail(
      `非法状态转换: ${currentStatus} -> ${targetStatus}。允许的转换: ${allowed.join(', ') || '无（终态）'}`,
    )
  }

  const newMarker = STATUS_TO_MARKER[targetStatus]
  return {
    content: content.replace(taskRegex, `$1[${newMarker}]$3`),
    changed: true,
    from: currentStatus,
    to: targetStatus,
  }
}

function main() {
  const { parseCliArgs, resolveWorkspace, resolveRequirementId } = require('./cli-args.cjs')
  const { named, boolFlags, positional } = parseCliArgs(process.argv.slice(2))

  // action: --action <name>  OR  first positional
  const action = named['action'] || positional[0]

  // workspaceRoot / requirementId: named OR positional (shifted by 1 if action was positional)
  const actionFromNamed = Boolean(named['action'])
  const wsIdx    = actionFromNamed ? 0 : 1
  const ridIdx   = actionFromNamed ? 1 : 2
  const workspaceRoot = resolveWorkspace(named, positional, wsIdx)
  const requirementId = resolveRequirementId(named, positional, ridIdx)

  // Compute how many of [action, workspaceRoot, requirementId] are still in positional
  // (vs. provided via named flags), so extras slice starts at the right index.
  const actionSlots = actionFromNamed ? 0 : 1
  const wsSlots = Boolean(named['workspace'] || named['ws'] || named['w']) ? 0 : 1
  const ridSlots = Boolean(named['requirement-id'] || named['requirementId'] || named['rid'] || named['r']) ? 0 : 1
  const extrasBase = actionSlots + wsSlots + ridSlots
  const extras = positional.slice(extrasBase)

  if (!ACTIONS.includes(action)) {
    fail(`未知 action: ${action}。可选: ${ACTIONS.join(', ')}`)
  }
  if (!requirementId) {
    fail('缺少参数: 需求号')
  }

  const dir = resolveDir(workspaceRoot, requirementId)

  try {
    syncResidualToState(dir, workspaceRoot, null, { fromEngine: false })
  } catch (_) {
    // 残差同步失败不阻塞状态命令
  }

  switch (action) {
    case 'get': {
      const state = readState(dir)
      console.log(JSON.stringify(state, null, 2))
      break
    }
    case 'set-archive-anchor': {
      mergeState(dir, { archiveAnchorDone: true })
      console.log(JSON.stringify({ ok: true }, null, 2))
      break
    }
    case 'clear-archive-anchor': {
      const state = readState(dir)
      const { archiveAnchorDone, domainMerged, knowledgeReviewed, ...rest } = state
      writeState(dir, rest)
      console.log(JSON.stringify({ ok: true }, null, 2))
      break
    }
    case 'set-domain-merged': {
      const reqTempDir = path.join(dir, '.temp')
      const patchPath = path.join(reqTempDir, 'knowledge-patch.json')
      const existing = safeReadJson(patchPath, [])
      const fromDomains = buildKnowledgePatchFromBusinessDomains(workspaceRoot, requirementId)
      const mergedPatch = dedupeKnowledgePatches(existing, fromDomains)
      fs.mkdirSync(reqTempDir, { recursive: true })
      fs.writeFileSync(patchPath, JSON.stringify(mergedPatch, null, 2), 'utf-8')
      mergeState(dir, { domainMerged: true })
      console.log(
        JSON.stringify(
          {
            ok: true,
            domainMerged: true,
            knowledgePatchPath: patchPath,
            existingCount: Array.isArray(existing) ? existing.length : 0,
            domainExtractedCount: fromDomains.length,
            mergedCount: mergedPatch.length,
          },
          null,
          2,
        ),
      )
      break
    }
    case 'set-knowledge-reviewed': {
      mergeState(dir, { knowledgeReviewed: true })
      console.log(JSON.stringify({ ok: true }, null, 2))
      break
    }
    case 'set-code-style-explored': {
      const specifyPath = path.join(dir, 'specify.md')
      let mtimeMs = 0
      try {
        if (fs.existsSync(specifyPath)) mtimeMs = fs.statSync(specifyPath).mtimeMs
      } catch (_) {}
      mergeState(dir, { codeStyleExplored: true, codeStyleExploredMtime: mtimeMs })
      console.log(
        JSON.stringify({ ok: true, codeStyleExplored: true, codeStyleExploredMtime: mtimeMs }, null, 2),
      )
      break
    }
    case 'set-domain-init-pref': {
      const pref = (named['pref'] || extras[0] || '').trim().toLowerCase()
      if (pref !== 'scan' && pref !== 'skip') {
        fail('set-domain-init-pref 需要参数: --pref scan|skip  或位置参数')
      }
      if (pref === 'scan') {
        const slugRaw = (named['slug'] || named['domain'] || extras[1] || '').trim()
        const slugList = parseDomainSlugList(slugRaw)
        if (slugList.length === 0) {
          fail('选 scan 时必须提供合法领域标识（支持逗号分隔多个，如 payment,order）')
        }
        mergeState(dir, {
          domainInitChoice: 'scan',
          domainInitSlug: slugList[0],
          domainInitSlugs: slugList,
          domainInitCandidates: undefined,
        })
        console.log(
          JSON.stringify(
            { ok: true, domainInitChoice: 'scan', domainInitSlug: slugList[0], domainInitSlugs: slugList },
            null,
            2,
          ),
        )
      } else {
        mergeState(dir, {
          domainInitChoice: 'skip',
          domainInitSlug: undefined,
          domainInitSlugs: undefined,
          domainInitCandidates: undefined,
        })
        console.log(JSON.stringify({ ok: true, domainInitChoice: 'skip' }, null, 2))
      }
      break
    }
    case 'set-domain-init-candidates': {
      const slugRaw = (named['slug'] || named['domain'] || extras[0] || '').trim()
      const slugList = parseDomainSlugList(slugRaw)
      if (slugList.length === 0) {
        fail('set-domain-init-candidates 需要合法领域标识（支持逗号分隔多个，如 content-library,playlist）')
      }
      mergeState(dir, { domainInitCandidates: slugList })
      console.log(JSON.stringify({ ok: true, domainInitCandidates: slugList }, null, 2))
      break
    }
    case 'clear-domain-init-candidates': {
      mergeState(dir, { domainInitCandidates: undefined })
      console.log(JSON.stringify({ ok: true, domainInitCandidates: [] }, null, 2))
      break
    }
    case 'ack-specify-before-plan': {
      const specifyPath = path.join(dir, 'specify.md')
      if (!fs.existsSync(specifyPath)) {
        fail('specify.md 不存在，无法确认进入 Plan')
      }
      let mtimeMs = 0
      try {
        mtimeMs = fs.statSync(specifyPath).mtimeMs
      } catch (e) {
        fail(`无法读取 specify.md 时间戳: ${e.message || e}`)
      }
      mergeState(dir, { ackSpecifyBeforePlan: true, specifyAckMtime: mtimeMs })
      console.log(JSON.stringify({ ok: true, specifyAckMtime: mtimeMs }, null, 2))
      break
    }
    case 'ack-specify-review': {
      const specifyPath = path.join(dir, 'specify.md')
      if (!fs.existsSync(specifyPath)) {
        fail('specify.md 不存在，无法记录架构评审通过')
      }
      let mtimeMs = 0
      try {
        mtimeMs = fs.statSync(specifyPath).mtimeMs
      } catch (e) {
        fail(`无法读取 specify.md 时间戳: ${e.message || e}`)
      }
      mergeState(dir, { specifyReviewPassedMtime: mtimeMs })
      console.log(JSON.stringify({ ok: true, specifyReviewPassedMtime: mtimeMs }, null, 2))
      break
    }
    case 'ack-auto-clarifications': {
      const specifyPath = path.join(dir, 'specify.md')
      if (!fs.existsSync(specifyPath)) {
        fail('specify.md 不存在，无法确认自动澄清审阅')
      }
      let mtimeMs = 0
      try {
        mtimeMs = fs.statSync(specifyPath).mtimeMs
      } catch (e) {
        fail(`无法读取 specify.md 时间戳: ${e.message || e}`)
      }
      mergeState(dir, { autoClarificationAckMtime: mtimeMs })
      console.log(JSON.stringify({ ok: true, autoClarificationAckMtime: mtimeMs }, null, 2))
      break
    }
    case 'set-active-group': {
      const groupId = named['group'] || extras[0]
      const isAuto = boolFlags.has('auto') || named['auto'] === 'true'
      if (!groupId) fail('缺少参数: <groupId>')
      // autoProceedGroups：--auto 开启；不带则一律清回 false（同时作为"退出自动托管"入口）
      const patch = {
        activeGroup: groupId,
        groupRetryCount: 0,
        autoProceedGroups: isAuto === true,
      }
      mergeState(dir, patch)
      console.log(
        JSON.stringify(
          { ok: true, activeGroup: groupId, autoProceedGroups: isAuto },
          null,
          2,
        ),
      )
      break
    }
    case 'clear-resource-failed': {
      const failedPath = path.join(dir, '.temp', 'resource-load-failed.json')
      const url = named['url'] || extras[0] || ''
      if (!fs.existsSync(failedPath)) {
        console.log(JSON.stringify({ ok: true, cleared: 0 }, null, 2))
        break
      }
      let mapping = {}
      try {
        mapping = JSON.parse(fs.readFileSync(failedPath, 'utf-8'))
      } catch (_) {
        fs.unlinkSync(failedPath)
        console.log(JSON.stringify({ ok: true, cleared: 0 }, null, 2))
        break
      }
      if (url) {
        if (Object.prototype.hasOwnProperty.call(mapping, url)) {
          delete mapping[url]
          if (Object.keys(mapping).length === 0) {
            fs.unlinkSync(failedPath)
            console.log(JSON.stringify({ ok: true, cleared: 1, remaining: 0 }, null, 2))
          } else {
            fs.writeFileSync(failedPath, JSON.stringify(mapping, null, 2), 'utf-8')
            console.log(
              JSON.stringify(
                { ok: true, cleared: 1, remaining: Object.keys(mapping).length },
                null,
                2,
              ),
            )
          }
        } else {
          console.log(
            JSON.stringify(
              { ok: true, cleared: 0, remaining: Object.keys(mapping).length },
              null,
              2,
            ),
          )
        }
      } else {
        fs.unlinkSync(failedPath)
        console.log(JSON.stringify({ ok: true, cleared: Object.keys(mapping).length }, null, 2))
      }
      break
    }
    case 'reset-retry': {
      mergeState(dir, { groupRetryCount: 0 })
      console.log(JSON.stringify({ ok: true, groupRetryCount: 0 }, null, 2))
      break
    }
    case 'mark-task': {
      const taskId = named['task'] || named['task-id'] || extras[0]
      const targetStatus = named['status'] || named['task-status'] || extras[1]
      const evidence = named['evidence'] || extras[2] || ''

      if (!taskId || !targetStatus) {
        fail('mark-task 需要额外参数: <taskId> <status>')
      }
      if (!STATUS_TO_MARKER.hasOwnProperty(targetStatus)) {
        fail(`无效状态: ${targetStatus}。可选: ${Object.keys(STATUS_TO_MARKER).join(', ')}`)
      }
      if (targetStatus === 'completed' && !evidence.trim()) {
        fail(
          '标记为 completed 时必须提供验收证据（测试路径或输出摘要）。请先在 plan.md Log 中写入存证，再调用: mark-task <taskId> completed <evidence>',
        )
      }

      const { planPath, content: rawContent } = readPlanContent(dir)
      let content = rawContent
      const preCheck = applyTaskStatus(content, taskId, targetStatus)
      const currentStatus = preCheck.from

      if (currentStatus === targetStatus) {
        console.log(JSON.stringify({ ok: true, changed: false, taskId, currentStatus }))
        break
      }

      // 4.5 ready-for-qa 质量门禁：始终执行 verify（项目根配置优先，其次自动探测）
      let verifyPayload = null
      let codingPatch = null
      if (targetStatus === 'ready-for-qa') {
        codingPatch = ensureCodingStandardPatch(workspaceRoot, requirementId, content)
        const gate = runQualityGateBeforeQA(workspaceRoot, requirementId)
        if (!gate.ok) {
          fail(`质量门禁未通过：${gate.error}`)
        }
        verifyPayload = gate.verify || null
      } else if (targetStatus === 'failed') {
        codingPatch = appendCodingStandardPatchFromFailure(workspaceRoot, requirementId, evidence, rawContent)
      }

      const patched = applyTaskStatus(content, taskId, targetStatus)
      content = patched.content
      fs.writeFileSync(planPath, content, 'utf-8')

      try {
        syncResidualToState(dir, workspaceRoot, null, { fromEngine: false })
      } catch (_) {}

      // 6. 状态变更仅写入 plan.md；taskTransitions 不写入 specflow-state.json（仅作 stdout 输出供调用方感知）
      // UPDATE: 维护 QA 死循环计数器
      if (targetStatus === 'failed') {
        const state = readState(dir)
        mergeState(dir, { groupRetryCount: (state.groupRetryCount || 0) + 1 })
      }

      console.log(
        JSON.stringify(
          {
            ok: true,
            changed: true,
            taskId,
            from: currentStatus,
            to: targetStatus,
            verify: verifyPayload,
            codingPatch,
          },
          null,
          2,
        ),
      )
      break
    }
    case 'mark-group': {
      const groupId = (named['group'] || extras[0] || '').trim()
      const targetStatus = (named['status'] || named['task-status'] || extras[1] || '').trim()
      const evidence = named['evidence'] || extras[2] || ''
      if (!groupId || !targetStatus) {
        fail('mark-group 需要额外参数: <groupId> <status>')
      }
      const allowedStatuses = ['ready-for-qa', 'failed', 'completed']
      if (!allowedStatuses.includes(targetStatus)) {
        fail(`mark-group 无效状态: ${targetStatus}。可选: ${allowedStatuses.join(', ')}`)
      }
      if (targetStatus === 'completed' && !evidence.trim()) {
        fail(
          'mark-group 标记为 completed 时必须提供验收证据。请先在 plan.md Log 中写入存证，再调用: mark-group <groupId> completed <evidence>',
        )
      }

      const { planPath, content: rawContent } = readPlanContent(dir)
      const groupTasks = extractGroupTasksFromPlan(rawContent, groupId)
      if (groupTasks == null) {
        fail(`未找到 Group: ${groupId}（请确认 plan.md Roadmap 中存在该 Group）`)
      }
      if (groupTasks.length === 0) {
        console.log(
          JSON.stringify({ ok: true, changed: false, groupId, to: targetStatus, matchedTasks: 0 }, null, 2),
        )
        break
      }

      const fromStatuses =
        targetStatus === 'ready-for-qa' ? new Set(['pending', 'failed']) : new Set(['ready-for-qa'])
      const selected = groupTasks.filter((t) => fromStatuses.has(t.status))
      if (selected.length === 0) {
        console.log(
          JSON.stringify({ ok: true, changed: false, groupId, to: targetStatus, matchedTasks: 0 }, null, 2),
        )
        break
      }

      let verifyPayload = null
      let codingPatch = null
      if (targetStatus === 'ready-for-qa') {
        codingPatch = ensureCodingStandardPatch(workspaceRoot, requirementId, rawContent)
        const gate = runQualityGateBeforeQA(workspaceRoot, requirementId)
        if (!gate.ok) {
          fail(`质量门禁未通过：${gate.error}`)
        }
        verifyPayload = gate.verify || null
      } else if (targetStatus === 'failed') {
        codingPatch = appendCodingStandardPatchFromFailure(workspaceRoot, requirementId, evidence, rawContent)
      }

      let content = rawContent
      const changedTasks = []
      for (const task of selected) {
        const patched = applyTaskStatus(content, task.taskId, targetStatus)
        content = patched.content
        if (patched.changed) changedTasks.push(task.taskId)
      }
      fs.writeFileSync(planPath, content, 'utf-8')

      try {
        syncResidualToState(dir, workspaceRoot, null, { fromEngine: false })
      } catch (_) {}

      if (targetStatus === 'failed') {
        const state = readState(dir)
        mergeState(dir, { groupRetryCount: (state.groupRetryCount || 0) + 1 })
      }

      console.log(
        JSON.stringify(
          {
            ok: true,
            changed: changedTasks.length > 0,
            groupId,
            to: targetStatus,
            matchedTasks: selected.length,
            changedTasks,
            verify: verifyPayload,
            codingPatch,
          },
          null,
          2,
        ),
      )
      break
    }
  }
}

if (require.main === module) {
  main()
}
