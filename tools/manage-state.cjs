/**
 * SpecFlow 状态管理器：统一处理 .temp/specflow-state.json 的读写操作与 plan.md 任务状态变更。
 *
 * 用法（统一）: PLUGIN_ROOT=/path/to/specflow node "$PLUGIN_ROOT/tools/manage-state.cjs" <action> [workspaceRoot] <需求号> [额外参数...]
 *
 * Actions:
 *   get              — 输出当前 state JSON
 *   set-archive-anchor  — 写入 archive.user_anchor gate（用户主动确认归档后调用；state 镜像仅兼容旧流程）
 *   clear-archive-anchor — 清理归档兼容 state 并阻断 Archive gates
 *   set-code-style-explored — 兼容旧流程；当前主流程不再用它作为 Plan 前门禁
 *   ack-code-style-sync — 记录当前 plan.md 快照对应的需求级 code-style 增量已同步完成（写入 gates.json: plan.code_style_synced）
 *   recalibrate-layers — 清空全局 architecture-layers.md 的 Layers 段，并重置 init.architecture_layers 门禁
 *   set-active-group <groupId> [--auto] — 设置当前活跃的 Group ID；**--auto** 开启自动托管（`autoProceedGroups=true`，后续 Group 边界免 confirm）；不带 --auto 会清除自动托管
 *   mark-task <taskId> <status> [evidence] — 变更 plan.md 中指定任务的状态（含转换校验与日志）
 *     status: pending | ready-for-qa | failed | completed
 *     合法转换: pending→ready-for-qa, ready-for-qa→completed, ready-for-qa→failed, failed→ready-for-qa
 *     当 status=completed 时，必须传入 evidence（验收证据摘要，如测试路径或输出摘要），否则拒绝
 *   mark-group <groupId> <status> [evidence] — 以 Group 为单位批量变更状态（闭环推荐）
 *     status: ready-for-qa | failed | completed
 *     ready-for-qa: 批量 pending/failed -> ready-for-qa（只执行一次门禁校验）
 *     failed/completed: 批量 ready-for-qa -> failed/completed
 *     当 status=completed 时，必须传入 evidence
 *   clear-resource-failed [url] — 从 .temp/resource-load-failed.json 的失败映射中移除：指定 url 则只删该 key；不传 url 则清空整个文件
 *   reset-retry — 重置 groupRetryCount 为 0（死循环保护后人工修复用）
 *   ack-specify-before-plan — 记录用户已在弹窗确认进入 Plan（写入 gates.json: plan.user_confirm_start；兼容写入旧 state mtime）
 *   ack-specify-review [confirmed|mock_allowed|not_required] — 记录架构师已完成对 specify 的评审且无阻塞（写入 gates.json: plan.readiness_review；兼容写入旧 state）
 *   mark-specify-review-blocked [reason] — 记录技术前置评审阻塞（写入 gates.json: plan.readiness_review=blocked；仍应生成技术澄清状态）
 *   ack-auto-clarifications — 记录用户已审阅并确认自动解决的澄清（写入 autoClarificationAckMtime = 当前 specify.md mtime）
 *   answer-clarification <cqId> <answer> — 将 .temp/clarifications.json 中对应澄清写入 answer 并标记 closed
 *   set-domain-init-pref <scan|skip> [领域身份] — 记录业务知识库领域初始化结果。scan 时必须提供领域身份（如 services/order::payment，支持逗号分隔），写入 domainInitRefs；并清空 domainInitCandidateRefs。skip 时清除所有领域字段
 *   set-domain-init-candidates <ref_csv> — S1 阶段：agent 分析项目后提交领域身份候选（逗号分隔），写入 domainInitCandidateRefs；引擎下一轮基于候选生成 N 道 yes/no 采纳题
 *   clear-domain-init-candidates — 清空 domainInitCandidateRefs（用于反悔 / 重新提交）
 *
 * 输出: JSON 到 stdout
 */

