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
  contract:         { anchor: 'contract',          predicate: (n) => n.level === 2 && /contract|技术契约/i.test(n.title) },
  feature:          { anchor: 'feature',           predicate: (n) => n.level === 2 && /feature\s*&?\s*design|功能/i.test(n.title) },
  roadmap:          { anchor: 'roadmap',           predicate: (n) => n.level === 2 && /roadmap|执行路径/i.test(n.title) },
  executionLog:     { anchor: 'execution-log',     predicate: (n) => n.level === 2 && /\blog\b|执行摘要/i.test(n.title) },
  overview:         { anchor: 'overview',          predicate: (n) => n.level === 2 && /requirement\s*overview|需求概览|背景与目标|背景与价值/i.test(n.title) },
  productDecisions: { anchor: 'product-decisions', predicate: (n) => n.level === 2 && /product\s*decisions|产品决策|决策与边界/i.test(n.title) },
  capabilities:     { anchor: 'capabilities',      predicate: (n) => n.level === 2 && /capabilities|功能切片|功能能力/i.test(n.title) },
  businessObjects:  { anchor: 'business-objects',  predicate: (n) => n.level === 2 && /business\s*objects|业务对象|对象与状态|状态/i.test(n.title) },
  executiveSummary: { anchor: 'executive-summary', predicate: (n) => n.level === 2 && /executive\s*summary|背景与价值/i.test(n.title) },
  userScenarios:    { anchor: 'user-scenarios',    predicate: (n) => n.level === 2 && /user\s*roles|用户角色/i.test(n.title) },
  businessRules:    { anchor: 'business-rules',    predicate: (n) => n.level === 2 && /business\s*rules|业务规则/i.test(n.title) },
  acceptanceCriteria:{ anchor: 'acceptance-criteria',predicate: (n) => n.level === 2 && /acceptance\s*criteria|验收标准/i.test(n.title) },
  clarificationLog: { anchor: 'clarification-log', predicate: (n) => n.level === 2 && /clarification|decision\s*log|决策记录|open\s*product\s*(?:decisions|questions)|待决策|待产品决策|待产品确认|待确认/i.test(n.title) },
  changelog:        { anchor: 'changelog',         predicate: (n) => n.level === 2 && /changelog|修改日志/i.test(n.title) },
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

// ── 动态内容提取（Group / Feature ID 仍使用标题正则，不引入锚点）──

/**
 * 从标题中提取 Group ID 与名称。
 * 兼容 "📦 Group A: 描述"、"Group A: 描述"、"Group A" 等格式。
 */
function parseGroupId(title) {
  const m = title.match(/(Group\s+\w+)(?::\s*(.*))?/i)
  if (!m) return null
  return { id: m[1].trim(), name: (m[2] || '').trim() }
}

