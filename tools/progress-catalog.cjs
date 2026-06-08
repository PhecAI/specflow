/**
 * Declarative progress guidance catalog.
 *
 * Workflow code should prefer emitting `progressKey` + `progressVariables`.
 * This catalog owns reusable user guidance shape; the renderer only fills
 * variables and falls back when a key is unknown.
 */

const PROGRESS_CATALOG = {
  'interaction.domain_init_candidates': {
    goal: '确定本次需求的业务知识边界',
    why: '后续需求说明、技术方案和开发都会优先参考对应业务知识；先确认边界可以避免同名模块或相似业务串入。',
    tasks: [
      '确认本次需求影响的业务领域',
      '判断是否复用已有业务知识库',
      '为后续需求说明准备一致的业务口径',
    ],
    userAction: '请选择或填写一个或多个业务知识库文件名；没有合适文件时，请给出建议新建的知识库名称。',
    next: '我会基于确认的领域继续初始化业务知识库，再进入需求说明整理。',
  },
  'interaction.domain_init_accept': {
    goal: '确认是否创建候选业务知识库',
    why: '这份知识库会成为当前需求的业务口径来源；确认错领域会影响后续规格、方案和开发判断。',
    tasks: [
      '确认领域身份：{{domainRef}}',
      '确认知识库文件：{{domainFile}}',
      '确认后只围绕这个领域边界梳理存量规则',
    ],
    userAction: '请选择是否把这个业务知识库用于本次需求；如果领域不对，请跳过后重新给出更准确的知识库名称。',
    next: '创建后，我会先补齐这份业务知识库，再继续推进需求说明。',
  },
  'interaction.plan_confirm': {
    goal: '确认是否开始技术方案',
    why: '技术方案会把已经定稿的业务口径转换成接口、数据流、任务拆分和验收边界。',
    tasks: [
      '检查是否还有阻塞方案设计的空白',
      '拆分实现任务和验收边界',
      '为后续开发准备清晰执行顺序',
    ],
    userAction: '如果需求说明已经定稿，请确认开始技术方案；如果还要改业务口径，请选择稍后再说。',
    next: '我会生成技术方案和任务拆分，再等待你确认从哪个任务组开始。',
  },
  'interaction.implement_confirm': {
    goal: '确认实现策略',
    why: '技术方案已经生成；开始实现前需要你审阅任务拆分、实现策略和验收边界，并决定是先做当前任务组还是自动托管全部任务组。',
    tasks: [
      '审阅技术方案和任务拆分',
      '选择只开始当前任务组或自动托管全部任务组',
      '确认后进入代码规范同步和任务组开发',
    ],
    userAction: '如果技术方案可以执行，请选择只开始当前任务组或自动托管全部任务组；如果要调整方案，请先修改技术方案。',
    next: '确认后，我会按你的执行策略进入实现准备。',
  },
  'interaction.group_confirm': {
    goal: '确认是否开始 {{nextGroup}}',
    why: '技术方案已经拆成任务组；按组推进可以控制改动范围，并让开发与验收形成闭环。',
    tasks: [
      '开始任务组：{{nextGroup}}',
      '完成该组开发与自测',
      '通过验收后再进入后续任务组或归档',
    ],
    userAction: '请选择开始当前任务组，或开启自动托管让后续任务组连续推进。',
    next: '我会按你的选择进入开发与验收，并在需要业务判断时停下来。',
  },
  'interaction.retry_limit_exceeded': {
    goal: '处理连续验收失败',
    why: '当前任务组已经多次未通过，继续自动重试可能只是在重复同一个问题。',
    tasks: ['暂停自动修复循环', '选择人工介入、查看错误或改用手动处理'],
    userAction: '请选择一种后续处理方式。',
    next: '我会按你的选择继续修复或暂停。',
  },
  'interaction.default': {
    goal: '{{questionSummary}}',
    why: '这一步需要先定下来，后续内容才不会建立在错误前提上。',
    tasks: ['{{questionSummary}}', '{{optionsSummary}}', '确认后继续推进后续流程'],
    userAction: '{{interactionUserAction}}',
    next: '我会根据你的选择继续推进下一步。',
  },
  'dispatch.default': {
    goal: '{{taskTitle}}',
    why: '当前前置条件已经满足，可以进入下一项工作。',
    tasks: ['{{taskTitle}}', '同步当前需求的进度', '遇到需要业务判断的地方会先停下来确认'],
    userAction: '无需额外操作，我会直接继续。',
    next: '完成后会给出本轮结果和下一步。',
  },
  'dispatch.batch': {
    goal: '{{taskTitle}}',
    why: '这些任务相互独立，可以并行推进以减少等待。',
    tasks: ['{{taskTitle}}', '同步当前需求的进度', '遇到需要业务判断的地方会先停下来确认'],
    userAction: '无需额外操作，我会直接继续。',
    next: '完成后会给出本轮结果和下一步。',
  },
  'block.default': {
    goal: '先处理阻塞项',
    why: '{{reason}}',
    tasks: ['处理阻塞原因', '处理好后重新检查当前需求'],
    userAction: '请先处理上面的阻塞项。',
    next: '处理好后，我会继续判断下一步。',
  },
  'anchor.default': {
    goal: '{{headline}}',
    why: '{{body}}',
    tasks: ['确认当前阶段是否可以继续'],
    userAction: '请确认是否继续。',
    next: '确认后我会进入后续收尾流程。',
  },
  'unknown.default': {
    goal: '重新检查当前进展',
    why: '暂时无法判断下一步，需要重新读取当前需求状态。',
    tasks: ['检查当前需求进展', '重新判断下一步'],
    userAction: '请让助手重新检查一下当前步骤。',
    next: '我会重新给出可执行的下一步。',
  },
}

function renderValue(value, variables) {
  const vars = variables && typeof variables === 'object' ? variables : {}
  return String(value == null ? '' : value).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const v = vars[key]
    if (v === undefined || v === null) return ''
    return String(v)
  }).trim()
}

function renderDefinition(definition, variables) {
  if (!definition || typeof definition !== 'object') return null
  const out = {}
  for (const key of ['goal', 'why', 'userAction', 'next']) {
    if (definition[key] !== undefined) out[key] = renderValue(definition[key], variables)
  }
  if (Array.isArray(definition.tasks)) {
    out.tasks = definition.tasks.map((x) => renderValue(x, variables)).filter(Boolean)
  }
  return out
}

function getProgressDefinition(key, variables) {
  const def = PROGRESS_CATALOG[String(key || '')]
  return renderDefinition(def, variables)
}

module.exports = {
  PROGRESS_CATALOG,
  getProgressDefinition,
  renderDefinition,
}
