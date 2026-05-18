const fs = require('fs')
const path = require('path')

const UTF8 = 'utf-8'

function normalizeCodingPatchSection(raw) {
  return String(raw || '').trim().toLowerCase() || 'general'
}

function normalizeCodingPatchContent(raw) {
  return String(raw || '').trim()
}

const PATCH_KIND_ADDITION = 'addition'
const PATCH_KIND_OVERRIDE = 'override'

const STRENGTH_HARD = 'hard'
const STRENGTH_SOFT = 'soft'

function normalizeCodingPatchKind(raw) {
  const v = String(raw || '').trim().toLowerCase()
  return v === PATCH_KIND_OVERRIDE ? PATCH_KIND_OVERRIDE : PATCH_KIND_ADDITION
}

function normalizeCodingPatchBasedOn(raw) {
  const v = String(raw || '').trim()
  return v || undefined
}

function normalizeCodingPatchStrength(raw) {
  const v = String(raw || '').trim().toLowerCase()
  if (v === STRENGTH_HARD || v === 'strong' || v === '强') return STRENGTH_HARD
  if (v === STRENGTH_SOFT || v === 'weak' || v === '弱' || v === '软') return STRENGTH_SOFT
  return undefined
}

// 从 content 前缀剥离 [Hard]/[Soft] 标记为 strength 字段；返回 { content, strength }
// 原因：历史数据把 [Hard] 混在 content 字面里，导致 dedup 与渲染失真。
function stripStrengthPrefix(raw) {
  const text = String(raw || '')
  const m = text.match(/^\s*\[(hard|soft)\]\s*/i)
  if (!m) return { content: text.trim(), strength: undefined }
  return {
    content: text.slice(m[0].length).trim(),
    strength: m[1].toLowerCase() === 'hard' ? STRENGTH_HARD : STRENGTH_SOFT,
  }
}

