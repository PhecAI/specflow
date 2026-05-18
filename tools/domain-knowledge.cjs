/**
 * Domain Knowledge 结构化合并模块
 *
 * 职责：
 * - 规范化 knowledge-patch 条目的 category（entity / rule / stateMachine / ui / techDebt）
 * - 解析全局 `ai-docs/global-assets/domains/<domain>.md` 的四段结构化表格
 * - 按 category 分桶合并新 patch 到既有 md，并回写 frontmatter（置信度阶梯化）
 * - `ui` 类别不回流全局（仅留在需求级），其余四类参与合并
 * - 老 bullet list 与新结构表格并存（向下兼容 migrate_manual 策略）
 *
 * 设计约束：
 * - 仅提供纯函数；IO（读写 md）由调用方 `merge-global-assets.cjs` 承担
 * - 保持 frontmatter 既有字段兼容（domain/status/last_requirement/confidence/maintainer）
 *   并新增 `sourceRequirementIds` 数组用于阶梯化判定
 */

const KNOWLEDGE_CATEGORIES = ['entity', 'rule', 'stateMachine', 'ui', 'techDebt']
const REFLOW_CATEGORIES = new Set(['entity', 'rule', 'stateMachine', 'techDebt'])

// 置信度阶梯阈值：出现在 N 个需求里 → 何种 status/confidence
const CONFIDENCE_LADDER = [
  { min: 3, status: 'Verified', confidence: 0.85 },
  { min: 2, status: 'Consolidating', confidence: 0.6 },
  { min: 1, status: 'Draft', confidence: 0.3 },
]

const SECTION_HEADINGS = {
  entity: '## 统一语言 & 实体',
  rule: '## 稳定业务规则',
  stateMachine: '## 状态机 / 门禁',
  techDebt: '## 技术债 & TODO',
  legacy: '## Legacy (pre-migration)',
}

const TABLE_HEADERS = {
  entity: ['术语', '语义', '约束 / 枚举', '来源'],
  rule: ['场景', '规则', '强度', '来源'],
  stateMachine: ['前置', '条件', '后续', '来源'],
  techDebt: ['id', '描述', 'owner', '来源'],
}

function normalizeKnowledgeCategory(raw) {
  const v = String(raw || '').trim().toLowerCase()
  if (['entity', 'term', 'vocabulary', 'ubiquitous-language'].includes(v)) return 'entity'
  if (
    ['statemachine', 'state-machine', 'state_machine', 'transition', '状态机', 'guard', 'gate'].includes(v)
  ) {
    return 'stateMachine'
  }
  if (['ui', 'ux', 'interaction', 'layout', '交互', '布局'].includes(v)) return 'ui'
  if (['techdebt', 'tech-debt', 'tech_debt', 'debt', 'todo', '技术债'].includes(v)) return 'techDebt'
  if (['rule', 'business-rule', 'business_rule', '业务规则', ''].includes(v)) return 'rule'
  return 'rule'
}

function shouldReflowToGlobal(category) {
  return REFLOW_CATEGORIES.has(normalizeKnowledgeCategory(category))
}

function deriveConfidenceStatus(sourceRequirementIds) {
  const n = Array.isArray(sourceRequirementIds) ? sourceRequirementIds.length : 0
  for (const step of CONFIDENCE_LADDER) {
    if (n >= step.min) return { status: step.status, confidence: step.confidence, count: n }
  }
  return { status: 'Draft', confidence: 0.3, count: 0 }
}

// 文本归一化用于行级去重 key（不落盘，仅比较）
function normalizeForKey(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[。；;,.\s:：]+$/u, '')
    .replace(/^[。；;,.\s:：]+/u, '')
    .trim()
}

// 解析 md 的 frontmatter：`---\nkey: value\n...\n---\n`
function parseFrontmatter(md) {
  const text = String(md || '')
  if (!text.startsWith('---\n')) return { data: null, body: text }
  const end = text.indexOf('\n---\n', 4)
  if (end < 0) return { data: null, body: text }
  const rawLines = text.slice(4, end).split('\n')
  const data = {}
  for (const line of rawLines) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const k = line.slice(0, idx).trim()
    const v = line.slice(idx + 1).trim()
    if (!k) continue
    // 数组字面量 `[a, b]` 解析
    if (v.startsWith('[') && v.endsWith(']')) {
      const inner = v.slice(1, -1).trim()
      data[k] = inner
        ? inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
        : []
      continue
    }
    data[k] = v
  }
  return { data, body: text.slice(end + '\n---\n'.length) }
}