const fs = require('fs')
const path = require('path')
const { readState, writeState, mergeState, normalizeDomainInitRef } = require('./specflow-state.cjs')
const {
  passGate,
  blockGate,
  skipGate,
  resetGate,
  fileSnapshot,
} = require('./gates.cjs')
const { syncResidualToState } = require('./residual-metrics.cjs')
const { parseMarkdownTree, findByKey, renderNode, parseGroupsFromTree } = require('./plan-parser.cjs')
const {
  normalizeCodingPatchSection,
  normalizeCodingPatchContent,
  mergeCodingPatches: mergeCodingPatchesShared,
  writeRequirementCodeStyleArtifacts,
  filterCodingPatchesForCodeStyle,
  stripAppliesSuffix,
} = require('./code-style.cjs')
const { parseDomainMd } = require('./domain-knowledge.cjs')

const ACTIONS = [
  'get',
  'set-archive-anchor',
  'clear-archive-anchor',
  'set-domain-merged',
  'set-knowledge-reviewed',
  'set-code-style-explored',
  'ack-code-style-sync',
  'recalibrate-layers',
  'ack-specify-before-plan',
  'ack-specify-review',
  'mark-specify-review-blocked',
  'ack-auto-clarifications',
  'answer-clarification',
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
const ROADMAP_STATUS_OVERVIEW_ANCHOR = '<!-- specflow:roadmap-status-overview -->'

/** 合法的状态转换规则 */
const VALID_TRANSITIONS = {
  pending: ['ready-for-qa'],
  'ready-for-qa': ['completed', 'failed'],
  failed: ['ready-for-qa'],
  completed: [],
}

function deriveGroupDisplayStatus(counts) {
  const pending = counts.pending || 0
  const readyForQA = counts.readyForQA || 0
  const failed = counts.failed || 0
  const completed = counts.completed || 0
  const total = pending + readyForQA + failed + completed

  if (total === 0) return '无任务'
  if (failed > 0) return '需修复'
  if (pending === 0 && failed === 0 && readyForQA > 0) return '待验收'
  if (pending > 0 || readyForQA > 0) return '进行中'
  return '已完成'
}

function renderRoadmapStatusOverview(content) {
  let groups = []
  try {
    const tree = parseMarkdownTree(content)
    groups = parseGroupsFromTree(tree)
  } catch (_) {
    groups = []
  }

  const totals = { pending: 0, readyForQA: 0, failed: 0, completed: 0 }
  const rows = groups.map((group) => {
    const counts = group.counts || {}
    totals.pending += counts.pending || 0
    totals.readyForQA += counts.readyForQA || 0
    totals.failed += counts.failed || 0
    totals.completed += counts.completed || 0
    const label = group.name ? `${group.id}: ${group.name}` : group.id
    return `| ${label} | ${deriveGroupDisplayStatus(counts)} | ${counts.pending || 0} | ${counts.readyForQA || 0} | ${counts.failed || 0} | ${counts.completed || 0} |`
  })

  if (groups.length > 1) {
    rows.push(
      `| Total | ${deriveGroupDisplayStatus(totals)} | ${totals.pending} | ${totals.readyForQA} | ${totals.failed} | ${totals.completed} |`,
    )
  }
  if (rows.length === 0) {
    rows.push('| - | 无任务 | 0 | 0 | 0 | 0 |')
  }

  return [
    '### Roadmap Status Overview',
    ROADMAP_STATUS_OVERVIEW_ANCHOR,
    '',
    '| Group | 状态 | 待开发 | 待验收 | 需修复 | 已完成 |',
    '|-------|------|--------|--------|--------|--------|',
    ...rows,
    '',
  ].join('\n')
}

function syncRoadmapStatusOverview(content) {
  const overview = renderRoadmapStatusOverview(content)
  const existingRe =
    /^### Roadmap Status Overview\s*\n<!-- specflow:roadmap-status-overview -->[\s\S]*?(?=^###\s+(?:📦\s*)?Group\s+\w+|^###\s+🏁|^##\s+5\.|$)/m

  if (existingRe.test(content)) {
    return content.replace(existingRe, overview)
  }

  const firstGroup = content.match(/^###\s+(?:📦\s*)?Group\s+\w+.*$/m)
  if (firstGroup && typeof firstGroup.index === 'number') {
    return `${content.slice(0, firstGroup.index)}${overview}\n${content.slice(firstGroup.index)}`
  }

  const roadmapAnchor = '<!-- specflow:section=roadmap -->'
  const anchorIndex = content.indexOf(roadmapAnchor)
  if (anchorIndex >= 0) {
    const insertAt = content.indexOf('\n', anchorIndex + roadmapAnchor.length)
    if (insertAt >= 0) {
      return `${content.slice(0, insertAt + 1)}\n${overview}\n${content.slice(insertAt + 1)}`
    }
  }

  return content
}

function fail(error) {
  console.log(JSON.stringify({ ok: false, error }))
  process.exit(1)
}

function ensureGateResult(result) {
  if (!result || result.ok !== true) {
    fail(result && result.error ? result.error : '门禁写入失败')
  }
  return result
}

function resolveDir(workspaceRoot, requirementId) {
  const dir = path.join(workspaceRoot, 'ai-docs', requirementId)
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    fail(`需求目录不存在: ${dir}`)
  }
  return dir
}

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return fallback
  }
}

