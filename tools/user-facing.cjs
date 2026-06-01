/**
 * 用户可见话术：与 suggestedAction 解耦，仅输出 templateId + 变量 + fallbackMessage。
 * 模板位于 ../docs/user-facing/，文件名：templateId 中的 "." 替换为 "-"，如 orchestration.blocked → orchestration-blocked.md
 *
 * 全局用语与禁用词（单一事实来源）：../docs/user-facing/VOICE.md
 * 新增/修改对用户展示句时，请先对照 VOICE.md，避免在多处各写一套。
 */

const fs = require('fs')
const path = require('path')

const UTF8 = 'utf-8'
const TEMPLATE_WHITELIST = new Set([
  'orchestration.anchor',
  'orchestration.blocked',
  'orchestration.requirement_id.conflict',
])

function templateIdToFilename(templateId) {
  return String(templateId || 'orchestration.unknown').replace(/\./g, '-') + '.md'
}

function applyVariables(templateBody, variables) {
  if (!templateBody) return ''
  const vars = variables && typeof variables === 'object' ? variables : {}
  return templateBody.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const v = vars[key]
    if (v === undefined || v === null) return ''
    return String(v)
  })
}

function mapPhaseToChinese(phase) {
  switch (phase) {
    case 'Init':
      return '初始化'
    case 'Specify':
      return '规格梳理'
    case 'PlanReadiness':
      return '技术方案准备'
    case 'Plan':
      return '技术方案'
    case 'Implement':
      return '开发与验收'
    case 'Archive':
      return '归档'
    default:
      return '当前阶段'
  }
}

function mapAgentToUserTitle(agent, mode) {
  const a = String(agent || '')
  const m = String(mode || '')
  if (a === 'specflow-specify') return '整理并更新需求规格'
  if (a === 'specflow-specify-review') return '先做一次规格评审'
  if (a === 'specflow-plan') return '编写技术方案与任务拆分'
  if (a === 'specflow-implement') return '开始开发当前任务'
  if (a === 'specflow-qa') return '进行验收检查'
  if (a === 'specflow-archive') return '完成归档收尾'
  if (a === 'specflow-domain-explorer') {
    if (m === 'Merge') return '合并业务知识库'
    return '梳理业务知识库'
  }
  return '推进本需求的下一步工作'
}

function mapRequirementTemplate(initKind, hasSuggestedId) {
  void hasSuggestedId
  if (initKind === 'conflict') return 'orchestration.requirement_id.conflict'
  return 'orchestration.requirement_id.default'
}

function mapInteractionTemplate(questionId) {
  if (String(questionId || '') === 'confirm_start_plan') return 'orchestration.plan_confirm'
  return 'orchestration.interaction'
}

function mapGenericTitle(templateId) {
  const id = String(templateId || '')
  if (id === 'orchestration.dispatch') return '下一步'
  if (id === 'orchestration.clarification') return '待确认信息'
  if (id === 'orchestration.plan_confirm') return '开始技术方案'
  if (id === 'orchestration.interaction') return '需要你的确认'
  if (id.startsWith('orchestration.requirement_id')) return '需求编号确认'
  if (id === 'orchestration.unknown') return '提示'
  return '下一步'
}

function renderGenericTemplate(userFacing) {
  const uf = userFacing && typeof userFacing === 'object' ? userFacing : {}
  const title = mapGenericTitle(uf.templateId)
  const fallback = String(uf.fallbackMessage || '').trim() || '请先确认这一步，我会继续推进。'
  return `### ${title}\n\n${fallback}`
}

function loadTemplateBody(pluginRoot, templateId) {
  const filePath = path.join(pluginRoot, 'docs', 'user-facing', templateIdToFilename(templateId))
  try {
    return fs.readFileSync(filePath, UTF8)
  } catch {
    return ''
  }
}

/**
 * 面向用户的残差摘要（中文，不含内部脚本名）。
 * @param {object} result - 含 residual、residualDelta、engineTurn
 */
function buildResidualSummary(result) {
  const r = result && result.residual
  if (!r || typeof r !== 'object') return ''
  const delta = result.residualDelta
  const turn = result.engineTurn
  let head = `残差合计：${r.totalScore}`
  if (typeof delta === 'number' && delta !== 0) {
    head += `（${delta < 0 ? '较上轮减少' : '较上轮增加'} ${Math.abs(delta)}`
    if (typeof turn === 'number' && turn > 0) head += `，第 ${turn} 轮审计`
    head += '）'
  } else if (typeof turn === 'number' && turn > 0) {
    head += `（第 ${turn} 轮审计）`
  }
  return [
    head,
    `- 验收标准未闭环：${r.unmetAcCount}`,
    `- 最近一次检查未通过项：${r.failedTestsCount}`,
    `- 待处理前置条件：${r.openGatesCount}`,
    `- 待补验收证据的任务：${r.missingEvidencesCount}`,
  ].join('\n')
}

