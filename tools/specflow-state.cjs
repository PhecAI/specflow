/**
 * SpecFlow 流程状态：需求目录下 .temp/specflow-state.json 的读写。
 * 所有写入均经 sanitizeState：仅保留 STATE_SCHEMA 声明的字段，丢弃未知键与非法类型，防止手改/合并污染。
 *
 * 字段语义（与 manage-state.cjs / specflow-engine.cjs 一致）：
 * - stateVersion: 状态契约版本（迁移用）
 * - activeGroup: 当前 Implement 活跃 Group ID（**唯一写入入口**：manage-state set-active-group，仅在用户通过 confirm_start_group 确认后写入）
 * - autoProceedGroups: 由 set-active-group --auto 写入；为 true 时引擎在 Group 边界**静默对齐** activeGroup（免 confirm_start_group），直至 Roadmap 全部完成或用户通过 `set-active-group <id>`（不带 --auto）显式退出托管。
 * - planAckMtime: **已弃用**（保留 schema 仅为向后兼容旧 state 文件；当前版本的引擎与 manage-state 不再读写此字段）。
 * - groupRetryCount: QA 失败重试计数（死循环熔断）
 * - domainMerged: 归档前领域文档是否已由 domain-explorer 合并
 * - codeStyleExplored: 进入 Plan 之前是否已由 code-style-explorer 完成需求级规范评估
 * - codeStyleExploredMtime: 上述完成时刻的 specify.md mtime（ms）；spec 变更后需重新评估
 * - archiveAnchorDone: 用户是否已确认执行物理归档
 * - ackSpecifyBeforePlan: 用户是否已在弹窗确认进入 Plan（尚无 plan.md 时）
 * - specifyAckMtime: 上述确认时刻的 specify.md mtime（ms）；spec 变更后需重新确认
 * - specifyReviewPassedMtime: 架构师评审通过时 specify.md 的 mtime（ms）；与当前文件 mtime 不一致则须重新评审后方可首次生成 plan.md
 * - domainInitChoice: 尚无 specify.md 时用户对「业务知识库」策略的选择：scan=先扫代码逐步生成，skip=本次不生成
 * - domainInitSlug: 选 scan 时的领域标识（小写英文/数字/连字符），用于 ai-docs/<需求号>/business-domains/<slug>.md；选 skip 时不应保留
 * - domainInitSlugs: scan 时可同时登记多个领域（上限 8）；domainInitSlug 始终等于首元素
 * - domainInitCandidates: agent 在 S1 提交的领域「候选」列表（尚未确认，等待 S2 yes/no 采纳）
 * - residualItems: 由脚本根据 specify.md「验收标准」中未勾选 AC 行动态计算，勿手改
 * - acTotal / acPassed: 同上章节内 `- [ ]` / `- [x]` 计数；remaining = acTotal − acPassed（与 residualItems.length 一致当有文案时）
 * - residual: 结构化残差（unmetAcCount / failedTestsCount / openGatesCount / missingEvidencesCount / totalScore），由 residual-metrics 写入
 * - metricsHistory: 引擎轮次快照 [{ turn, totalResidual, at? }]（仅引擎跑完追加，最多 48 条）
 * - engineTurn: 引擎残差审计序号（每轮引擎成功落盘残差后 +1）
 */

const fs = require('fs')
const path = require('path')

const UTF8 = 'utf-8'

/** 状态文件相对需求目录的路径 */
const STATE_FILE = '.temp/specflow-state.json'

/** 当前契约版本；仅当字段含义变更时递增 */
const STATE_VERSION = 3

/**
 * 允许的键与类型约束（state schema）。
 * 未列出的键一律在 sanitize 时丢弃。
 */
const STATE_SCHEMA = {
  stateVersion: { type: 'number', min: 1, integer: true },
  activeGroup: { type: 'string', minLength: 1 },
  autoProceedGroups: { type: 'boolean' },
  planAckMtime: { type: 'number', min: 0, integer: false },
  groupRetryCount: { type: 'number', min: 0, integer: true },
  domainMerged: { type: 'boolean' },
  knowledgeReviewed: { type: 'boolean' },
  codeStyleExplored: { type: 'boolean' },
  codeStyleExploredMtime: { type: 'number', min: 0, integer: false },
  archiveAnchorDone: { type: 'boolean' },
  ackSpecifyBeforePlan: { type: 'boolean' },
  specifyAckMtime: { type: 'number', min: 0, integer: false },
  specifyReviewPassedMtime: { type: 'number', min: 0, integer: false },
  autoClarificationAckMtime: { type: 'number', min: 0, integer: false },
  domainInitChoice: { type: 'string', enum: ['scan', 'skip'] },
  domainInitSlug: { type: 'string', minLength: 1, maxLength: 64 },
  domainInitSlugs: { type: 'array', maxItems: 8, itemMaxLength: 64 },
  domainInitCandidates: { type: 'array', maxItems: 8, itemMaxLength: 64 },
  residualItems: { type: 'array', maxItems: 80, itemMaxLength: 600 },
  acTotal: { type: 'number', min: 0, integer: true },
  acPassed: { type: 'number', min: 0, integer: true },
  engineTurn: { type: 'number', min: 0, integer: true },
  residual: { type: 'residual' },
  metricsHistory: { type: 'metricsHistory' },
}