function normalizeClarificationEntries(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  if (Array.isArray(raw.items)) return raw.items
  const out = []
  for (const key of ['product', 'acceptance', 'technical', 'questions']) {
    if (Array.isArray(raw[key])) {
      for (const item of raw[key]) out.push(item)
    }
  }
  return out
}

function clarificationIdOf(item, idx) {
  return String(
    (item && (item.id || item.cqId)) ||
      `clarification_${idx + 1}`,
  )
}

function isClarificationClosed(item) {
  if (!item || typeof item !== 'object') return true
  const status = String(item.status || item.state || '').toLowerCase()
  if (['closed', 'resolved', 'done'].includes(status)) return true
  return (
    item.answer != null ||
    item.userAnswer != null ||
    item.resolution != null ||
    item.decision != null
  )
}

function writeClarificationAnswer(dir, cqId, answer) {
  const clarificationPath = path.join(dir, '.temp', 'clarifications.json')
  if (!fs.existsSync(clarificationPath)) {
    fail(`clarifications.json 不存在: ${clarificationPath}`)
  }
  const raw = safeReadJson(clarificationPath, null)
  if (!raw) fail('clarifications.json 无法解析')

  const entries = normalizeClarificationEntries(raw)
  if (entries.length === 0) fail('clarifications.json 中没有澄清条目')

  let matched = null
  let matchedId = ''
  entries.forEach((item, idx) => {
    if (matched) return
    if (!item || typeof item !== 'object') return
    const id = clarificationIdOf(item, idx)
    const legacyId = item.cqId ? String(item.cqId) : ''
    if (id === cqId || legacyId === cqId) {
      matched = item
      matchedId = id
    }
  })

  if (!matched) {
    fail(`未找到澄清项: ${cqId}`)
  }

  matched.status = 'closed'
  matched.answer = answer
  matched.answeredAt = new Date().toISOString()

  fs.mkdirSync(path.dirname(clarificationPath), { recursive: true })
  fs.writeFileSync(clarificationPath, JSON.stringify(raw, null, 2), 'utf-8')

  const openItems = entries.filter((item) => !isClarificationClosed(item))
  return {
    ok: true,
    id: matchedId,
    allClosed: openItems.length === 0,
    openCount: openItems.length,
    path: clarificationPath,
  }
}

function parseDomainRefList(input) {
  const raw = String(input || '')
  if (!raw.trim()) return []
  const out = []
  const seen = new Set()
  for (const item of raw.split(',')) {
    const ref = normalizeDomainInitRef(item)
    if (!ref || seen.has(ref)) continue
    seen.add(ref)
    out.push(ref)
  }
  return out
}

