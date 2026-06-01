/**
 * 结构化残差：合并 specify AC、verify 最近一次结果、引擎门禁与 Roadmap 待验收任务，
 * 写入 specflow-state.json 的 residual / metricsHistory（引擎轮次追加历史）。
 */

const fs = require('fs')
const path = require('path')
const {
  mergeState,
  readState,
  sanitizeMetricsHistory,
  sanitizeResidual,
} = require('./specflow-state.cjs')
const {
  computeSpecifyAcceptanceResidual,
  parseMarkdownTree,
  parseClarificationFromTree,
  parseGroupsFromTree,
  deriveRoadmapStats,
} = require('./plan-parser.cjs')

const UTF8 = 'utf-8'

function safeRead(p) {
  try {
    return fs.readFileSync(p, UTF8)
  } catch {
    return ''
  }
}

function getMtimeMs(p) {
  try {
    return fs.statSync(p).mtimeMs
  } catch {
    return 0
  }
}

function readVerifyLast(workspaceRoot, requirementId) {
  const candidates = []
  if (requirementId) {
    candidates.push(path.join(workspaceRoot, 'ai-docs', requirementId, '.temp', 'verify-last.json'))
  }
  // 兼容历史路径：旧版本写在 ai-docs/.temp
  candidates.push(path.join(workspaceRoot, 'ai-docs', '.temp', 'verify-last.json'))
  const p = candidates.find((item) => fs.existsSync(item))
  if (!p) return { failedTestsCount: 0, ok: true }
  try {
    const j = JSON.parse(fs.readFileSync(p, UTF8))
    const n =
      typeof j.failedTestsCount === 'number' && Number.isFinite(j.failedTestsCount)
        ? Math.trunc(j.failedTestsCount)
        : j.ok === false
          ? 1
          : 0
    return { failedTestsCount: Math.max(0, Math.min(99, n)), ok: j.ok !== false }
  } catch {
    return { failedTestsCount: 0, ok: true }
  }
}

/**
 * 与引擎 gates 对齐的门禁计数（可机器比较）。
 * @param {object} gates
 */
function computeOpenGatesCount(gates) {
  if (!gates || typeof gates !== 'object') return 0
  let n = 0
  if (gates.clarificationOpen && (gates.openClarificationCount || 0) > 0) {
    n += Math.min(20, gates.openClarificationCount)
  }
  if (gates.hasSpecify && gates.specifyReviewValid === false) n += 1
  if (gates.autoClarificationNeedsReview) n += 1
  const bs = (gates.blockerCountInSpecify || 0) + (gates.blockerCountInPlan || 0)
  if (bs > 0) n += Math.min(10, bs)
  return Math.min(99, n)
}

/**
 * manage-state / 无引擎 gates 时的近似 gates（与引擎计算方式一致）。
 */
function buildMinimalGatesFromFiles(requirementDir) {
  const state = readState(requirementDir)
  const pathSpecify = path.join(requirementDir, 'specify.md')
  const pathPlan = path.join(requirementDir, 'plan.md')
  const specifyContent = fs.existsSync(pathSpecify) ? safeRead(pathSpecify) : ''
  const planContent = fs.existsSync(pathPlan) ? safeRead(pathPlan) : ''
  const specifyTree = specifyContent ? parseMarkdownTree(specifyContent) : null
  const planTree = planContent ? parseMarkdownTree(planContent) : null
  const clarification = specifyTree
    ? parseClarificationFromTree(specifyTree, specifyContent)
    : { open: false, openCount: 0 }
  const specifyMtimeNow = specifyContent ? getMtimeMs(pathSpecify) : 0
  const specifyReviewStatus =
    state.specifyReviewStatus === 'ready' || state.specifyReviewStatus === 'blocked'
      ? state.specifyReviewStatus
      : null
  const specifyReviewMtimeStored =
    typeof state.specifyReviewMtime === 'number' && Number.isFinite(state.specifyReviewMtime)
      ? state.specifyReviewMtime
      : null
  const specifyReviewPassedMtimeStored =
    typeof state.specifyReviewPassedMtime === 'number' && Number.isFinite(state.specifyReviewPassedMtime)
      ? state.specifyReviewPassedMtime
      : null
  const hasSpecify = !!specifyContent
  const specifyReviewValid =
    hasSpecify &&
    specifyMtimeNow > 0 &&
    specifyReviewStatus === 'ready' &&
    specifyReviewMtimeStored != null &&
    specifyMtimeNow === specifyReviewMtimeStored &&
    specifyReviewPassedMtimeStored != null &&
    specifyMtimeNow === specifyReviewPassedMtimeStored
  const hasAutoClarifications = typeof specifyContent === 'string' && /###\s+\[Auto\]\s*CQ/i.test(specifyContent)
  const autoAckMtime =
    typeof state.autoClarificationAckMtime === 'number' && Number.isFinite(state.autoClarificationAckMtime)
      ? state.autoClarificationAckMtime
      : 0
  const autoClarificationNeedsReview =
    hasAutoClarifications && specifyMtimeNow > 0 && specifyMtimeNow !== autoAckMtime
  const groups = planTree ? parseGroupsFromTree(planTree) : []
  const roadmap = planTree ? deriveRoadmapStats(planTree, groups) : { readyForQA: 0 }
  const blockerInSpecify = specifyContent ? (specifyContent.match(/\[BLOCKER\]/g) || []).length : 0
  const blockerInPlan = planContent ? (planContent.match(/\[BLOCKER\]/g) || []).length : 0

  return {
    clarificationOpen: clarification.open,
    openClarificationCount: clarification.openCount || 0,
    specifyReviewValid,
    hasSpecify,
    hasPlan: !!planContent,
    autoClarificationNeedsReview,
    readyForQACount: roadmap.readyForQA || 0,
    blockerCountInSpecify: blockerInSpecify,
    blockerCountInPlan: blockerInPlan,
  }
}