// frontmatter 只保留两类事实字段：
// - domain         文件主题（人类可读）
// - maintainer     产出方（运营责任人）
// - sourceRequirementIds  单一事实源，所有置信度派生字段由它现算
//
// status / confidence / last_requirement 为"派生视图"，仅在渲染时写入 body
// 顶部 badge（而非 frontmatter），避免事实与派生双写漂移。
function renderFrontmatter(data) {
  const lines = ['---']
  if (data.domain != null) lines.push(`domain: ${data.domain}`)
  if (data.maintainer != null) lines.push(`maintainer: ${data.maintainer || 'specflow-knowledge-reviewer'}`)
  if (Array.isArray(data.sourceRequirementIds)) {
    lines.push(`sourceRequirementIds: [${data.sourceRequirementIds.join(', ')}]`)
  }
  lines.push('---', '')
  return lines.join('\n')
}

// 渲染"派生视图 badge"：紧跟在 frontmatter 之后、H1 之前，向人类与 agent 展示
// 当前置信度状态。重新运行 parser 也会忽略该段（按 H2 扫描，badge 是引用块）。
function renderStatusBadge(sourceRequirementIds) {
  const { status, confidence, count } = deriveConfidenceStatus(sourceRequirementIds)
  const last = Array.isArray(sourceRequirementIds) && sourceRequirementIds.length > 0
    ? sourceRequirementIds[sourceRequirementIds.length - 1]
    : 'null'
  return [
    `> **status**: ${status} · **confidence**: ${confidence} · **observations**: ${count} · **last_requirement**: ${last}`,
    '> _（以上字段由 `sourceRequirementIds` 现算生成，请勿手改；如需回溯修改请直接编辑数组）_',
    '',
  ].join('\n')
}