function resetArchitectureLayersFile(workspaceRoot) {
  const layersPath = path.join(
    workspaceRoot,
    'ai-docs',
    'global-assets',
    'standards',
    'architecture-layers.md',
  )
  const fallbackHeader = [
    '# Architecture Layers',
    '',
    '> 本文件描述当前项目自己的代码分层画像。SpecFlow 不预设前端/后端层名；由 agent 基于目录、配置、既有代码和规范生成并迭代维护。',
    '> 初始化阶段只写低风险骨架；需求中发现的新分层先作为候选，归档评审通过后再稳定进入本文件。',
    '',
  ].join('\n')
  const existing = fs.existsSync(layersPath) ? fs.readFileSync(layersPath, 'utf-8') : ''
  const marker = existing.match(/^##\s+Layers\s*$/m)
  const header = marker && typeof marker.index === 'number'
    ? existing.slice(0, marker.index).replace(/\s+$/, '')
    : (existing.trim() ? existing.trim() : fallbackHeader.trim())
  const next = `${header}\n\n## Layers\n\n- (empty)\n`
  fs.mkdirSync(path.dirname(layersPath), { recursive: true })
  fs.writeFileSync(layersPath, next, 'utf-8')
  return layersPath
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
      const stripped = stripAppliesSuffix(m[2])
      const content = normalizeCodingPatchContent(stripped.content)
      if (content) {
        const item = { section, content, extractedAt: new Date().toISOString() }
        if (stripped.layers) item.layers = stripped.layers
        if (stripped.applies) item.applies = stripped.applies
        patches.push(item)
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
  const extracted = extractCodingStandardPatchesFromEvidence(evidence)
  const filtered = filterCodingPatchesForCodeStyle(workspaceRoot, extracted)
  const incoming = filtered.accepted
  if (incoming.length === 0) {
    return { generated: false, count: 0, appended: 0, path: null, rejectedCount: filtered.rejected.length }
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
    rejectedCount: filtered.rejected.length,
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

function normalizeDomainRefForPatch(raw) {
  return normalizeDomainInitRef(String(raw || '')) || ''
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
    case 'formula': {
      const scope = String(row[0] || '').trim()
      const formula = String(row[1] || '').trim()
      const boundary = String(row[2] || '').trim()
      const sourceIds = parseSourceRequirementIds(row[3])
      if (!scope && !formula && !boundary) return null
      const patch = { domain, category: 'formula', scope: scope || '通用', content: formula, formula }
      if (boundary) patch.boundary = boundary
      patch.sourceRequirementId = sourceIds[0] || rid || null
      return patch
    }
    case 'pitfall': {
      const scope = String(row[0] || '').trim()
      const content = String(row[1] || '').trim()
      const impact = String(row[2] || '').trim()
      const sourceIds = parseSourceRequirementIds(row[3])
      if (!scope && !content && !impact) return null
      const patch = { domain, category: 'pitfall', scope: scope || '通用', content }
      if (impact) patch.impact = impact
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
    const domain = normalizeDomainRefForPatch(patch.domain || patch.domainRef || '')
    if (!domain) continue
    const category = String(patch.category || 'rule').trim()
    const content = String(patch.content || '').trim()
    const scope = String(patch.scope || '').trim()
    const term = String(patch.term || '').trim()
    const from = String(patch.from || '').trim()
    const condition = String(patch.condition || '').trim()
    const to = String(patch.to || '').trim()
    const id = String(patch.id || '').trim()
    const formula = String(patch.formula || '').trim()
    const boundary = String(patch.boundary || '').trim()
    const impact = String(patch.impact || '').trim()
    const key = `${domain}::${category}::${term}::${scope}::${from}::${condition}::${to}::${id}::${formula}::${boundary}::${impact}::${content}`.toLowerCase()
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
    if (!prev.formula && patch.formula) prev.formula = patch.formula
    if (!prev.boundary && patch.boundary) prev.boundary = patch.boundary
    if (!prev.impact && patch.impact) prev.impact = patch.impact
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
    const domain = normalizeDomainRefForPatch(parsed?.frontmatter?.domain || '')
    if (!domain) continue
    for (const category of ['entity', 'rule', 'stateMachine', 'formula', 'pitfall', 'techDebt']) {
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

function findTaskGroupIdFromPlan(content, taskId) {
  const tree = parseMarkdownTree(content)
  const roadmap = findByKey(tree, 'roadmap')
  if (!roadmap) return ''

  for (const node of roadmap.children || []) {
    const gid = ((node.title.match(/(Group\s+\w+)/i) || [])[1] || '').trim()
    if (!gid) continue
    const groupText = renderNode(node)
    const escapedId = String(taskId || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const taskRegex = new RegExp(`^\\s*-\\s+\\[[\\s?!x]\\]\\s+\\*\\*${escapedId}\\*\\*`, 'm')
    if (taskRegex.test(groupText)) return gid
  }
  return ''
}

function extractCompletionPacket(content, groupId) {
  const text = String(content || '')
  const gid = String(groupId || '').trim()
  if (!gid) return ''

  const escapedGroup = gid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(
    `####\\s+Completion Packet\\s+[—-]\\s+${escapedGroup}\\b([\\s\\S]*?)(?=\\n#{2,6}\\s|\\n####\\s+Completion Packet\\s+[—-]\\s+Group\\s+\\w+\\b|$)`,
    'i',
  )
  const match = text.match(re)
  return match ? match[0] : ''
}

function validateCompletionPacket(content, groupId) {
  const packet = extractCompletionPacket(content, groupId)
  const required = [
    { id: 'Changed Files', re: /\*\*Changed Files\*\*/i },
    { id: 'AC Mapping', re: /\*\*AC Mapping\*\*/i },
    { id: 'Local Contract Mapping', re: /\*\*Local Contract Mapping\*\*/i },
    { id: 'Test Strategy Execution', re: /\*\*Test Strategy Execution\*\*/i },
    { id: 'Verification Matrix', re: /\*\*Verification Matrix\*\*/i },
    { id: 'Verification Matrix / Static Diagnostics', re: /Static Diagnostics\s*:/i },
    { id: 'Verification Matrix / Targeted Test', re: /Targeted Test\s*:/i },
    { id: 'Verification Matrix / Contract Check', re: /Contract Check\s*:/i },
    { id: 'Verification Matrix / Smoke Evidence', re: /Smoke Evidence\s*:/i },
    { id: 'Not Run / Deferred', re: /\*\*Not Run(?:\s*\/\s*Deferred)?\*\*/i },
    { id: 'Knowledge Rules Used', re: /\*\*Knowledge Rules Used\*\*/i },
  ]
  const missing = required.filter((x) => !x.re.test(packet)).map((x) => x.id)
  return {
    ok: Boolean(packet) && missing.length === 0,
    packet,
    missing,
    error: !packet
      ? `缺少 Completion Packet — ${groupId}`
      : `Completion Packet — ${groupId} 缺少小节: ${missing.join(', ')}`,
  }
}

function validateQaLiteEvidence(content, evidence, groupId) {
  const combined = `${String(evidence || '')}\n${String(content || '')}`
  const gid = String(groupId || '').trim()
  const nearGroup = !gid || new RegExp(gid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(combined)
  const packetResult = gid ? validateCompletionPacket(content, gid) : { ok: true, missing: [] }
  const checks = [
    { id: 'QA Lite', re: /QA\s*Lite/i },
    { id: 'Packet', re: /Packet|Completion Packet/i },
    { id: 'AC', re: /\bAC\b|AC Mapping/i },
    { id: 'Contract', re: /Contract|Local Contract/i },
    { id: 'Test Strategy', re: /Test Strategy|测试策略/i },
    { id: 'Verification Matrix', re: /Verification Matrix|验证矩阵/i },
  ]
  const missing = checks.filter((x) => !x.re.test(combined)).map((x) => x.id)
  if (!packetResult.ok) {
    missing.push(...packetResult.missing.map((x) => `Packet ${x}`))
  }
  return {
    ok: nearGroup && packetResult.ok && missing.length === 0,
    missing: nearGroup ? missing : ['Group ID', ...missing],
    error: nearGroup
      ? `QA Lite Evidence 缺少核对摘要: ${missing.join(', ')}`
      : `QA Lite Evidence 未关联 Group: ${gid}`,
  }
}

function enforceCompletionPacketGate(dir, content, groupId) {
  const result = validateCompletionPacket(content, groupId)
  if (!result.ok) {
    blockGate(dir, 'implement.completion_packet_ready', {
      subject: groupId,
      reason: result.error,
      evidence: result.missing.length > 0 ? `missing: ${result.missing.join(', ')}` : result.error,
    })
    fail(`${result.error}。请先在 plan.md Log 中写入完整 Completion Packet，再标记 ready-for-qa。`)
  }
  ensureGateResult(passGate(dir, 'implement.completion_packet_ready', {
    subject: groupId,
    evidence: `Completion Packet ready: ${groupId}`,
  }))
}

function enforceQaLiteEvidenceGate(dir, content, evidence, groupId) {
  const result = validateQaLiteEvidence(content, evidence, groupId)
  if (!result.ok) {
    blockGate(dir, 'qa.lite_evidence_ready', {
      subject: groupId,
      reason: result.error,
      evidence: result.missing.length > 0 ? `missing: ${result.missing.join(', ')}` : result.error,
    })
    fail(`${result.error}。请先写入 QA Lite Evidence，再标记 completed。`)
  }
  ensureGateResult(passGate(dir, 'qa.lite_evidence_ready', {
    subject: groupId,
    evidence: `QA Lite Evidence ready: ${groupId}`,
  }))
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
      ensureGateResult(passGate(dir, 'archive.user_anchor', {
        stage: 'Archive',
        scope: 'requirement',
        subject: 'physical archive confirmation',
        evidence: 'user confirmed archive',
      }))
      console.log(JSON.stringify({ ok: true }, null, 2))
      break
    }
    case 'clear-archive-anchor': {
      const state = readState(dir)
      const { archiveAnchorDone, domainMerged, knowledgeReviewed, ...rest } = state
      writeState(dir, rest)
      ensureGateResult(blockGate(dir, 'archive.user_anchor', {
        stage: 'Archive',
        scope: 'requirement',
        subject: 'physical archive confirmation',
        reason: 'archive anchor cleared',
      }))
      ensureGateResult(blockGate(dir, 'archive.domain_merged', {
        stage: 'Archive',
        scope: 'requirement',
        subject: 'domain knowledge merge',
        reason: 'archive anchor cleared',
      }))
      ensureGateResult(blockGate(dir, 'archive.knowledge_reviewed', {
        stage: 'Archive',
        scope: 'requirement',
        subject: 'knowledge patch review',
        reason: 'archive anchor cleared',
      }))
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
      ensureGateResult(passGate(dir, 'archive.domain_merged', {
        stage: 'Archive',
        scope: 'requirement',
        subject: 'domain knowledge merge',
        evidence: [
          `knowledge patch merged: ${mergedPatch.length}`,
          `business domain extracted: ${fromDomains.length}`,
        ],
      }))
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
      ensureGateResult(passGate(dir, 'archive.knowledge_reviewed', {
        stage: 'Archive',
        scope: 'requirement',
        subject: 'knowledge patch review',
        evidence: 'knowledge and code-style patches reviewed',
      }))
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
    case 'ack-code-style-sync': {
      const planPath = path.join(dir, 'plan.md')
      if (!fs.existsSync(planPath)) {
        fail('plan.md 不存在，无法记录 code-style 同步状态')
      }
      const planSnapshot = fileSnapshot(workspaceRoot, path.join('ai-docs', requirementId, 'plan.md'))
      const codeStylePath = path.join(dir, 'code-style.md')
      const patchPath = path.join(dir, '.temp', 'coding-standard-patch.json')
      const evidence = [
        fs.existsSync(codeStylePath) ? `ai-docs/${requirementId}/code-style.md` : null,
        fs.existsSync(patchPath) ? `ai-docs/${requirementId}/.temp/coding-standard-patch.json` : null,
      ].filter(Boolean)
      ensureGateResult(passGate(dir, 'plan.code_style_synced', {
        stage: 'Plan',
        scope: 'plan',
        subject: `ai-docs/${requirementId}/code-style.md`,
        snapshot: planSnapshot,
        evidence: evidence.length > 0 ? evidence : [`ai-docs/${requirementId}/plan.md`],
      }))
      console.log(JSON.stringify({ ok: true, gate: 'plan.code_style_synced', snapshot: planSnapshot }, null, 2))
      break
    }
    case 'recalibrate-layers': {
      const layersPath = resetArchitectureLayersFile(workspaceRoot)
      ensureGateResult(resetGate(dir, 'init.architecture_layers', {
        stage: 'Init',
        scope: 'global',
        subject: 'ai-docs/global-assets/standards/architecture-layers.md',
        reason: 'manual recalibration requested after unmapped technical signal',
        evidence: 'architecture-layers Layers section cleared',
      }))
      console.log(
        JSON.stringify(
          {
            ok: true,
            architectureLayersPath: layersPath,
            gate: 'init.architecture_layers',
            status: 'pending',
          },
          null,
          2,
        ),
      )
      break
    }
    case 'set-domain-init-pref': {
      const pref = (named['pref'] || extras[0] || '').trim().toLowerCase()
      if (pref !== 'scan' && pref !== 'skip') {
        fail('set-domain-init-pref 需要参数: --pref scan|skip  或位置参数')
      }
      if (pref === 'scan') {
        const refRaw = (named['ref'] || named['domain-ref'] || extras[1] || '').trim()
        const refs = parseDomainRefList(refRaw)
        if (refs.length === 0) {
          fail('选 scan 时必须提供合法领域身份（支持逗号分隔多个，如 services/order::payment,apps/admin::payment）')
        }
        mergeState(dir, {
          domainInitChoice: 'scan',
          domainInitRefs: refs,
          domainInitCandidateRefs: undefined,
        })
        ensureGateResult(passGate(dir, 'init.domain_refs', {
          stage: 'Init',
          scope: 'requirement',
          subject: 'business domain refs',
          evidence: refs,
        }))
        console.log(
          JSON.stringify(
            { ok: true, domainInitChoice: 'scan', domainInitRefs: refs },
            null,
            2,
          ),
        )
      } else {
        mergeState(dir, {
          domainInitChoice: 'skip',
          domainInitRefs: undefined,
          domainInitCandidateRefs: undefined,
        })
        ensureGateResult(skipGate(dir, 'init.domain_refs', {
          stage: 'Init',
          scope: 'requirement',
          subject: 'business domain refs',
          reason: 'user chose to skip domain initialization',
        }))
        console.log(JSON.stringify({ ok: true, domainInitChoice: 'skip' }, null, 2))
      }
      break
    }
    case 'set-domain-init-candidates': {
      const refRaw = (named['ref'] || named['domain-ref'] || extras[0] || '').trim()
      const refs = parseDomainRefList(refRaw)
      if (refs.length === 0) {
        fail('set-domain-init-candidates 需要合法领域身份（支持逗号分隔多个，如 services/order::payment,apps/admin::payment）')
      }
      mergeState(dir, { domainInitCandidateRefs: refs })
      console.log(JSON.stringify({ ok: true, domainInitCandidateRefs: refs }, null, 2))
      break
    }
    case 'clear-domain-init-candidates': {
      mergeState(dir, { domainInitCandidateRefs: undefined })
      console.log(JSON.stringify({ ok: true, domainInitCandidateRefs: [] }, null, 2))
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
      // Plan confirmation only authorizes generating plan.md. It must not carry
      // over any previous Implement/Group authorization into the newly generated roadmap.
      mergeState(dir, {
        ackSpecifyBeforePlan: true,
        specifyAckMtime: mtimeMs,
        activeGroup: undefined,
        autoProceedGroups: false,
        groupRetryCount: 0,
      })
      ensureGateResult(passGate(dir, 'plan.user_confirm_start', {
        stage: 'PlanReadiness',
        scope: 'requirement',
        subject: 'user confirmed start plan',
        snapshot: fileSnapshot(workspaceRoot, path.join('ai-docs', requirementId, 'specify.md')),
        evidence: 'user confirmed start plan',
      }))
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
      const evidenceRaw = (named['contract-evidence'] || named.evidence || extras[0] || 'confirmed').trim()
      const allowedEvidence = new Set(['confirmed', 'mock_allowed', 'not_required'])
      const contractEvidence = allowedEvidence.has(evidenceRaw) ? evidenceRaw : 'confirmed'
      mergeState(dir, {
        specifyReviewStatus: 'ready',
        specifyReviewMtime: mtimeMs,
        specifyReviewPassedMtime: mtimeMs,
        specifyReviewContractEvidence: contractEvidence,
        specifyReviewBlockReason: undefined,
      })
      const specifySnapshot = fileSnapshot(workspaceRoot, path.join('ai-docs', requirementId, 'specify.md'))
      ensureGateResult(passGate(dir, 'plan.readiness_review', {
        stage: 'PlanReadiness',
        scope: 'requirement',
        subject: 'specify to plan readiness',
        snapshot: specifySnapshot,
        evidence: contractEvidence,
      }))
      console.log(
        JSON.stringify(
          {
            ok: true,
            specifyReviewStatus: 'ready',
            specifyReviewMtime: mtimeMs,
            specifyReviewPassedMtime: mtimeMs,
            specifyReviewContractEvidence: contractEvidence,
          },
          null,
          2,
        ),
      )
      break
    }
    case 'mark-specify-review-blocked': {
      const specifyPath = path.join(dir, 'specify.md')
      if (!fs.existsSync(specifyPath)) {
        fail('specify.md 不存在，无法记录架构评审阻塞')
      }
      let mtimeMs = 0
      try {
        mtimeMs = fs.statSync(specifyPath).mtimeMs
      } catch (e) {
        fail(`无法读取 specify.md 时间戳: ${e.message || e}`)
      }
      const reason = (named.reason || extras[0] || '存在技术方案制定阻塞，需先完成技术澄清').trim()
      mergeState(dir, {
        specifyReviewStatus: 'blocked',
        specifyReviewMtime: mtimeMs,
        specifyReviewContractEvidence: 'missing',
        specifyReviewBlockReason: reason,
        specifyReviewPassedMtime: undefined,
        ackSpecifyBeforePlan: undefined,
        specifyAckMtime: undefined,
      })
      const specifySnapshot = fileSnapshot(workspaceRoot, path.join('ai-docs', requirementId, 'specify.md'))
      ensureGateResult(blockGate(dir, 'plan.readiness_review', {
        stage: 'PlanReadiness',
        scope: 'requirement',
        subject: 'specify to plan readiness',
        snapshot: specifySnapshot,
        reason,
        evidence: 'missing',
      }))
      ensureGateResult(blockGate(dir, 'plan.user_confirm_start', {
        stage: 'PlanReadiness',
        scope: 'requirement',
        subject: 'user confirmed start plan',
        snapshot: specifySnapshot,
        reason: 'readiness review blocked',
      }))
      console.log(
        JSON.stringify(
          {
            ok: true,
            specifyReviewStatus: 'blocked',
            specifyReviewMtime: mtimeMs,
            specifyReviewContractEvidence: 'missing',
            specifyReviewBlockReason: reason,
          },
          null,
          2,
        ),
      )
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
    case 'answer-clarification': {
      const cqId = (named['cq-id'] || named.cqId || named.id || extras[0] || '').trim()
      const answer = (named.answer || named.value || extras.slice(1).join(' ') || '').trim()
      if (!cqId) fail('answer-clarification 需要参数: <cqId>')
      if (!answer) fail('answer-clarification 需要参数: <answer>')
      const result = writeClarificationAnswer(dir, cqId, answer)
      console.log(JSON.stringify(result, null, 2))
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

      // ready-for-qa 只执行结构门禁：Completion Packet / Verification Matrix 必须完整。
      let codingPatch = null
      if (targetStatus === 'ready-for-qa') {
        const groupId = findTaskGroupIdFromPlan(content, taskId)
        enforceCompletionPacketGate(dir, content, groupId || taskId)
        codingPatch = ensureCodingStandardPatch(workspaceRoot, requirementId, content)
      } else if (targetStatus === 'failed') {
        codingPatch = appendCodingStandardPatchFromFailure(workspaceRoot, requirementId, evidence, rawContent)
      } else if (targetStatus === 'completed') {
        const groupId = findTaskGroupIdFromPlan(content, taskId)
        enforceQaLiteEvidenceGate(dir, content, evidence, groupId || taskId)
      }

      const patched = applyTaskStatus(content, taskId, targetStatus)
      content = syncRoadmapStatusOverview(patched.content)
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

      let codingPatch = null
      if (targetStatus === 'ready-for-qa') {
        enforceCompletionPacketGate(dir, rawContent, groupId)
        codingPatch = ensureCodingStandardPatch(workspaceRoot, requirementId, rawContent)
      } else if (targetStatus === 'failed') {
        codingPatch = appendCodingStandardPatchFromFailure(workspaceRoot, requirementId, evidence, rawContent)
      } else if (targetStatus === 'completed') {
        enforceQaLiteEvidenceGate(dir, rawContent, evidence, groupId)
      }

      let content = rawContent
      const changedTasks = []
      for (const task of selected) {
        const patched = applyTaskStatus(content, task.taskId, targetStatus)
        content = patched.content
        if (patched.changed) changedTasks.push(task.taskId)
      }
      content = syncRoadmapStatusOverview(content)
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