// 规则 content 归一化键（仅用于 dedup/matching 比较，不落盘）
// - 剥前缀、去反引号、小写、压缩空白、去首尾常见标点
function normalizeContentForDedup(raw) {
  let s = String(raw || '')
  s = s.replace(/^\s*\[(hard|soft)\]\s*/i, '')
  s = s.replace(/`/g, '')
  s = s.toLowerCase()
  s = s.replace(/[。；;,.\s:：]+$/u, '')
  s = s.replace(/^[。；;,.\s:：]+/u, '')
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

function normalizeCodingPatchApplies(raw) {
  if (raw == null) return undefined
  const arr = Array.isArray(raw)
    ? raw
    : String(raw)
        .split(/[,;]/)
        .map((s) => s.trim())
  const out = []
  for (const s of arr) {
    if (typeof s !== 'string') continue
    const v = s.trim()
    if (!v) continue
    // 防御性裁剪：单条 glob 上限 200 字符；总数上限 16
    out.push(v.length > 200 ? v.slice(0, 200) : v)
    if (out.length >= 16) break
  }
  return out.length > 0 ? out : undefined
}

// 从规则原文尾部循环抽取 `(applies: a, b)` 与 `(source: req-id)` 元数据；返回 { content, applies, sourceRequirementId }
// 兼容两者顺序任意；其它形如 `(基于: ...)` 等已知后缀也会被剥离（不返回）。
function stripAppliesSuffix(raw) {
  let text = String(raw || '')
  let applies
  let sourceRequirementId
  for (let i = 0; i < 4; i++) {
    const a = text.match(/\s*\(applies:\s*([^)]+)\)\s*$/i)
    if (a) {
      const v = normalizeCodingPatchApplies(a[1])
      if (v) applies = v
      text = text.slice(0, a.index)
      continue
    }
    const s = text.match(/\s*\(source:\s*([^)]+)\)\s*$/i)
    if (s) {
      const v = String(s[1] || '').trim()
      if (v) sourceRequirementId = v
      text = text.slice(0, s.index)
      continue
    }
    const b = text.match(/\s*\(基于:\s*([^)]+)\)\s*$/)
    if (b) {
      text = text.slice(0, b.index)
      continue
    }
    break
  }
  return { content: text.trim(), applies, sourceRequirementId }
}

function extractCodingStandardPatchesFromPlan(planContent) {
  const patches = []
  if (!planContent) return patches
  // 同时识别 [CodeStyle] 与 [CodeStyle:override]；可选尾缀 `(基于: <原文>)` 与 `(applies: a, b)`
  const re = /-\s*\[CodeStyle(?::(addition|override))?\]\s*(.*)$/gim
  let m
  while ((m = re.exec(planContent)) !== null) {
    const kind = normalizeCodingPatchKind(m[1])
    let raw = (m[2] || '').trim()
    if (!raw) continue
    let basedOn
    let applies
    // 顺序无关地剥离尾部 `(applies: ...)` 与 `(基于: ...)` 后缀（可同时存在）
    for (let i = 0; i < 2; i++) {
      const appliesMatch = raw.match(/\s*\(applies:\s*([^)]+)\)\s*$/i)
      if (appliesMatch) {
        applies = normalizeCodingPatchApplies(appliesMatch[1])
        raw = raw.slice(0, appliesMatch.index).trim()
        continue
      }
      const basedOnMatch = raw.match(/\s*\(基于:\s*([^)]+)\)\s*$/)
      if (basedOnMatch) {
        basedOn = normalizeCodingPatchBasedOn(basedOnMatch[1])
        raw = raw.slice(0, basedOnMatch.index).trim()
        continue
      }
      break
    }
    let section = 'general'
    let content = raw
    const colonIdx = raw.indexOf(':')
    if (colonIdx > 0) {
      section = normalizeCodingPatchSection(raw.slice(0, colonIdx))
      content = normalizeCodingPatchContent(raw.slice(colonIdx + 1))
    } else {
      content = normalizeCodingPatchContent(raw)
    }
    if (!content) continue
    // 从 content 前缀剥离 [Hard]/[Soft]，字段化
    const stripped = stripStrengthPrefix(content)
    const finalContent = stripped.content
    if (!finalContent) continue
    const item = {
      section,
      content: finalContent,
      kind,
      extractedAt: new Date().toISOString(),
    }
    if (stripped.strength) item.strength = stripped.strength
    if (basedOn) item.basedOn = basedOn
    if (applies) item.applies = applies
    patches.push(item)
  }
  return patches
}

function mergeCodingPatches(existing, incoming, options = {}) {
  const sourceRequirementId = String(options.sourceRequirementId || '').trim()
  const out = []
  const seen = new Map()
  const all = [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]
  for (const item of all) {
    const section = normalizeCodingPatchSection(item && item.section)
    const rawContent = normalizeCodingPatchContent(item && item.content)
    if (!rawContent) continue
    const kind = normalizeCodingPatchKind(item && item.kind)
    const basedOn = normalizeCodingPatchBasedOn(item && item.basedOn)
    const applies = normalizeCodingPatchApplies(item && item.applies)

    // 兼容：content 可能携带 [Hard]/[Soft] 前缀，或 item 已有 strength 字段
    const stripped = stripStrengthPrefix(rawContent)
    const content = stripped.content
    const strength =
      stripped.strength ||
      normalizeCodingPatchStrength(item && item.strength) ||
      undefined

    // dedup key 用归一化文本，避免 `[Hard] X` 与 `X。` 判成两条
    const dedupKey = `${kind}::${section}::${normalizeContentForDedup(content)}`

    const normalized = {
      section,
      content,
      kind,
      extractedAt: (item && item.extractedAt) || new Date().toISOString(),
      sourceRequirementId:
        (item && String(item.sourceRequirementId || '').trim()) ||
        sourceRequirementId ||
        undefined,
    }
    if (strength) normalized.strength = strength
    if (basedOn) normalized.basedOn = basedOn
    if (applies) normalized.applies = applies

    const prev = seen.get(dedupKey)
    if (prev) {
      // 合并策略：
      // - strength 取强者（任一 hard 则 hard）
      // - applies 取并集
      // - sourceRequirementId 取最新非空
      // - basedOn 沿用最新非空
      // - extractedAt 取最新
      if (prev.strength === STRENGTH_HARD || normalized.strength === STRENGTH_HARD) {
        normalized.strength = STRENGTH_HARD
      } else if (!normalized.strength && prev.strength) {
        normalized.strength = prev.strength
      }
      const mergedApplies = Array.from(
        new Set([...(prev.applies || []), ...(normalized.applies || [])]),
      )
      if (mergedApplies.length > 0) normalized.applies = mergedApplies
      if (!normalized.sourceRequirementId && prev.sourceRequirementId) {
        normalized.sourceRequirementId = prev.sourceRequirementId
      }
      if (!normalized.basedOn && prev.basedOn) normalized.basedOn = prev.basedOn
    }
    seen.set(dedupKey, normalized)
  }
  for (const v of seen.values()) out.push(v)
  return out
}

function parseGlobalCodeStyleRules(content) {
  const rules = []
  if (!content) return rules
  const lines = String(content)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  for (const line of lines) {
    // 跳过章节标题与 scope 标题（Rules by Scope 下的 `### \`<glob>\``）
    if (/^#/.test(line)) continue
    // 支持全局合并产物：- [section] content [可选 (applies: globs)]
    let m = line.match(/^-\s*\[([^\]]+)\]\s+(.+)$/)
    if (m) {
      const sectionRaw = m[1]
      // 排除掉前缀是 Hard/Soft/CodeStyle 等关键字（会被下面独立分支处理）
      if (!/^(hard|soft|codestyle|codingstyle|代码规范)$/i.test(sectionRaw.trim())) {
        const stripped = stripAppliesSuffix(m[2])
        const strengthSplit = stripStrengthPrefix(stripped.content)
        const rule = {
          section: normalizeCodingPatchSection(sectionRaw),
          content: normalizeCodingPatchContent(strengthSplit.content),
        }
        if (strengthSplit.strength) rule.strength = strengthSplit.strength
        if (stripped.applies) rule.applies = stripped.applies
        rules.push(rule)
        continue
      }
    }
    // 兼容文档式写法：- [CodeStyle] section: content
    m = line.match(/^-\s*\[(?:CodeStyle|CodingStyle|代码规范)\]\s*([^:\]]*?)\s*:\s*(.+)$/i)
    if (m) {
      const stripped = stripAppliesSuffix(m[2])
      const strengthSplit = stripStrengthPrefix(stripped.content)
      const rule = {
        section: normalizeCodingPatchSection(m[1]),
        content: normalizeCodingPatchContent(strengthSplit.content),
      }
      if (strengthSplit.strength) rule.strength = strengthSplit.strength
      if (stripped.applies) rule.applies = stripped.applies
      rules.push(rule)
    }
  }
  // 对 parse 结果也做一次归一化去重（rules 结构轻量，kind 固定 addition）
  const seen = new Map()
  for (const r of rules.filter((x) => x.content)) {
    const key = `${r.section}::${normalizeContentForDedup(r.content)}`
    const prev = seen.get(key)
    if (prev) {
      if (prev.strength === STRENGTH_HARD || r.strength === STRENGTH_HARD) {
        r.strength = STRENGTH_HARD
      } else if (!r.strength && prev.strength) {
        r.strength = prev.strength
      }
      const mergedApplies = Array.from(
        new Set([...(prev.applies || []), ...(r.applies || [])]),
      )
      if (mergedApplies.length > 0) r.applies = mergedApplies
    }
    seen.set(key, r)
  }
  return Array.from(seen.values())
}