// 解析 md body 中的章节（简易解析：按 `## ` 二级标题切分）
function splitBodyIntoSections(body) {
  const text = String(body || '')
  const lines = text.split('\n')
  const sections = []
  let current = { heading: '__preamble__', lines: [] }
  for (const line of lines) {
    const m = line.match(/^(#{1,2})\s+(.+)$/)
    if (m && m[1].length <= 2) {
      sections.push(current)
      current = { heading: line.trim(), lines: [] }
    } else {
      current.lines.push(line)
    }
  }
  sections.push(current)
  return sections
}

// 解析 markdown 表格行为 [{col0, col1, ...}]；非严格，容错分隔线与空行
function parseTableRows(lines) {
  const rows = []
  for (const raw of lines) {
    const line = String(raw || '').trim()
    if (!line.startsWith('|') || !line.endsWith('|')) continue
    if (/^\|\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|$/.test(line)) continue // 分隔线
    const cols = line
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim())
    rows.push(cols)
  }
  return rows
}

// 将一个 section 的行体解析为结构化行数组（仅对 entity/rule/stateMachine/techDebt）
function parseSectionRows(category, sectionLines) {
  const rows = parseTableRows(sectionLines)
  if (rows.length === 0) return { headerRow: null, dataRows: [] }
  const [headerRow, ...dataRows] = rows
  // 首行若恰好匹配预期表头则跳过；否则全部视为 data（容错）
  const expected = TABLE_HEADERS[category] || []
  const isHeader = expected.length > 0 && headerRow.length >= 1 && expected.every((h, i) => String(headerRow[i] || '').trim() === h)
  return isHeader ? { headerRow, dataRows } : { headerRow: null, dataRows: [headerRow, ...dataRows] }
}

// 行唯一化 key：按 category 用不同列组成
function rowKey(category, cols) {
  const c = (i) => normalizeForKey(cols[i] || '')
  switch (category) {
    case 'entity':
      return `entity::${c(0)}`
    case 'rule':
      return `rule::${c(0)}::${c(1)}`
    case 'stateMachine':
      return `sm::${c(0)}::${c(1)}::${c(2)}`
    case 'techDebt':
      return `td::${c(0) || c(1)}`
    default:
      return `other::${cols.join('|')}`
  }
}

// 扁平 schema（单一契约）：
// {
//   domain, category,
//   content,            // 通用主文本（必填）
//   // 以下按 category 选填扁平字段（同义兜底已删除）：
//   term,               // entity: 术语名
//   scope,              // rule: 场景/作用范围
//   enum,               // entity: 枚举或约束，字符串或数组
//   strength,           // rule: hard | soft
//   from, condition, to, // stateMachine
//   id, owner,          // techDebt
//   applies,            // 可选：glob 列表（代码规范预留）
//   sourceRequirementId
// }
// 旧 schema（content + title + attributes.*) 兼容读取仅用于迁移，写入一律扁平。
function coercePatchEnum(v) {
  if (v == null) return ''
  if (Array.isArray(v)) return v.map((x) => String(x || '').trim()).filter(Boolean).join(' / ')
  return String(v).trim()
}

function readPatchField(patch, fieldName, legacyAttr) {
  if (patch == null) return ''
  const flat = patch[fieldName]
  if (flat !== undefined && flat !== null && String(flat).trim() !== '') return String(flat).trim()
  // 迁移期兜底：仅读 attributes[<legacyAttr>]，不再接受同义字段（如 result/allow/constraints）
  const attrs = patch.attributes || {}
  const legacy = attrs[legacyAttr != null ? legacyAttr : fieldName]
  if (legacy !== undefined && legacy !== null && String(legacy).trim() !== '') return String(legacy).trim()
  return ''
}

// 把一个 patch 条目投影为具体 category 的表格行（数组列）
function patchToRow(category, patch, defaultSource) {
  const source = String((patch && patch.sourceRequirementId) || defaultSource || '').trim()
  const content = String((patch && patch.content) || '').trim()
  switch (category) {
    case 'entity': {
      const term = readPatchField(patch, 'term')
      const semantic = content
      const enums = coercePatchEnum(
        patch && (patch.enum !== undefined ? patch.enum : (patch.attributes && patch.attributes.enum)),
      )
      return [term, semantic, enums, source]
    }
    case 'rule': {
      const scope = readPatchField(patch, 'scope') || '通用'
      const rawStrength = readPatchField(patch, 'strength').toLowerCase()
      const strength = rawStrength === 'hard' ? 'Hard' : rawStrength === 'soft' ? 'Soft' : ''
      return [scope, content, strength, source]
    }
    case 'stateMachine': {
      const from = readPatchField(patch, 'from')
      const cond = readPatchField(patch, 'condition')
      const to = readPatchField(patch, 'to')
      return [from, cond, to, source]
    }
    case 'techDebt': {
      const id = readPatchField(patch, 'id')
      const desc = content
      const owner = readPatchField(patch, 'owner')
      return [id, desc, owner, source]
    }
    default:
      return ['', content, '', source]
  }
}

function formatRow(cols) {
  return `| ${cols.map((c) => String(c || '').replace(/\|/g, '\\|')).join(' | ')} |`
}

// 追加/合并一行：若 key 已存在则合并"来源"列；否则追加
function upsertRow(existingRows, incomingRow, category) {
  const key = rowKey(category, incomingRow)
  const idx = existingRows.findIndex((r) => rowKey(category, r) === key)
  if (idx < 0) {
    existingRows.push(incomingRow)
    return { action: 'added' }
  }
  const prev = existingRows[idx]
  // 合并来源列（最后一列）
  const sourceIdx = (TABLE_HEADERS[category] || []).length - 1
  if (sourceIdx > 0) {
    const prevSrc = new Set(
      String(prev[sourceIdx] || '')
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
    )
    const incSrc = String(incomingRow[sourceIdx] || '')
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean)
    for (const s of incSrc) prevSrc.add(s)
    prev[sourceIdx] = Array.from(prevSrc).join(', ')
  }
  // 若新行为 rule，且新行 strength=Hard 原为 Soft/空 → 升级
  if (category === 'rule') {
    if (String(incomingRow[2] || '').toLowerCase() === 'hard') prev[2] = 'Hard'
    else if (!prev[2]) prev[2] = incomingRow[2]
  }
  return { action: 'merged' }
}

function renderSectionTable(category, rows) {
  const header = TABLE_HEADERS[category]
  const lines = [SECTION_HEADINGS[category], '']
  if (!header) return lines.join('\n')
  if (rows.length === 0) {
    lines.push('_(暂无)_', '')
    return lines.join('\n')
  }
  lines.push(formatRow(header))
  lines.push(`| ${header.map(() => '---').join(' | ')} |`)
  for (const r of rows) lines.push(formatRow(r))
  lines.push('')
  return lines.join('\n')
}

