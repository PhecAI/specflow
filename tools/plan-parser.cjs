/**
 * Markdown 文档解析器：基于标题层级的 AST 解析。
 * 适用于 plan.md 和 specify.md。
 * 章节定位策略：锚点优先（<!-- specflow:section=xxx -->），标题关键词兜底。
 */

// ── Markdown AST ────────────────────────────────────────────────────

const ANCHOR_PREFIX = 'specflow:section='

/**
 * 将 Markdown 解析为标题层级树。
 * @param {string} content - Markdown 原文
 * @returns {{ level: number, title: string, content: string[], children: object[] }}
 */
function parseMarkdownTree(content) {
  const lines = content.split('\n')
  const root = { level: 0, title: '', content: [], children: [] }
  const stack = [root]

  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)/)
    if (m) {
      const level = m[1].length
      const node = { level, title: m[2].trim(), content: [], children: [] }
      while (stack.length > 1 && stack[stack.length - 1].level >= level) {
        stack.pop()
      }
      stack[stack.length - 1].children.push(node)
      stack.push(node)
    } else {
      stack[stack.length - 1].content.push(line)
    }
  }
  return root
}

// ── 节点查找 ────────────────────────────────────────────────────────

/** 深度优先查找第一个满足条件的节点。 */
function findSection(tree, predicate) {
  for (const child of tree.children) {
    if (predicate(child)) return child
    const found = findSection(child, predicate)
    if (found) return found
  }
  return null
}

/** 通过锚点注释查找节点（DFS，检查 node.content 是否包含锚点标记）。 */
function findSectionByAnchor(tree, anchorValue) {
  const target = `${ANCHOR_PREFIX}${anchorValue}`
  return findSection(tree, (node) => node.content.some((line) => line.includes(target)))
}

/**
 * 锚点优先、标题谓词兜底的章节查找。
 * @param {object} tree - AST root
 * @param {string|null} anchorValue - 锚点值（如 'roadmap'）
 * @param {Function|null} titlePredicate - 标题匹配谓词（fallback）
 */
function findSectionRobust(tree, anchorValue, titlePredicate) {
  if (anchorValue) {
    const found = findSectionByAnchor(tree, anchorValue)
    if (found) return found
  }
  return titlePredicate ? findSection(tree, titlePredicate) : null
}

// ── 章节注册表（anchor + 标题谓词）────────────────────────────────

const SECTION_REGISTRY = {
  architecture:     { anchor: 'architecture',      predicate: (n) => n.level === 2 && /architecture|架构/i.test(n.title) },
  roadmap:          { anchor: 'roadmap',           predicate: (n) => n.level === 2 && /roadmap|执行路径/i.test(n.title) },
  overview:         { anchor: 'overview',          predicate: (n) => n.level === 2 && /requirement\s*overview|需求概览|背景与目标|背景与价值/i.test(n.title) },
  productDecisions: { anchor: 'product-decisions', predicate: (n) => n.level === 2 && /product\s*decisions|产品决策|决策与边界/i.test(n.title) },
  capabilities:     { anchor: 'capabilities',      predicate: (n) => n.level === 2 && /capabilities|功能切片|功能能力/i.test(n.title) },
  businessObjects:  { anchor: 'business-objects',  predicate: (n) => n.level === 2 && /business\s*objects|业务对象|对象与状态|状态/i.test(n.title) },
  clarificationLog: { anchor: 'clarification-log', predicate: (n) => n.level === 2 && /clarification|decision\s*log|决策记录|open\s*product\s*(?:decisions|questions)|待决策|待产品决策|待产品确认|待确认/i.test(n.title) },
}

/** 按注册表 key 查找章节（锚点优先 + 标题兜底）。 */
function findByKey(tree, key) {
  const cfg = SECTION_REGISTRY[key]
  if (!cfg) return null
  return findSectionRobust(tree, cfg.anchor, cfg.predicate)
}

