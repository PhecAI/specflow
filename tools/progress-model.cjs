/**
 * Progress Model
 *
 * The engine owns workflow facts. This layer converts those facts into a
 * structured user-facing model that can be rendered deterministically or used
 * by an LLM to compose richer guidance without guessing workflow state.
 */

const { getProgressDefinition } = require('./progress-catalog.cjs')

function nonEmpty(value, fallback = '') {
  const s = value == null ? '' : String(value).trim()
  return s || fallback
}

function compactList(items) {
  return (Array.isArray(items) ? items : [])
    .map((x) => nonEmpty(x))
    .filter(Boolean)
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

function promptSummary(prompt) {
  const line = String(prompt || '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .find((x) => !/^[-*]/.test(x))
  return line || '确认当前选项'
}

function optionSummary(options) {
  const labels = (Array.isArray(options) ? options : [])
    .map((o) => nonEmpty(o && o.label))
    .filter(Boolean)
  if (labels.length === 0) return ''
  if (labels.length <= 3) return labels.join(' / ')
  return `${labels.slice(0, 3).join(' / ')} 等 ${labels.length} 个选项`
}

function inferQuestionProgressKey(questionId) {
  const qid = String(questionId || '')
  if (qid === 'domain_init_candidates_text') return 'interaction.domain_init_candidates'
  if (qid.startsWith('domain_init_accept__')) return 'interaction.domain_init_accept'
  if (qid === 'confirm_start_plan') return 'interaction.plan_confirm'
  if (qid === 'confirm_start_group') return 'interaction.group_confirm'
  if (qid === 'retry_limit_exceeded') return 'interaction.retry_limit_exceeded'
  return 'interaction.default'
}

function buildProgressVariables({ phase, requirementLabel, question, suggestedAction, taskTitle }) {
  const q = question && typeof question === 'object' ? question : {}
  const sa = suggestedAction && typeof suggestedAction === 'object' ? suggestedAction : {}
  const prompt = nonEmpty(q.prompt)
  const options = optionSummary(q.options)
  const questionSummary = promptSummary(prompt)
  const variables = {
    phase,
    phaseName: mapPhaseToChinese(phase),
    requirementLabel,
    questionId: nonEmpty(q.id),
    questionSummary,
    optionsSummary: options ? `选择处理方式：${options}` : '',
    interactionUserAction: options ? '请从给出的选项中选择一项。' : '请补充当前问题需要的信息。',
    taskTitle: nonEmpty(taskTitle),
    nextGroup: nonEmpty(sa.next_group_id, '当前任务组'),
    reason: nonEmpty(sa.reason, '当前还有阻塞，暂时不能继续。'),
    headline: nonEmpty(sa.headline, '请确认'),
    body: nonEmpty(sa.message || sa.body),
  }
  Object.assign(variables, sa.progressVariables || {}, q.progressVariables || {})
  return variables
}

function mergeProgress(base, override) {
  if (!override || typeof override !== 'object') return base
  return {
    ...base,
    ...override,
    tasks: compactList(override.tasks || base.tasks),
    llm: { ...(base.llm || {}), ...(override.llm || {}) },
  }
}

function buildQuestionProgress({ phase, requirementLabel, question, questions, suggestedAction }) {
  const q = question && typeof question === 'object' ? question : {}
  const qid = nonEmpty(q.id)
  const prompt = nonEmpty(q.prompt)
  const options = optionSummary(q.options)
  const phaseName = mapPhaseToChinese(phase)
  const progressKey = nonEmpty(q.progressKey || (suggestedAction && suggestedAction.progressKey), inferQuestionProgressKey(qid))
  const variables = buildProgressVariables({ phase, requirementLabel, question: q, suggestedAction })
  const base = {
    kind: 'interaction',
    progressKey,
    phase,
    phaseName,
    requirementLabel,
    questionId: qid,
    goal: promptSummary(prompt),
    why: '这一步需要先定下来，后续内容才不会建立在错误前提上。',
    tasks: compactList([
      promptSummary(prompt),
      options ? `选择处理方式：${options}` : '',
      '确认后继续推进后续流程',
    ]),
    userAction: options ? '请从给出的选项中选择一项。' : '请补充当前问题需要的信息。',
    next: '我会根据你的选择继续推进下一步。',
  }

  void questions
  return mergeProgress(base, getProgressDefinition(progressKey, variables))
}

function buildDispatchProgress({ phase, requirementLabel, suggestedAction }) {
  const sa = suggestedAction || {}
  const isBatch = sa.type === 'dispatch_array'
  const agents = isBatch && Array.isArray(sa.agents) ? sa.agents : []
  const names = isBatch
    ? agents.map((a) => mapAgentToUserTitle(a && a.agent, a && a.mode)).filter(Boolean)
    : [mapAgentToUserTitle(sa.agent, sa.mode)]
  const taskTitle = names.length > 0 ? names.join('、') : '推进下一步工作'
  const phaseName = mapPhaseToChinese(phase)
  const progressKey = nonEmpty(sa.progressKey, isBatch ? 'dispatch.batch' : 'dispatch.default')
  const variables = buildProgressVariables({ phase, requirementLabel, suggestedAction: sa, taskTitle })
  const base = {
    kind: isBatch ? 'dispatch_array' : 'dispatch',
    progressKey,
    phase,
    phaseName,
    requirementLabel,
    goal: taskTitle,
    why: isBatch
      ? '这些任务相互独立，可以并行推进以减少等待。'
      : '当前前置条件已经满足，可以进入下一项工作。',
    tasks: compactList([
      taskTitle,
      '同步当前需求的进度',
      '遇到需要业务判断的地方会先停下来确认',
    ]),
    userAction: '无需额外操作，我会直接继续。',
    next: '完成后会给出本轮结果和下一步。',
  }
  return mergeProgress(base, getProgressDefinition(progressKey, variables))
}

function buildProgressModel(result) {
  const sa = result && result.suggestedAction
  const phase = (result && result.phase) || 'Specify'
  const phaseName = mapPhaseToChinese(phase)
  const reqId = result && result.requirementId
  const requirementLabel = reqId != null && String(reqId).trim() !== '' ? String(reqId).trim() : '（尚未指定）'

  let model
  if (!sa || typeof sa !== 'object') {
    model = {
      kind: 'unknown',
      phase,
      phaseName,
      requirementLabel,
      goal: '重新检查当前进展',
      why: '暂时无法判断下一步，需要重新读取当前需求状态。',
      tasks: ['检查当前需求进展', '重新判断下一步'],
      userAction: '请让助手重新检查一下当前步骤。',
      next: '我会重新给出可执行的下一步。',
    }
  } else if (sa.type === 'interaction_required') {
    const questions = Array.isArray(sa.questions) ? sa.questions : []
    model = buildQuestionProgress({
      phase,
      requirementLabel,
      question: questions[0],
      questions,
      suggestedAction: sa,
    })
  } else if (sa.type === 'dispatch' || sa.type === 'dispatch_array') {
    model = buildDispatchProgress({ phase, requirementLabel, suggestedAction: sa })
  } else if (sa.type === 'block') {
    const progressKey = nonEmpty(sa.progressKey, 'block.default')
    const variables = buildProgressVariables({ phase, requirementLabel, suggestedAction: sa })
    model = mergeProgress({
      kind: 'block',
      progressKey,
      phase,
      phaseName,
      requirementLabel,
      goal: '先处理阻塞项',
      why: nonEmpty(sa.reason, '当前还有阻塞，暂时不能继续。'),
      tasks: ['处理阻塞原因', '处理好后重新检查当前需求'],
      userAction: '请先处理上面的阻塞项。',
      next: '处理好后，我会继续判断下一步。',
    }, getProgressDefinition(progressKey, variables))
  } else if (sa.type === 'anchor') {
    const progressKey = nonEmpty(sa.progressKey, 'anchor.default')
    const variables = buildProgressVariables({ phase, requirementLabel, suggestedAction: sa })
    model = mergeProgress({
      kind: 'anchor',
      progressKey,
      phase,
      phaseName,
      requirementLabel,
      goal: nonEmpty(sa.headline, '请确认'),
      why: nonEmpty(sa.message || sa.body),
      tasks: ['确认当前阶段是否可以继续'],
      userAction: '请确认是否继续。',
      next: '确认后我会进入后续收尾流程。',
    }, getProgressDefinition(progressKey, variables))
  } else {
    model = {
      kind: nonEmpty(sa.type, 'unknown'),
      phase,
      phaseName,
      requirementLabel,
      goal: '处理当前步骤',
      why: '当前流程需要完成这一小步才能继续。',
      tasks: ['完成当前步骤', '继续推进需求流程'],
      userAction: '请根据提示完成当前操作。',
      next: '我会继续推进后续流程。',
    }
  }

  model = mergeProgress(model, sa && sa.progress)
  model.llm = {
    mode: 'compose_guidance_from_progress_model',
    instruction:
      'Use this progress model as the source of truth. You may rewrite tone and ordering, but do not invent workflow state, tasks, user actions, or next steps.',
    requiredFields: ['goal', 'why', 'tasks', 'userAction', 'next'],
    ...(model.llm || {}),
  }
  return model
}

function renderProgressModel(model) {
  const m = model && typeof model === 'object' ? model : {}
  const lines = []
  const phaseName = nonEmpty(m.phaseName)
  const requirementLabel = nonEmpty(m.requirementLabel)
  const goal = nonEmpty(m.goal)
  const why = nonEmpty(m.why)
  const tasks = compactList(m.tasks)
  const userAction = nonEmpty(m.userAction)
  const next = nonEmpty(m.next)

  if (requirementLabel || phaseName || goal) {
    const bits = []
    if (requirementLabel) bits.push(`当前需求：${requirementLabel}`)
    if (phaseName) bits.push(`阶段：${phaseName}`)
    if (goal) bits.push(`目标：${goal}`)
    lines.push(bits.join('。'))
  }
  if (why) lines.push('', why)
  if (tasks.length > 0) {
    lines.push('', '**这一步会做：**')
    for (const item of tasks) lines.push(`- ${item}`)
  }
  if (userAction) {
    lines.push('', '**你现在只需要：**')
    lines.push(userAction)
  }
  if (next) {
    lines.push('', '**之后会继续：**')
    lines.push(next)
  }
  return lines.join('\n').trim()
}

module.exports = {
  buildProgressModel,
  renderProgressModel,
  mapAgentToUserTitle,
  mapPhaseToChinese,
}