/**
 * @param {object} result - specflow-engine 单次结果（含 suggestedAction、phase、requirementId、gates、acResidual、residual）
 */
function buildUserFacing(result) {
  const schemaVersion = 1
  const sa = result && result.suggestedAction
  const phase = (result && result.phase) || 'Specify'
  const reqId = result && result.requirementId
  const gates = (result && result.gates) || {}

  const resTop = result && result.residual
  const ar = result && result.acResidual
  let remainingCount = 0
  if (resTop && typeof resTop.totalScore === 'number' && Number.isFinite(resTop.totalScore)) {
    remainingCount = Math.max(0, Math.floor(resTop.totalScore))
  } else if (ar && typeof ar === 'object' && typeof ar.remaining === 'number' && Number.isFinite(ar.remaining)) {
    remainingCount = Math.max(0, Math.floor(ar.remaining))
  }

  /** SNR：首行 `Next Actions (Remaining: N)` 的 N 为残差合计 totalScore（无结构化残差时回退 AC 未勾选数） */
  function finish(uf) {
    const rs = buildResidualSummary(result)
    return {
      ...uf,
      remainingCount,
      variables: { ...(uf.variables || {}), residualSummary: rs },
    }
  }

  const requirementLabel =
    reqId != null && String(reqId).trim() !== '' ? String(reqId).trim() : '（尚未指定）'

  if (!sa || typeof sa !== 'object') {
    return finish({
      schemaVersion,
      templateId: 'orchestration.unknown',
      variables: {},
      fallbackMessage: '暂时无法判断进展，请让助手重新检查一下当前步骤。',
    })
  }

  switch (sa.type) {
    case 'anchor': {
      const headline = String(sa.headline || '请确认').trim() || '请确认'
      const body = String(sa.message || sa.body || '').trim()
      return finish({
        schemaVersion,
        templateId: 'orchestration.anchor',
        variables: { headline, body, requirementLabel },
        fallbackMessage: body ? `${headline}：${body.replace(/\*\*/g, '')}` : headline,
      })
    }
    case 'block': {
      const reason = String(sa.reason || '暂时不能继续。').trim()
      return finish({
        schemaVersion,
        templateId: 'orchestration.blocked',
        variables: { reason, requirementLabel },
        fallbackMessage: reason,
      })
    }
    case 'interaction_required': {
      const questions = Array.isArray(sa.questions) ? sa.questions : []
      const initCtx = sa.init_context || {}
      const hasInit =
        questions.some((q) => q && q.id === 'init_requirement_id') ||
        questions.some((q) => q && q.id === 'init_requirement_text')

      if (hasInit) {
        const kind = initCtx.kind || 'empty'
        const suggestedId = initCtx.suggestedId || ''
        const branchId = initCtx.branch_id || ''
        const templateId = mapRequirementTemplate(kind, Boolean(suggestedId))
        return finish({
          schemaVersion,
          templateId,
          variables: {
            suggestedId,
            requirementLabel: suggestedId || branchId || requirementLabel,
          },
          fallbackMessage: '请先确认需求编号。',
        })
      }

      const openCount =
        typeof gates.openClarificationCount === 'number' ? gates.openClarificationCount : 0
      if (gates.clarificationOpen && openCount > 0) {
        const gq = Array.isArray(gates.questions) ? gates.questions : []
        const cqSlotsInBatch = gq.filter(
          (q) => q && q.id && !String(q.id).endsWith('__detail'),
        ).length
        const batchNote =
          openCount > 3 && cqSlotsInBatch > 0
            ? `（本轮最多处理 ${cqSlotsInBatch} 项澄清，其余请稍后在需求说明里补全。）`
            : ''
        return finish({
          schemaVersion,
          templateId: 'orchestration.clarification',
          variables: {
            count: String(openCount),
            batchNote,
          },
          fallbackMessage: `还有 ${openCount} 项待确认，请先完成后再继续。`,
        })
      }

      const q0 = questions[0]
      const qid = q0 && q0.id ? String(q0.id) : ''
      const templateId = mapInteractionTemplate(qid)
      const fallbackMessage =
        qid === 'confirm_start_plan'
          ? '需求说明已就绪，技术前置问题也已处理完。请确认是否开始生成技术方案。'
          : '这里需要你先确认一个选项。'

      return finish({
        schemaVersion,
        templateId,
        variables: {},
        fallbackMessage,
      })
    }
    case 'dispatch': {
      const taskTitle = mapAgentToUserTitle(sa.agent, sa.mode)
      const phaseName = mapPhaseToChinese(phase)
      return finish({
        schemaVersion,
        templateId: 'orchestration.dispatch',
        variables: {
          requirementLabel,
          phaseName,
          taskTitle,
        },
        fallbackMessage: `下一步会先${taskTitle}（需求：${requirementLabel}）。`,
      })
    }
    case 'dispatch_array': {
      const agents = Array.isArray(sa.agents) ? sa.agents : []
      const phaseName = mapPhaseToChinese(phase)
      const names = agents
        .map((a) => mapAgentToUserTitle(a && a.agent, a && a.mode))
        .filter(Boolean)
      const taskTitle = names.length > 0 ? names.join('、') : '推进多个独立任务'
      return finish({
        schemaVersion,
        templateId: 'orchestration.dispatch',
        variables: {
          requirementLabel,
          phaseName,
          taskTitle,
        },
        fallbackMessage: `下一步会先${taskTitle}（需求：${requirementLabel}）。`,
      })
    }
    default:
      return finish({
        schemaVersion,
        templateId: 'orchestration.unknown',
        variables: {},
        fallbackMessage: '当前需要处理一小步，请看助手说明或稍后再试。',
      })
  }
}