// ── 渲染工具 ────────────────────────────────────────────────────────

/** 将节点及其所有子节点渲染为 Markdown 字符串。 */
function renderNode(node) {
  const lines = []
  if (node.level > 0) {
    lines.push('#'.repeat(node.level) + ' ' + node.title)
  }
  lines.push(...node.content)
  for (const child of node.children) {
    lines.push(renderNode(child))
  }
  return lines.join('\n')
}

/** 仅渲染节点自身（标题 + 正文），不递归子节点。 */
function renderNodeShallow(node) {
  const lines = []
  if (node.level > 0) {
    lines.push('#'.repeat(node.level) + ' ' + node.title)
  }
  lines.push(...node.content)
  return lines.join('\n')
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripInlineMarkdown(value) {
  return String(value || '')
    .replace(/\*\*/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim()
}

/**
 * 从新 Specify 的 Capabilities 中提取全局 AC 索引。
 * Capability 结构保留业务语义，AC 索引为 Plan 的覆盖审计提供机器可检验入口。
 */
function extractAcceptanceCriteriaIndex(specifyTree) {
  const capabilities = findByKey(specifyTree, 'capabilities')
  if (!capabilities) return []

  const lines = renderNode(capabilities).split('\n')
  const items = []
  const seen = new Set()
  let currentCapability = ''

  for (const line of lines) {
    const heading = line.match(/^#{3,6}\s+(.+?)\s*$/)
    if (heading) {
      currentCapability = stripInlineMarkdown(heading[1])
      continue
    }

    const match = line.match(/(?:\*\*)?\[(AC-\d{3,})\](?:\*\*)?\s*[:：]?\s*(.+?)\s*$/i)
    if (!match) continue

    const id = match[1].toUpperCase()
    if (seen.has(id)) continue
    seen.add(id)

    items.push({
      id,
      capability: currentCapability,
      text: stripInlineMarkdown(match[2]),
    })
  }

  return items
}

function renderAcceptanceCriteriaIndex(items) {
  if (!items || items.length === 0) return ''
  const lines = ['## Acceptance Criteria Index', '']
  for (const item of items) {
    const capability = item.capability ? ` (${item.capability})` : ''
    lines.push(`- **${item.id}**${capability}: ${item.text}`)
  }
  return lines.join('\n')
}

// ── 动态内容提取（Group ID 仍使用标题正则，不引入锚点）──

/**
 * 从标题中提取 Group ID 与名称。
 * 兼容 "📦 Group A: 描述"、"Group A: 描述"、"Group A" 等格式。
 */
function parseGroupId(title) {
  const m = title.match(/(Group\s+\w+)(?::\s*(.*))?/i)
  if (!m) return null
  return { id: m[1].trim(), name: (m[2] || '').trim() }
}

// ── Plan 专用提取器 ─────────────────────────────────────────────────

function countTaskStates(text) {
  return {
    pending: (text.match(/^\s*-\s+\[\s\]\s+/gm) || []).length,
    readyForQA: (text.match(/^\s*-\s+\[\?\]\s+/gm) || []).length,
    failed: (text.match(/^\s*-\s+\[!\]\s+/gm) || []).length,
    completed: (text.match(/^\s*-\s+\[x\]\s+/gm) || []).length,
  }
}

/** 从 AST 中提取 Roadmap Group 列表。 */
function parseGroupsFromTree(tree) {
  if (!tree) return []
  const roadmap = findByKey(tree, 'roadmap')
  if (!roadmap) return []

  return roadmap.children
    .map((node) => {
      const gid = parseGroupId(node.title)
      if (!gid) return null

      const text = renderNode(node)
      const counts = countTaskStates(text)
      const total = counts.pending + counts.readyForQA + counts.failed + counts.completed

      let status = 'pending'
      if (total === 0) status = 'empty'
      else if (counts.pending === 0 && counts.readyForQA === 0 && counts.failed === 0)
        status = 'completed'
      else status = 'in_progress'

      return { id: gid.id, name: gid.name, status, counts }
    })
    .filter(Boolean)
}

/** 从 AST + Groups 派生 Roadmap 全局统计。 */
function deriveRoadmapStats(tree, groups) {
  if (!tree) return { pending: 0, readyForQA: 0, failed: 0, completed: 0, hasBlocked: false }

  const totals = { pending: 0, readyForQA: 0, failed: 0, completed: 0 }
  for (const g of groups) {
    totals.pending += g.counts.pending
    totals.readyForQA += g.counts.readyForQA
    totals.failed += g.counts.failed
    totals.completed += g.counts.completed
  }

  const roadmapNode = findByKey(tree, 'roadmap')
  const roadmapText = roadmapNode ? renderNode(roadmapNode) : ''
  totals.hasBlocked = /\[Blocked\]|\[BLOCKER\]/i.test(roadmapText)

  return totals
}

// ── Specify 门禁检测（基于 AST，供 specflow-engine 调用）───────────

/**
 * 从全文截取 Clarification Log 区块（锚点优先，其次「## 5.」～「## 6.」），用于 AST 漏检时的兜底。
 */
function extractClarificationSlice(raw) {
  if (!raw) return ''
  const anchorIdx = raw.search(/<!--\s*specflow:section=clarification-log\s*-->/i)
  if (anchorIdx >= 0) {
    const tail = raw.slice(anchorIdx)
    const endIdx = tail.search(/\n##\s+6[\.、]|\n##\s+6\s|<!--\s*specflow:section=changelog/i)
    return endIdx > 0 ? tail.slice(0, endIdx) : tail
  }
  const m = raw.match(/##\s*5\.[^\n]*\n([\s\S]*?)(?=\n##\s*6\.|\n##\s*6、|$)/i)
  return m ? m[1] : ''
}

/** 判断 CQ 正文内 #### **[User]** 是否已有实质回复（非空、非纯占位说明）。优先 #### **[User]**，避免误匹配正文重复行。 */
function isClarificationUserClosed(cqBody) {
  const primary = cqBody.match(
    /####\s+\*\*\[User\]\*\*\s*[:：]\s*([\s\S]*?)(?=\n#{3,6}\s+\[\?\]\s*CQ|\n##\s|$)/,
  )
  if (primary) {
    const val = primary[1].trim()
    if (!val) return false
    const lines = val
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    const substance = lines.filter(
      (l) =>
        !/^\*?\([^)]*\)\*?$/.test(l) &&
        !/^[\*_]*\(User/.test(l) &&
        !/^>\s*$/.test(l),
    )
    return substance.length > 0
  }
  const block = cqBody.match(/\*\*\[User\]\*\*\s*[:：]\s*([\s\S]*?)(?=\n#{3,6}\s+\[\?\]|\n###\s+\[\?\]|\n##\s+|$)/)
  if (!block) return false
  const val = block[1].trim()
  if (!val) return false
  const lines = val
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const substance = lines.filter((l) => !/^\*?\([^)]*\)\*?$/.test(l) && !/^[\*_]*\(User/.test(l))
  return substance.length > 0
}

function extractClarificationUserAnswer(cqBody) {
  const primary = String(cqBody || '').match(
    /####\s+\*\*\[User\]\*\*\s*[:：]\s*([\s\S]*?)(?=\n#{3,6}\s+\[\?\]\s*CQ|\n##\s|$)/,
  )
  const block = primary || String(cqBody || '').match(
    /\*\*\[User\]\*\*\s*[:：]\s*([\s\S]*?)(?=\n#{3,6}\s+\[\?\]|\n###\s+\[\?\]|\n##\s+|$)/,
  )
  if (!block) return ''
  const lines = block[1]
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^\*?\([^)]*\)\*?$/.test(l) && !/^[\*_]*\(User/.test(l))
  return lines.join('\n').trim()
}

/** CQ-Contract / CQ-Tech（非 Init）：标准点选 + 补充说明输入框（与 init_requirement_* 同为双题）。 */
function cqContractTechNeedsDetailField(cqId) {
  const id = String(cqId || '')
  return id.startsWith('CQ-Contract') || /^CQ-Tech-/.test(id)
}

/**
 * 面向用户的话术（避免暴露内部 CQ id、Section 等）；引擎 JSON 仍使用 cqId 作为 question id。
 */
function humanizeClarificationQuestion({
  cqId,
  cqTitle,
  background,
  decisionPrompt,
  confirmationPrompt,
  whyCritical,
  recommendation,
  options,
}) {
  const id = String(cqId || '')
  const opts = Array.isArray(options) ? options : []
  const decisionText = String(decisionPrompt || '').trim()
  const confirmationText = String(confirmationPrompt || '').trim()
  const whyText = String(whyCritical || '').trim()
  const recommendationText = String(recommendation || '').trim()

  function buildDecisionPrompt({ suffix = '' } = {}) {
    const lines = []
    if (confirmationText) {
      lines.push(`需要你确认：${confirmationText}`)
    } else if (decisionText) {
      lines.push(`需要你决定：${decisionText}`)
    } else if (cqTitle) {
      lines.push(String(cqTitle).trim())
    }
    if (whyText) lines.push(`为什么关键：${whyText}`)
    if (recommendationText) lines.push(`SpecFlow 建议：${recommendationText}`)
    if (!lines.length && background) lines.push(String(background).trim())
    const optionLines = opts.length > 0 ? opts.map((o) => `- ${o.label}`).join('\n') : ''
    if (opts.length > 0) {
      return `${lines.filter(Boolean).join('\n\n')}${suffix}\n\n请点选一项：\n${optionLines}`.trim()
    }
    return `${lines.filter(Boolean).join('\n\n') || '请补充说明'}。`
  }

  if (id.startsWith('CQ-Domain-Init')) {
    return {
      prompt:
        '本项目还缺少「业务知识库」（历史业务规则）。为避免新需求与线上逻辑冲突，请先选择：是否先从代码里逐步整理业务规则？\n\n点选一项即可。',
      options: opts.map((o) => {
        const lab = String(o.label || '')
        if (/^Option\s+A/i.test(lab)) return { ...o, label: '是，先扫代码库并逐步生成业务知识库' }
        if (/^Option\s+B/i.test(lab)) return { ...o, label: '否，不扫代码，仅按本次需求写' }
        return o
      }),
    }
  }

  if (id.startsWith('CQ-Contract') || /^CQ-Tech-/.test(id)) {
    if (decisionText || confirmationText || whyText || recommendationText) {
      return {
        prompt: buildDecisionPrompt({
          suffix:
            '\n\n如果选择「其他」或需要补充口径，可继续填写补充说明输入框；一般不需要自己打开文档编辑。',
        }),
        options: opts.map((o) => {
          const lab = String(o.label || '')
          if (/^Option\s+A/i.test(lab)) return { ...o, label: lab.replace(/^Option\s+A[^(：:]*(?:\([^)]*\))?\s*[:：]?\s*/i, 'A：') }
          if (/^Option\s+B/i.test(lab)) return { ...o, label: lab.replace(/^Option\s+B[^(：:]*(?:\([^)]*\))?\s*[:：]?\s*/i, 'B：') }
          if (/^Option\s+C/i.test(lab)) return { ...o, label: lab.replace(/^Option\s+C[^(：:]*(?:\([^)]*\))?\s*[:：]?\s*/i, 'C：') }
          return o
        }),
      }
    }
    return {
      prompt:
        '缺少可落地的接口或字段依据。**三选一**；另有**补充说明输入框**（选「其他」时填写；选 A/B 也可填）。一般会由助手写回需求说明，**不必自己打开文档编辑**。\n\n先点选一项。',
      options: opts.map((o) => {
        const lab = String(o.label || '')
        if (/^Option\s+A/i.test(lab)) return { ...o, label: 'A：补充依据（链接或文字）' }
        if (/^Option\s+B/i.test(lab)) return { ...o, label: 'B：先行实现，后续再改（一句话说清范围）' }
        if (/^Option\s+C/i.test(lab)) return { ...o, label: 'C：其他（自定义说明，见下方输入框）' }
        return o
      }),
    }
  }

  if (decisionText || confirmationText || whyText || recommendationText) {
    return {
      prompt: buildDecisionPrompt(),
      options: opts,
    }
  }

  const lead = [background && String(background).trim(), cqTitle && String(cqTitle).trim()]
    .filter(Boolean)
    .join('')
  const optionLines = opts.length > 0 ? opts.map((o) => `- ${o.label}`).join('\n') : ''
  return {
    prompt:
      opts.length > 0
        ? `${lead ? `${lead}\n\n` : ''}请点选一项：\n${optionLines}`
        : `${lead || '请补充说明'}。`,
    options: opts,
  }
}

function extractQuotedField(cqBody, label) {
  const escaped = String(label || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`>\\s*\\*\\*${escaped}\\*\\*(?::|：)?\\s*([^\\n]*)`, 'i')
  const m = String(cqBody || '').match(re)
  return m ? m[1].trim() : ''
}

/**
 * 检测 Clarification Log 中的未闭合澄清状态，并提取交互问题（供 AskQuestion 使用）。
 * 约定：每个 CQ 对应 #### **[User]**；闭合 = isClarificationUserClosed。
 * CQ 标题行兼容 `#{3,6} [?] CQ-xx` 与中英文冒号。
 */
function parseClarificationText(text) {
  if (!text || !String(text).trim())
    return { open: false, openCount: 0, questions: [], questionsAll: [] }

  const questions = []
  const closedAnswers = []
  let openCount = 0

  const cqRegex =
    /(^|\n)(#{3,6})\s+\[\?\]\s*(CQ[^\n:]*?)\s*[:：]\s*([^\n]*)\n([\s\S]*?)(?=\n#{3,6}\s+\[\?\]\s*CQ|\n##\s+|$)/g
  let m
  while ((m = cqRegex.exec(text)) !== null) {
    const cqId = m[3].trim()
    const cqTitle = m[4].trim()
    const cqBody = m[5]

    if (isClarificationUserClosed(cqBody)) {
      if (!cqId.startsWith('CQ-Domain-Init')) {
        closedAnswers.push({
          id: cqId,
          type: 'clarification',
          title: cqTitle,
          answer: extractClarificationUserAnswer(cqBody),
          source: 'specify.md',
        })
      }
      continue
    }

    openCount++

    let background = ''
    const bgMatch = cqBody.match(/>\s*\*\*背景\*\*(?::|：)?\s*(.*?)\n/)
    if (bgMatch) {
      background = bgMatch[1].trim() + '\n\n'
    } else {
      const quoteMatch = cqBody.match(/>\s*(.*?)\n/)
      if (quoteMatch) background = quoteMatch[1].trim() + '\n\n'
    }
    const decisionPrompt = extractQuotedField(cqBody, '需要你决定')
    const confirmationPrompt = extractQuotedField(cqBody, '需要你确认')
    const whyCritical = extractQuotedField(cqBody, '为什么关键')
    const recommendation = extractQuotedField(cqBody, 'SpecFlow 建议')

    const options = []
    const optRegex = /-\s*\*\*(Option\s+[A-Z0-9]+.*?)\*\*(?::|：)?\s*(.*)/g
    let optM
    while ((optM = optRegex.exec(cqBody)) !== null) {
      const optRawLabel = optM[1].trim()
      const optDesc = optM[2].trim()
      const optId = optRawLabel
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
      options.push({
        id: optId,
        label: optDesc ? `${optRawLabel}: ${optDesc}` : optRawLabel,
      })
    }

    if (options.length === 0) {
      const simpleOptRegex = /-\s*\*\*(Option\s+[A-Z0-9]+)\*\*(?!\s*[:：])/g
      let simpleOptM
      while ((simpleOptM = simpleOptRegex.exec(cqBody)) !== null) {
        const optRawLabel = simpleOptM[1].trim()
        const optId = optRawLabel
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, '_')
          .replace(/_+/g, '_')
          .replace(/^_|_$/g, '')
        options.push({
          id: optId,
          label: optRawLabel,
        })
      }
    }

    const human = humanizeClarificationQuestion({
      cqId,
      cqTitle,
      background,
      decisionPrompt,
      confirmationPrompt,
      whyCritical,
      recommendation,
      options,
    })

    if (options.length > 0) {
      questions.push({
        id: cqId,
        prompt: human.prompt,
        allow_multiple: false,
        options: human.options,
      })
      if (cqContractTechNeedsDetailField(cqId)) {
        questions.push({
          id: `${cqId}__detail`,
          prompt:
            '补充说明（选 **C：其他** 时在此填写；选 A/B 时也可补充要点）。无输入框时在对话里说明即可。',
          allow_multiple: false,
          responseType: 'text',
          placeholder: '自定义描述：期望口径、折中、或其他需说明的情况…',
          options: [],
        })
      }
    } else {
      questions.push({
        id: cqId,
        prompt: human.prompt,
        allow_multiple: false,
        options: [{ id: 'go_to_doc', label: '在对话里补充说明' }],
      })
    }
  }

  return { open: openCount > 0, openCount, questions, questionsAll: questions, closedAnswers }
}

/**
 * @param {object|null} tree - parseMarkdownTree 根
 * @param {string} [rawContent] - specify.md 全文，用于区块兜底解析（避免 AST 漏检导致误判进入 Plan）
 */
function parseClarificationFromTree(tree, rawContent) {
  const section = tree ? findByKey(tree, 'clarificationLog') : null
  const fromSection = section ? renderNode(section) : ''
  let result = parseClarificationText(fromSection)
  if (result.openCount === 0 && rawContent) {
    const slice = extractClarificationSlice(rawContent)
    if (slice) {
      const fromSlice = parseClarificationText(slice)
      if (fromSlice.openCount > result.openCount) result = fromSlice
      else if (
        (Array.isArray(result.closedAnswers) ? result.closedAnswers.length : 0) === 0 &&
        (Array.isArray(fromSlice.closedAnswers) ? fromSlice.closedAnswers.length : 0) > 0
      ) {
        result = { ...result, closedAnswers: fromSlice.closedAnswers }
      }
    }
  }
  return result
}

/**
 * 检测散落在正式正文中的 `[?]`。结构化 CQ 标题允许作为临时澄清草稿存在；
 * 其他位置的 `[?]` 会导致 Plan 门禁阻塞，避免产品/技术疑问混入已定稿正文。
 */
function findInlineClarificationMarkers(rawContent) {
  const text = String(rawContent || '')
  if (!text.trim()) return { count: 0, items: [] }

  const withoutCode = text.replace(/```[\s\S]*?```/g, '')
  const items = []
  const lines = withoutCode.split('\n')
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]
    if (!line.includes('[?]')) continue
    const trimmed = line.trim()
    if (/^#{3,6}\s+\[\?\]\s*CQ/i.test(trimmed)) continue
    items.push({
      line: idx + 1,
      text: trimmed.slice(0, 240),
    })
    if (items.length >= 8) break
  }

  return { count: items.length, items }
}

/**
 * 判断章节是否有实质内容（非仅标题/锚点/空行）。
 * 用于区分「Draft 占位」与「用户或 AI 已补全」的 Section 4-6。
 */
function sectionHasSubstantiveContent(node) {
  if (!node) return false
  const text = renderNode(node)
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const isSkip = (l) =>
    l.startsWith('<!--') && l.includes('specflow:section=') ||
    l === '---' ||
    /^#+\s/.test(l) // 标题行不计入实质内容
  const substantive = lines.filter((l) => !isSkip(l))
  return substantive.length > 0
}

/** 检测 specify.md 是否完整：最新格式必须包含 Capabilities 与实质验收要点。 */
function isSpecifyCompleteFromTree(tree) {
  const section = findByKey(tree, 'capabilities')
  return !!section && sectionHasSubstantiveContent(section)
}

// ── Focus 构建器 ────────────────────────────────────────────────────

function groupHasSelfContainedContext(groupText) {
  const labels = [
    /(?:^|\n)\s*(?:[-*]\s*)?\*\*Goal\*\*\s*[:：]/i,
    /(?:^|\n)\s*(?:[-*]\s*)?\*\*User AC\*\*\s*[:：]/i,
    /(?:^|\n)\s*(?:[-*]\s*)?\*\*Local Contract\*\*\s*[:：]/i,
    /(?:^|\n)\s*(?:[-*]\s*)?\*\*Test Strategy\*\*\s*[:：]/i,
  ]
  return labels.every((re) => re.test(groupText))
}

/**
 * 为 Implement/QA 子代理构建精简版 Plan 上下文（基于 AST）。
 * 最新格式要求 Task Group 自带 User AC / Local Contract / Test Strategy；缺失时不回退拼接旧上下文。
 */
function buildFocusPlanFromTree(tree, activeGroupId) {
  if (!tree || !activeGroupId) return null

  const parts = []

  // 1. Scope: H1 标题 + 其直属正文（不含子章节）
  const h1 = tree.children.find((n) => n.level === 1)
  if (h1) {
    let scope = renderNodeShallow(h1).trim()
    scope = scope.replace(/\n---\s*$/, '').trim()
    if (scope) parts.push(scope)
  } else if (tree.content.length > 0) {
    const scope = tree.content.join('\n').trim()
    if (scope) parts.push(scope)
  }

  // 1. 定位 Active Group
  const roadmapSection = findByKey(tree, 'roadmap')
  if (!roadmapSection) return null

  const activeGroup = roadmapSection.children.find((n) => {
    const gid = parseGroupId(n.title)
    return gid && gid.id === activeGroupId
  })
  if (!activeGroup) return null

  const groupText = renderNode(activeGroup)

  if (groupHasSelfContainedContext(groupText)) {
    parts.push('## Active Task Group\n\n' + groupText)
    return parts.filter(Boolean).join('\n\n---\n\n')
  }

  return null
}

/**
 * 为 Plan 子代理构建精简版 Specify 上下文。
 * 新结构保留：Requirement Overview（含关键产品决策）、Capabilities、Business Objects。
 * 兼容旧版 Product Decisions，但不要求存在。
 * 裁掉：Decision Log / Clarification Log、Changelog。
 */
function buildFocusSpecify(specifyTree) {
  if (!specifyTree) return null

  const parts = []

  const h1 = specifyTree.children.find((n) => n.level === 1)
  if (h1) {
    let header = renderNodeShallow(h1).trim()
    header = header.replace(/\n---\s*$/, '').trim()
    if (header) parts.push(header)
  }

  for (const key of ['overview', 'productDecisions', 'capabilities', 'businessObjects']) {
    const section = findByKey(specifyTree, key)
    if (section) {
      parts.push(renderNode(section))
    }
  }

  const acIndex = renderAcceptanceCriteriaIndex(extractAcceptanceCriteriaIndex(specifyTree))
  if (acIndex) parts.push(acIndex)

  if (parts.length <= 1) return null
  return parts.filter(Boolean).join('\n\n---\n\n')
}

/**
 * 为 Archive 子代理构建精简版归档上下文。
 * 从 specify 提取：业务摘要（Section 1）。
 * 从 plan 提取：Scope + Feature 摘要（旧格式）或 Roadmap Group 摘要（新格式）。
 */
function buildFocusArchive(specifyTree, planTree) {
  if (!specifyTree && !planTree) return null

  const parts = []

  // ── Specify 部分：Requirement Overview ──
  if (specifyTree) {
    const h1 = specifyTree.children.find((n) => n.level === 1)
    if (h1) {
      let header = renderNodeShallow(h1).trim()
      header = header.replace(/\n---\s*$/, '').trim()
      if (header) parts.push(header)
    }

    const summary = findByKey(specifyTree, 'overview')
    if (summary) {
      parts.push(renderNode(summary))
    }
  }

  // ── Plan 部分 ──
  if (planTree) {
    const planH1 = planTree.children.find((n) => n.level === 1)
    if (planH1) {
      let scope = renderNodeShallow(planH1).trim()
      scope = scope.replace(/\n---\s*$/, '').trim()
      if (scope) parts.push(scope)
    }

    const roadmapSection = findByKey(planTree, 'roadmap')
    if (roadmapSection && roadmapSection.children.length > 0) {
      const groupSummaries = []
      for (const groupNode of roadmapSection.children) {
        const gid = parseGroupId(groupNode.title)
        if (!gid) continue
        const text = renderNode(groupNode)
        const lines = text.split('\n')
        const kept = []
        let keepBlock = false
        for (const line of lines) {
          const isTop = /^###\s+/.test(line)
          const isWantedLabel = /^\s*-\s+\*\*(Goal|Depends on|User AC|Local Contract|Files|Test Strategy|Verification Contract|Group Verify)\*\*/i.test(line)
          const isTask = /^\s*-\s+\[[ x?!]\]\s+/.test(line)
          if (isTop || isWantedLabel || isTask) {
            keepBlock = true
            kept.push(line)
            continue
          }
          if (keepBlock && /^\s{2,}-\s+/.test(line)) kept.push(line)
          else if (!line.trim()) keepBlock = false
        }
        if (kept.length > 0) groupSummaries.push(kept.join('\n').trim())
      }
      if (groupSummaries.length > 0) {
        parts.push('## Roadmap Groups (摘要)\n\n' + groupSummaries.join('\n\n'))
      }
    }
  }

  if (parts.length === 0) return null
  return parts.filter(Boolean).join('\n\n---\n\n')
}

/**
 * 从最新 specify.md 的 Capabilities 中解析 AC 索引。
 * 最新格式不在 specify.md 内维护 checkbox 状态；AC 执行残差由 plan task/gate 表达。
 * @param {string} specifyContent
 * @returns {{ acTotal: number, acPassed: number, remaining: number, residualItems: string[] }}
 */
function computeSpecifyAcceptanceResidual(specifyContent) {
  const empty = { acTotal: 0, acPassed: 0, remaining: 0, residualItems: [] }
  if (!specifyContent || typeof specifyContent !== 'string') return empty
  let tree
  try {
    tree = parseMarkdownTree(specifyContent)
  } catch {
    return empty
  }
  const acTotal = extractAcceptanceCriteriaIndex(tree).length
  return { acTotal, acPassed: acTotal, remaining: 0, residualItems: [] }
}

module.exports = {
  parseMarkdownTree,
  findSection,
  findSectionByAnchor,
  findSectionRobust,
  findByKey,
  SECTION_REGISTRY,
  renderNode,
  renderNodeShallow,
  parseGroupsFromTree,
  deriveRoadmapStats,
  parseClarificationFromTree,
  findInlineClarificationMarkers,
  isSpecifyCompleteFromTree,
  buildFocusPlanFromTree,
  buildFocusSpecify,
  buildFocusArchive,
  computeSpecifyAcceptanceResidual,
}