/** 从标题中提取 Feature ID（如 [F-01]）。 */
function parseFeatureId(title) {
  const m = title.match(/\[(F-\d+)\]/)
  return m ? m[1] : null
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
  let openCount = 0

  const cqRegex =
    /(^|\n)(#{3,6})\s+\[\?\]\s*(CQ[^\n:]*?)\s*[:：]\s*([^\n]*)\n([\s\S]*?)(?=\n#{3,6}\s+\[\?\]\s*CQ|\n##\s+|$)/g
  let m
  while ((m = cqRegex.exec(text)) !== null) {
    const cqId = m[3].trim()
    const cqTitle = m[4].trim()
    const cqBody = m[5]

    if (isClarificationUserClosed(cqBody)) {
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

  return { open: openCount > 0, openCount, questions, questionsAll: questions }
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

/** 检测 specify.md 是否完整：没有未闭合的澄清且包含必要的章节。这部分被简化，因为现在是一次性生成。 */
function isSpecifyCompleteFromTree(tree) {
  // 只要没有 open 的澄清，就认为完成（AST 会被 parseClarificationFromTree 处理）
  // 新结构以 Capabilities 的「验收要点」为完整性依据；旧结构回退检查 Acceptance Criteria。
  const section = findByKey(tree, 'capabilities') || findByKey(tree, 'acceptanceCriteria')
  return !!section && sectionHasSubstantiveContent(section)
}

// ── Focus 构建器 ────────────────────────────────────────────────────

/**
 * 为 Implement/QA 子代理构建精简版 Plan 上下文（基于 AST）。
 * 按 activeGroupId 关联提取 Scope、Architecture、Contract、Feature 详情、任务列表、Log。
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

  // 追加 Architecture & Tech Stack
  const archSection = findByKey(tree, 'architecture')
  if (archSection) {
    parts.push(renderNode(archSection))
  }

  // 追加 Technical Contracts，给实现提供数据模型和API契约
  const contractSection = findByKey(tree, 'contract')
  if (contractSection) {
    parts.push(renderNode(contractSection))
  }

  // 2. 构建 Feature ID → Node Map
  const featureSection = findByKey(tree, 'feature')
  const featureMap = {}
  if (featureSection) {
    for (const child of featureSection.children) {
      const fid = parseFeatureId(child.title)
      if (fid) featureMap[fid] = child
    }
  }

  // 3. 定位 Active Group
  const roadmapSection = findByKey(tree, 'roadmap')
  if (!roadmapSection) return null

  const activeGroup = roadmapSection.children.find((n) => {
    const gid = parseGroupId(n.title)
    return gid && gid.id === activeGroupId
  })
  if (!activeGroup) return null

  // 4. 从 Group 任务行提取关联 Feature ID
  const groupText = renderNode(activeGroup)
  const relatedFeatureIds = new Set()
  const fidRegex = /\|\s*(F-\d+)/g
  let fm
  while ((fm = fidRegex.exec(groupText)) !== null) {
    relatedFeatureIds.add(fm[1])
  }

  // 5. 组装关联 Feature 块（去除尾部分隔线）
  if (relatedFeatureIds.size > 0) {
    const blocks = []
    for (const fid of relatedFeatureIds) {
      if (featureMap[fid]) {
        let rendered = renderNode(featureMap[fid]).trimEnd()
        rendered = rendered.replace(/\n---\s*$/, '').trimEnd()
        blocks.push(rendered)
      }
    }
    if (blocks.length > 0) {
      parts.push('## Related Features & Design\n\n' + blocks.join('\n\n---\n\n'))
    }
  }

  // 6. Active Group 任务列表
  parts.push('## Active Group\n\n' + groupText)

  // 7. Log 章节
  const logSection = findByKey(tree, 'executionLog')
  if (logSection) {
    parts.push(renderNode(logSection))
  }

  return parts.filter(Boolean).join('\n\n---\n\n')
}

/**
 * 为 Plan 子代理构建精简版 Specify 上下文。
 * 新结构保留：Requirement Overview、Product Decisions、Capabilities、Business Objects。
 * 旧结构回退保留：Executive Summary、User Scenarios、Business Rules、Acceptance Criteria。
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

  const hasNewStructure =
    findByKey(specifyTree, 'overview') ||
    findByKey(specifyTree, 'productDecisions') ||
    findByKey(specifyTree, 'capabilities') ||
    findByKey(specifyTree, 'businessObjects')
  const sectionKeys = hasNewStructure
    ? ['overview', 'productDecisions', 'capabilities', 'businessObjects']
    : ['executiveSummary', 'userScenarios', 'businessRules', 'acceptanceCriteria']
  for (const key of sectionKeys) {
    const section = findByKey(specifyTree, key)
    if (section) {
      parts.push(renderNode(section))
    }
  }

  if (parts.length <= 1) return null
  return parts.filter(Boolean).join('\n\n---\n\n')
}

/**
 * 为 Archive 子代理构建精简版归档上下文。
 * 从 specify 提取：业务摘要（Section 1）。
 * 从 plan 提取：Scope + Feature 标题与 Contract 摘要 + Log 全文。
 */
function buildFocusArchive(specifyTree, planTree) {
  if (!specifyTree && !planTree) return null

  const parts = []

  // ── Specify 部分：Section 1 (Executive Summary) ──
  if (specifyTree) {
    const h1 = specifyTree.children.find((n) => n.level === 1)
    if (h1) {
      let header = renderNodeShallow(h1).trim()
      header = header.replace(/\n---\s*$/, '').trim()
      if (header) parts.push(header)
    }

    const summary = findByKey(specifyTree, 'overview') || findByKey(specifyTree, 'executiveSummary')
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

    const featureSection = findByKey(planTree, 'feature')
    if (featureSection && featureSection.children.length > 0) {
      const featureSummaries = []
      for (const fNode of featureSection.children) {
        const fid = parseFeatureId(fNode.title)
        if (!fid) continue
        const fullText = renderNode(fNode)
        const contractMatch = fullText.match(
          /- \*\*Contract[^*]*\*\*[\s\S]*?(?=\n- \*\*Clarification|$)/i,
        )
        const contractSnippet = contractMatch ? contractMatch[0].trim() : ''
        featureSummaries.push(
          `### [${fid}] ${fNode.title.replace(/\[F-\d+\]\s*/, '')}` +
            (contractSnippet ? '\n' + contractSnippet : ''),
        )
      }
      if (featureSummaries.length > 0) {
        parts.push('## Feature Contracts (摘要)\n\n' + featureSummaries.join('\n\n'))
      }
    }

    const logSection = findByKey(planTree, 'executionLog')
    if (logSection) {
      parts.push(renderNode(logSection))
    }
  }

  if (parts.length === 0) return null
  return parts.filter(Boolean).join('\n\n---\n\n')
}

/**
 * 从 specify.md 全文解析「验收标准」章节中的 Markdown 任务列表，计算 AC 残差。
 * 统计行形如 `- [ ] …` / `- [x] …`（含 `*` 列表）；Total − Passed = remaining。
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
  const section = findByKey(tree, 'acceptanceCriteria')
  if (!section) return empty
  const text = renderNode(section)
  const lines = text.split('\n')
  /** 勾选框内为 x/X 视为通过；Refused/其他非 x 视为未满足 */
  const taskRe = /^\s*[-*]\s+\[([^\]]+)\]\s*(.*)$/
  let acTotal = 0
  let acPassed = 0
  const residualItems = []
  for (const line of lines) {
    const m = line.match(taskRe)
    if (!m) continue
    acTotal++
    const marker = String(m[1] || '').trim()
    const markerLc = marker.toLowerCase()
    const label = String(m[2] || '').trim()
    const isPassed = markerLc === 'x'
    if (isPassed) {
      acPassed++
    } else {
      const short = label.length > 500 ? `${label.slice(0, 500)}…` : label
      if (short) residualItems.push(short)
    }
  }
  const remaining = acTotal - acPassed
  return { acTotal, acPassed, remaining, residualItems }
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