/**
 * @param {string} requirementDir
 * @param {string} workspaceRoot
 * @param {object|null} gates - 引擎完整 gates；null 时从文件推断
 * @param {{ fromEngine?: boolean }} options
 * @returns {object}
 */
function syncResidualToState(requirementDir, workspaceRoot, gates, options) {
  const opt = options || {}
  const fromEngine = opt.fromEngine === true
  const emptyResidual = sanitizeResidual({})
  const outEmpty = {
    acTotal: 0,
    acPassed: 0,
    remaining: 0,
    residualItems: [],
    residual: emptyResidual,
    residualDelta: null,
    engineTurn: 0,
  }

  if (!requirementDir || !workspaceRoot) {
    return outEmpty
  }

  const g = gates && typeof gates === 'object' ? gates : buildMinimalGatesFromFiles(requirementDir)
  const specifyPath = path.join(requirementDir, 'specify.md')
  let ac = { acTotal: 0, acPassed: 0, remaining: 0, residualItems: [] }
  if (fs.existsSync(specifyPath)) {
    ac = computeSpecifyAcceptanceResidual(safeRead(specifyPath))
  }

  const requirementId = path.basename(path.resolve(requirementDir))
  const verifySnap = readVerifyLast(workspaceRoot, requirementId)
  const failedTestsCount = verifySnap.ok ? 0 : Math.max(1, verifySnap.failedTestsCount || 1)

  const openGatesCount = computeOpenGatesCount(g)
  const missingEvidencesCount = Math.min(999, Math.max(0, g.readyForQACount || 0))

  const rawResidual = {
    unmetAcCount: ac.remaining,
    failedTestsCount,
    openGatesCount,
    missingEvidencesCount,
    totalScore: 0,
  }
  rawResidual.totalScore =
    rawResidual.unmetAcCount +
    rawResidual.failedTestsCount +
    rawResidual.openGatesCount +
    rawResidual.missingEvidencesCount

  const residual = sanitizeResidual(rawResidual)

  const st = readState(requirementDir)
  const prevScore =
    st.residual && typeof st.residual.totalScore === 'number' ? st.residual.totalScore : null
  const residualDelta = prevScore != null ? residual.totalScore - prevScore : null

  let engineTurn = typeof st.engineTurn === 'number' ? st.engineTurn : 0
  let metricsHistory = Array.isArray(st.metricsHistory) ? [...st.metricsHistory] : []

  if (fromEngine) {
    engineTurn = engineTurn + 1
    metricsHistory.push({
      turn: engineTurn,
      totalResidual: residual.totalScore,
      at: new Date().toISOString(),
    })
    if (metricsHistory.length > 48) metricsHistory = metricsHistory.slice(-48)
    metricsHistory = sanitizeMetricsHistory(metricsHistory)
  }

  const patch = {
    residualItems: ac.residualItems,
    acTotal: ac.acTotal,
    acPassed: ac.acPassed,
    residual,
  }
  if (fromEngine) {
    patch.engineTurn = engineTurn
    patch.metricsHistory = metricsHistory
  }
  mergeState(requirementDir, patch)

  const outTurn = fromEngine ? engineTurn : st.engineTurn || 0
  return {
    acTotal: ac.acTotal,
    acPassed: ac.acPassed,
    remaining: ac.remaining,
    residualItems: ac.residualItems,
    residual,
    residualDelta,
    engineTurn: outTurn,
  }
}

module.exports = {
  syncResidualToState,
  readVerifyLast,
  computeOpenGatesCount,
  buildMinimalGatesFromFiles,
}