/**
 * @param {object} raw
 * @returns {{ unmetAcCount: number, failedTestsCount: number, openGatesCount: number, missingEvidencesCount: number, totalScore: number }}
 */
function sanitizeResidual(raw) {
  const keys = [
    'unmetAcCount',
    'failedTestsCount',
    'openGatesCount',
    'missingEvidencesCount',
    'totalScore',
  ]
  const out = {}
  const o = raw && typeof raw === 'object' ? raw : {}
  for (const k of keys) {
    const v = o[k]
    let n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0
    if (n < 0) n = 0
    if (n > 9999) n = 9999
    out[k] = n
  }
  out.totalScore =
    out.unmetAcCount + out.failedTestsCount + out.openGatesCount + out.missingEvidencesCount
  return out
}

/**
 * @param {unknown} raw
 * @returns {{ turn: number, totalResidual: number, at?: string }[]}
 */
function sanitizeMetricsHistory(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const el of raw) {
    if (!el || typeof el !== 'object') continue
    const turn = typeof el.turn === 'number' && Number.isFinite(el.turn) ? Math.trunc(el.turn) : 0
    const totalResidual =
      typeof el.totalResidual === 'number' && Number.isFinite(el.totalResidual)
        ? Math.trunc(el.totalResidual)
        : 0
    if (turn < 1) continue
    const row = { turn, totalResidual: Math.max(0, totalResidual) }
    if (typeof el.at === 'string' && el.at.trim()) row.at = el.at.trim().slice(0, 40)
    out.push(row)
    if (out.length >= 48) break
  }
  return out
}

/**
 * 领域标识规范化：小写、空白变连字符、剔除非法字符；不合法则返回 null。
 * @param {string} raw
 * @returns {string|null}
 */
function normalizeDomainInitSlug(raw) {
  if (raw == null || typeof raw !== 'string') return null
  let s = raw.trim().toLowerCase().replace(/\s+/g, '-')
  s = s.replace(/[^a-z0-9_-]/g, '')
  if (s.length < 1 || s.length > 64) return null
  return s
}

function getStatePath(dir) {
  return path.join(dir, STATE_FILE)
}

/**
 * 按 STATE_SCHEMA 过滤并校验；返回新对象，不修改入参。
 * @param {object} raw
 * @returns {object}
 */
function sanitizeState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { stateVersion: STATE_VERSION }
  }
  const out = {}
  for (const key of Object.keys(STATE_SCHEMA)) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
    const v = raw[key]
    const schema = STATE_SCHEMA[key]
    if (schema.type === 'residual') {
      out[key] = sanitizeResidual(v)
      continue
    }
    if (schema.type === 'metricsHistory') {
      out[key] = sanitizeMetricsHistory(v)
      continue
    }
    if (schema.type === 'boolean') {
      if (typeof v === 'boolean') out[key] = v
      continue
    }
    if (schema.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue
      let n = schema.integer ? Math.trunc(v) : v
      if (schema.min !== undefined && n < schema.min) continue
      if (schema.integer && !Number.isInteger(n)) n = Math.trunc(n)
      out[key] = n
      continue
    }
    if (schema.type === 'string') {
      if (typeof v !== 'string') continue
      if (key === 'domainInitSlug') {
        const n = normalizeDomainInitSlug(v)
        if (!n) continue
        out[key] = n
        continue
      }
      const s = v.trim()
      if (schema.minLength && s.length < schema.minLength) continue
      if (schema.enum && Array.isArray(schema.enum) && !schema.enum.includes(s)) continue
      out[key] = s
      continue
    }
    if (schema.type === 'array') {
      if (!Array.isArray(v)) continue
      const maxItems = schema.maxItems || 80
      const itemMax = schema.itemMaxLength || 600
      const items = []
      for (const el of v) {
        if (typeof el !== 'string') continue
        let s = el.trim()
        if (key === 'domainInitSlugs' || key === 'domainInitCandidates') {
          const n = normalizeDomainInitSlug(s)
          if (!n) continue
          s = n
        }
        if (!s) continue
        items.push(s.length > itemMax ? `${s.slice(0, itemMax)}…` : s)
        if (items.length >= maxItems) break
      }
      out[key] = items
      continue
    }
  }
  if (!out.stateVersion || out.stateVersion < 1) out.stateVersion = STATE_VERSION
  return out
}

function readState(dir) {
  const file = getStatePath(dir)
  if (!fs.existsSync(file)) return {}
  try {
    const content = fs.readFileSync(file, UTF8)
    const parsed = JSON.parse(content)
    return sanitizeState(parsed)
  } catch (e) {
    return {}
  }
}

function writeState(dir, state) {
  const file = getStatePath(dir)
  const tempDir = path.dirname(file)
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true })
  }
  const clean = sanitizeState(state)
  fs.writeFileSync(file, JSON.stringify(clean, null, 2), UTF8)
}

function mergeState(dir, patch) {
  const current = readState(dir)
  const next = { ...current, ...patch }
  Object.keys(next).forEach((key) => {
    if (next[key] === undefined) delete next[key]
  })
  writeState(dir, next)
}

module.exports = {
  STATE_FILE,
  STATE_VERSION,
  STATE_SCHEMA,
  normalizeDomainInitSlug,
  sanitizeResidual,
  sanitizeMetricsHistory,
  sanitizeState,
  readState,
  writeState,
  mergeState,
}