// 简易 glob → RegExp：支持 `**`（跨段，可匹配 0 段目录）、`*`（单段非 /）、精确字面
// 关键点：`/**/` 视为整体，需匹配 0 段（`a/b.ts` 能匹配 `a/**/b.ts`），与 minimatch/gitignore 一致
function globToRegExp(glob) {
  let pattern = String(glob || '')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // 转义 regex 特殊字符（不含 * ?）
  // `/**/` → 占位 \u0002，恢复时变 `(?:/.*)?/`（允许 0 段）
  pattern = pattern.replace(/\/\*\*\//g, '\u0002')
  // `**/` 开头（如 `**/*.ts`）→ 占位 \u0003，恢复为 `(?:.*/)?`
  pattern = pattern.replace(/^\*\*\//, '\u0003')
  // `/**` 结尾（如 `src/**`）→ 占位 \u0004，恢复为 `(?:/.*)?`
  pattern = pattern.replace(/\/\*\*$/, '\u0004')
  // 剩余 `**` → `.*`
  pattern = pattern.replace(/\*\*/g, '.*')
  // `*` → `[^/]*`；`?` → `.`
  pattern = pattern.replace(/\*/g, '[^/]*').replace(/\?/g, '.')
  // 占位恢复
  pattern = pattern
    .replace(/\u0002/g, '(?:/.*)?/')
    .replace(/\u0003/g, '(?:.*/)?')
    .replace(/\u0004/g, '(?:/.*)?')
  return new RegExp('^' + pattern + '$')
}

function matchRulesForPaths(rules, filePaths, options = {}) {
  const includeGlobal = options.includeGlobal !== false
  const paths = (Array.isArray(filePaths) ? filePaths : [])
    .map((p) => String(p || '').trim())
    .filter(Boolean)
  if (!Array.isArray(rules) || rules.length === 0) return []
  const out = []
  const seen = new Set()
  for (const rule of rules) {
    const applies = Array.isArray(rule.applies) ? rule.applies.filter(Boolean) : []
    let hit = false
    if (applies.length === 0) {
      hit = includeGlobal
    } else if (paths.length > 0) {
      for (const g of applies) {
        const re = globToRegExp(g)
        if (paths.some((p) => re.test(p))) {
          hit = true
          break
        }
      }
    }
    if (!hit) continue
    const key = `${normalizeCodingPatchSection(rule.section)}::${normalizeContentForDedup(rule.content)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(rule)
  }
  return out
}

// 从 focusPlan / plan.md 的 Active Group 任务行抽取 Create/Modify/Update 文件路径
function extractTaskFilePaths(text) {
  const out = []
  const seen = new Set()
  if (!text) return out
  const re = /\*\*(?:Create|Modify|Update|Edit|Replace|Delete)\*\*\s*:\s*`?([^`|\n]+?)`?\s*(?=\||$)/gim
  let m
  while ((m = re.exec(String(text))) !== null) {
    const p = m[1].trim()
    if (p && !seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  return out
}

function readGlobalCodeStyleRules(workspaceRoot) {
  const globalPath = path.join(
    workspaceRoot,
    'ai-docs',
    'global-assets',
    'standards',
    'code-style.md',
  )
  const globalRules = fs.existsSync(globalPath)
    ? parseGlobalCodeStyleRules(fs.readFileSync(globalPath, UTF8))
    : []
  return { globalRules, globalPath }
}

function splitRulesByGlobal(workspaceRoot, extractedPatches, options = {}) {
  const seedFromGlobal = options.seedFromGlobal === true
  const { globalRules, globalPath } = readGlobalCodeStyleRules(workspaceRoot)
  const globalKey = new Set(
    globalRules.map((r) => `${normalizeCodingPatchSection(r.section)}::${normalizeCodingPatchContent(r.content)}`),
  )
  const existingInGlobal = []
  const requirementAdditions = []
  const requirementOverrides = []
  const normalizedExtracted = Array.isArray(extractedPatches) ? extractedPatches : []
  for (const patch of normalizedExtracted) {
    const section = normalizeCodingPatchSection(patch.section)
    const content = normalizeCodingPatchContent(patch.content)
    if (!content) continue
    const kind = normalizeCodingPatchKind(patch.kind)
    const row = { ...patch, section, content, kind }
    if (kind === PATCH_KIND_OVERRIDE) {
      requirementOverrides.push(row)
      continue
    }
    const key = `${section}::${content}`
    if (globalKey.has(key)) existingInGlobal.push(row)
    else requirementAdditions.push(row)
  }

  // 预热阶段：plan 还未产出时，需求内 code-style.md 仍应提供"可参考的全局规则"。
  if (normalizedExtracted.length === 0 && seedFromGlobal) {
    for (const rule of globalRules) {
      const seeded = {
        section: normalizeCodingPatchSection(rule.section),
        content: normalizeCodingPatchContent(rule.content),
        kind: PATCH_KIND_ADDITION,
      }
      const applies = normalizeCodingPatchApplies(rule.applies)
      if (applies) seeded.applies = applies
      existingInGlobal.push(seeded)
    }
  }
  return { existingInGlobal, requirementAdditions, requirementOverrides, globalPath }
}

function formatAppliesSuffix(applies) {
  const norm = normalizeCodingPatchApplies(applies)
  return norm ? ` (applies: ${norm.join(', ')})` : ''
}

// 渲染单行规则：`- [section] [Hard] content (applies: ...) (source: ...) (基于: ...)`
// 行格式保持与 parseGlobalCodeStyleRules 完全兼容，以便合并时可反解析
function renderRuleLine(rule, options = {}) {
  const section = normalizeCodingPatchSection(rule.section)
  const content = normalizeCodingPatchContent(rule.content)
  const strength = normalizeCodingPatchStrength(rule.strength)
  const strengthTag = strength ? `[${strength === STRENGTH_HARD ? 'Hard' : 'Soft'}] ` : ''
  const applies = formatAppliesSuffix(rule.applies)
  const parts = [`- [${section}] ${strengthTag}${content}${applies}`]
  // source 来源策略：优先用规则自身字段；defaultSource 仅在 includeDefaultSource=true 时兜底
  // 这样可避免把 requirementId 误贴到 "Reused From Global" 段
  const ownSource = String((rule && rule.sourceRequirementId) || '').trim()
  const defaultSource = options.includeDefaultSource === true
    ? String(options.defaultSource || '').trim()
    : ''
  const source = ownSource || defaultSource
  if (source && options.includeSource !== false) parts[0] += ` (source: ${source})`
  const basedOn = normalizeCodingPatchBasedOn(rule.basedOn)
  if (basedOn) parts[0] += ` (基于: ${basedOn})`
  return parts[0]
}

// 按 applies 分组输出主视图；无 applies 归到 `*` 桶
function renderRulesByScope(rules, options = {}) {
  const scopeMap = new Map()
  const globalBucket = []
  for (const rule of rules) {
    const applies = Array.isArray(rule.applies) ? rule.applies.filter(Boolean) : []
    if (applies.length === 0) {
      globalBucket.push(rule)
      continue
    }
    for (const g of applies) {
      if (!scopeMap.has(g)) scopeMap.set(g, [])
      scopeMap.get(g).push(rule)
    }
  }
  const lines = []
  const scopes = Array.from(scopeMap.keys()).sort((a, b) => a.localeCompare(b))
  for (const scope of scopes) {
    lines.push(`### \`${scope}\``)
    for (const rule of scopeMap.get(scope)) {
      lines.push(renderRuleLine(rule, options))
    }
    lines.push('')
  }
  if (globalBucket.length > 0) {
    lines.push('### `*` (全局 / 无 applies)')
    for (const rule of globalBucket) {
      lines.push(renderRuleLine(rule, options))
    }
    lines.push('')
  }
  if (scopes.length === 0 && globalBucket.length === 0) {
    lines.push('- (none)', '')
  }
  return lines.join('\n').replace(/\n+$/, '\n')
}

function renderRequirementCodeStyleMarkdown(payload) {
  const requirementId = String(payload.requirementId || '').trim()
  const existingInGlobal = Array.isArray(payload.existingInGlobal) ? payload.existingInGlobal : []
  const requirementAdditions = Array.isArray(payload.requirementAdditions) ? payload.requirementAdditions : []
  const requirementOverrides = Array.isArray(payload.requirementOverrides) ? payload.requirementOverrides : []
  const lines = [
    '# Requirement Code Style',
    '',
    `- Requirement: ${requirementId || '(unknown)'}`,
    `- Generated At: ${new Date().toISOString()}`,
    '',
    '> 主视图 **Rules by Scope** 按 `applies` 分组，方便 agent 按文件路径定位相关规则；',
    '> 次视图 **Rules by Section** 按分类（reused / additions / overrides）陈列，供人读与归档审计。',
    '',
  ]

  // ── 主视图：Rules by Scope（三类合并后按 globs 分组）──
  // reused 不带 source（来自全局，非本次需求产出）；additions/overrides 保留自身 source
  const allForScope = [
    ...existingInGlobal.map((r) => ({ ...r, sourceRequirementId: undefined, _bucket: 'reused' })),
    ...requirementAdditions.map((r) => ({ ...r, _bucket: 'addition' })),
    ...requirementOverrides.map((r) => ({ ...r, _bucket: 'override' })),
  ]
  lines.push('## Rules by Scope', '')
  lines.push(renderRulesByScope(allForScope))

  // ── 次视图：Rules by Section（保留原三段结构，供人读与归档）──
  lines.push('## Rules by Section', '')
  lines.push('### Reused From Global')
  if (existingInGlobal.length === 0) {
    lines.push('- (none)')
  } else {
    for (const rule of existingInGlobal) {
      lines.push(renderRuleLine(rule, { includeSource: false }))
    }
  }
  lines.push('', '### Requirement Additions (to merge on archive)')
  if (requirementAdditions.length === 0) {
    lines.push('- (none)')
  } else {
    for (const rule of requirementAdditions) {
      lines.push(renderRuleLine(rule, { defaultSource: requirementId }))
    }
  }
  lines.push('', '### Requirement Overrides (requirement-scope only; not merged to global)')
  if (requirementOverrides.length === 0) {
    lines.push('- (none)')
  } else {
    for (const rule of requirementOverrides) {
      lines.push(renderRuleLine(rule, { includeSource: false }))
    }
  }
  lines.push('')
  return lines.join('\n')
}

function writeRequirementCodeStyleArtifacts(workspaceRoot, requirementId, planContent, options = {}) {
  const reqId = String(requirementId || '').trim()
  if (!reqId) return { generated: false, error: 'missing requirementId' }
  const reqDir = path.join(workspaceRoot, 'ai-docs', reqId)
  const reqTempDir = path.join(reqDir, '.temp')
  const reqMdPath = path.join(reqDir, 'code-style.md')
  const reqPatchPath = path.join(reqTempDir, 'coding-standard-patch.json')
  const sourceRequirementId = reqId

  const extracted = extractCodingStandardPatchesFromPlan(planContent)
  const split = splitRulesByGlobal(workspaceRoot, extracted, { seedFromGlobal: options.seedFromGlobal === true })
  const existingPatch = options.mergePatch ? safeReadJson(reqPatchPath, []) : []
  // additions 与 overrides 一起合入 patch（kind 区分；归档侧仅回灌 additions）
  const mergedPatch = mergeCodingPatches(
    existingPatch,
    [...split.requirementAdditions, ...split.requirementOverrides],
    { sourceRequirementId },
  )
  const mergedAdditions = mergedPatch.filter((p) => normalizeCodingPatchKind(p.kind) === PATCH_KIND_ADDITION)
  const mergedOverrides = mergedPatch.filter((p) => normalizeCodingPatchKind(p.kind) === PATCH_KIND_OVERRIDE)

  fs.mkdirSync(reqDir, { recursive: true })
  fs.mkdirSync(reqTempDir, { recursive: true })
  fs.writeFileSync(reqPatchPath, JSON.stringify(mergedPatch, null, 2), UTF8)
  fs.writeFileSync(
    reqMdPath,
    renderRequirementCodeStyleMarkdown({
      requirementId: reqId,
      existingInGlobal: split.existingInGlobal,
      requirementAdditions: mergedAdditions,
      requirementOverrides: mergedOverrides,
    }),
    UTF8,
  )

  return {
    generated: true,
    requirementCodeStylePath: reqMdPath,
    patchPath: reqPatchPath,
    extractedCount: extracted.length,
    reusedFromGlobalCount: split.existingInGlobal.length,
    additionsCount: mergedAdditions.length,
    overridesCount: mergedOverrides.length,
    newAdditionsCount: mergedAdditions.length - (Array.isArray(existingPatch) ? existingPatch.length : 0),
    globalCodeStylePath: split.globalPath,
  }
}

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, UTF8))
  } catch {
    return fallback
  }
}

module.exports = {
  PATCH_KIND_ADDITION,
  PATCH_KIND_OVERRIDE,
  STRENGTH_HARD,
  STRENGTH_SOFT,
  normalizeCodingPatchSection,
  normalizeCodingPatchContent,
  normalizeCodingPatchKind,
  normalizeCodingPatchBasedOn,
  normalizeCodingPatchApplies,
  normalizeCodingPatchStrength,
  stripStrengthPrefix,
  normalizeContentForDedup,
  stripAppliesSuffix,
  extractCodingStandardPatchesFromPlan,
  mergeCodingPatches,
  readGlobalCodeStyleRules,
  parseGlobalCodeStyleRules,
  splitRulesByGlobal,
  globToRegExp,
  matchRulesForPaths,
  extractTaskFilePaths,
  renderRuleLine,
  renderRulesByScope,
  renderRequirementCodeStyleMarkdown,
  writeRequirementCodeStyleArtifacts,
}