/**
 * @param {object} userFacing - buildUserFacing 返回值
 * @param {string} pluginRoot - 插件根目录（含 docs/user-facing）
 */
function renderUserFacingMarkdown(userFacing, pluginRoot) {
  const uf =
    userFacing && typeof userFacing === 'object'
      ? userFacing
      : { templateId: 'orchestration.unknown', variables: {} }
  const n = typeof uf.remainingCount === 'number' && Number.isFinite(uf.remainingCount) ? uf.remainingCount : 0
  const headLine = `Next Actions (Remaining: ${n})`
  const id = uf.templateId || 'orchestration.unknown'
  const useTemplate = TEMPLATE_WHITELIST.has(id)
  if (useTemplate) {
    const body = loadTemplateBody(pluginRoot, id)
    if (body) {
      const rendered = applyVariables(body, uf.variables || {})
      return `${headLine}\n\n${rendered.trim()}\n`
    }
  }
  const rendered = renderGenericTemplate(uf)
  return `${headLine}\n\n${rendered.trim()}\n`
}

/**
 * dispatch 前：基于 pending-protocol.json 生成与人话模板一致的预览（不含 agent 字段名）。
 */
function buildDispatchPreviewMarkdown(workspaceRoot, requirementId, scriptsDir) {
  const pluginRoot = path.join(scriptsDir, '..')
  const protocolPath = path.join(workspaceRoot, 'ai-docs', requirementId, '.temp', 'pending-protocol.json')
  if (!fs.existsSync(protocolPath)) {
    return renderUserFacingMarkdown(
      {
        templateId: 'orchestration.unknown',
        variables: {},
        fallbackMessage: '暂时拿不到下一步信息，请让我重新检查一次后继续。',
      },
      pluginRoot,
    )
  }
  let data
  try {
    data = JSON.parse(fs.readFileSync(protocolPath, UTF8))
  } catch {
    return renderUserFacingMarkdown(
      {
        templateId: 'orchestration.unknown',
        variables: {},
        fallbackMessage: '下一步信息读取失败，我重新检查后继续。',
      },
      pluginRoot,
    )
  }
  let taskTitle
  if (data && data.kind === 'dispatch_array' && Array.isArray(data.items)) {
    const groupCount = data.items.length
    const groupIds = data.items.map((it) => it && it.groupId).filter(Boolean).join('、')
    taskTitle = groupCount > 1
      ? `并行推进 ${groupCount} 个任务组（${groupIds || '未命名'}）`
      : mapAgentToUserTitle(data.items[0] && data.items[0].agent, null)
  } else {
    taskTitle = mapAgentToUserTitle(data.agent, data.mode)
  }
  const phaseName = mapPhaseToChinese(data.phase || 'Specify')
  const requirementLabel = String(data.requirementId || requirementId || '（尚未指定）').trim()
  let remainingCount = 0
  let residualSummary = ''
  try {
    const rid = String(data.requirementId || requirementId || '').trim()
    if (rid) {
      const { syncResidualToState } = require('./residual-metrics.cjs')
      const reqDir = path.join(workspaceRoot, 'ai-docs', rid)
      const snap = syncResidualToState(reqDir, workspaceRoot, null, { fromEngine: false })
      if (snap && snap.residual && typeof snap.residual.totalScore === 'number') {
        remainingCount = Math.max(0, Math.floor(snap.residual.totalScore))
      } else if (snap && typeof snap.remaining === 'number') {
        remainingCount = Math.max(0, Math.floor(snap.remaining))
      }
      residualSummary = buildResidualSummary({
        residual: snap.residual,
        residualDelta: snap.residualDelta,
        engineTurn: snap.engineTurn,
      })
    }
  } catch (_) {
    remainingCount = 0
  }
  return renderUserFacingMarkdown(
    {
      templateId: 'orchestration.dispatch',
      variables: { requirementLabel, phaseName, taskTitle, residualSummary },
      remainingCount,
      fallbackMessage: `下一步：${taskTitle}（需求：${requirementLabel}）。`,
    },
    pluginRoot,
  )
}

module.exports = {
  buildUserFacing,
  buildResidualSummary,
  renderUserFacingMarkdown,
  buildDispatchPreviewMarkdown,
  applyVariables,
  templateIdToFilename,
  mapAgentToUserTitle,
  mapPhaseToChinese,
}