function parseDomainMd(md) {
  const { data: frontmatter, body } = parseFrontmatter(md)
  const sections = splitBodyIntoSections(body)
  const buckets = { entity: [], rule: [], stateMachine: [], techDebt: [] }
  const legacyLines = []
  let preambleH1 = null
  for (const sec of sections) {
    if (sec.heading === '__preamble__') {
      // preamble：保留 H1 等
      const h1 = sec.lines.find((l) => /^#\s+/.test(l))
      if (h1) preambleH1 = h1.trim()
      // preamble 中的 bullet 视为老数据 → legacy
      for (const l of sec.lines) {
        if (/^-\s+/.test(l.trim())) legacyLines.push(l)
      }
      continue
    }
    const heading = sec.heading
    let matched = false
    for (const key of Object.keys(SECTION_HEADINGS)) {
      if (key === 'legacy') continue
      if (heading.startsWith(SECTION_HEADINGS[key])) {
        const { dataRows } = parseSectionRows(key, sec.lines)
        buckets[key].push(...dataRows)
        matched = true
        break
      }
    }
    if (!matched) {
      // 未知章节整体并入 legacy（含老 bullet 和自由文本）
      legacyLines.push(heading, ...sec.lines)
    }
  }
  return { frontmatter: frontmatter || null, preambleH1, buckets, legacyLines }
}

function renderDomainMd({ frontmatter, preambleH1, buckets, legacyLines }) {
  const parts = []
  if (frontmatter) {
    parts.push(renderFrontmatter(frontmatter))
    if (Array.isArray(frontmatter.sourceRequirementIds)) {
      parts.push(renderStatusBadge(frontmatter.sourceRequirementIds))
    }
  }
  if (preambleH1) parts.push(preambleH1, '')
  for (const key of ['entity', 'rule', 'stateMachine', 'techDebt']) {
    parts.push(renderSectionTable(key, buckets[key] || []))
  }
  const trimmedLegacy = (legacyLines || []).map((l) => String(l || '')).filter((l) => l.trim() !== '')
  if (trimmedLegacy.length > 0) {
    parts.push(SECTION_HEADINGS.legacy, '')
    parts.push('> 本段为结构化升级前的历史条目，后续需求中如遇到相关主题请按新结构补录。', '')
    for (const l of trimmedLegacy) parts.push(l)
    parts.push('')
  }
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n')
}

// 合并入口：把 knowledge patches 按 category 分桶，upsert 到 existing md
function mergePatchesIntoDomainMd(existingMd, domainName, patches, options = {}) {
  const reqId = String(options.requirementId || '').trim()
  const parsed = parseDomainMd(
    existingMd || '',
  )
  // frontmatter 初始化/升级（仅保留事实字段；派生字段在渲染阶段现算）
  const fm = parsed.frontmatter || {
    domain: domainName,
    maintainer: 'specflow-knowledge-reviewer',
    sourceRequirementIds: [],
  }
  fm.domain = fm.domain || domainName
  if (!Array.isArray(fm.sourceRequirementIds)) {
    // 迁移期兜底：若遗留旧版 last_requirement 单值，转为首次数组
    const legacy = fm.last_requirement
    fm.sourceRequirementIds = legacy && legacy !== 'null' ? [String(legacy)] : []
  }
  // 删除旧派生字段（如果历史 md 里有），避免双写漂移
  delete fm.status
  delete fm.confidence
  delete fm.last_requirement

  const incoming = Array.isArray(patches) ? patches : []
  const reflowed = incoming.filter((p) => shouldReflowToGlobal(p && p.category))
  const dropped = incoming.length - reflowed.length

  for (const patch of reflowed) {
    const category = normalizeKnowledgeCategory(patch.category)
    const row = patchToRow(category, patch, reqId)
    // 空行（完全没内容）跳过
    if (row.slice(0, -1).every((c) => !String(c || '').trim())) continue
    upsertRow(parsed.buckets[category], row, category)
  }

  // 仅更新事实源 sourceRequirementIds；status/confidence/last_requirement 现算
  if (reqId && reflowed.length > 0) {
    const set = new Set(fm.sourceRequirementIds.map((s) => String(s)))
    set.add(reqId)
    fm.sourceRequirementIds = Array.from(set)
  }
  fm.maintainer = 'specflow-knowledge-reviewer'
  const ladder = deriveConfidenceStatus(fm.sourceRequirementIds)

  const nextMd = renderDomainMd({
    frontmatter: fm,
    preambleH1: parsed.preambleH1 || `# ${domainName}`,
    buckets: parsed.buckets,
    legacyLines: parsed.legacyLines,
  })
  return {
    md: nextMd,
    frontmatter: fm,
    mergedCount: reflowed.length,
    droppedUiCount: dropped,
    confidenceLadder: ladder,
  }
}

module.exports = {
  KNOWLEDGE_CATEGORIES,
  CONFIDENCE_LADDER,
  SECTION_HEADINGS,
  TABLE_HEADERS,
  normalizeKnowledgeCategory,
  shouldReflowToGlobal,
  deriveConfidenceStatus,
  normalizeForKey,
  parseFrontmatter,
  renderFrontmatter,
  renderStatusBadge,
  splitBodyIntoSections,
  parseTableRows,
  parseSectionRows,
  rowKey,
  patchToRow,
  readPatchField,
  coercePatchEnum,
  formatRow,
  upsertRow,
  renderSectionTable,
  parseDomainMd,
  renderDomainMd,
  mergePatchesIntoDomainMd,
}
