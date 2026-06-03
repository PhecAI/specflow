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

function normalizeSourceRequirementIds(raw) {
  const arr = Array.isArray(raw)
    ? raw
    : String(raw || '')
        .split(/[,;]/)
        .map((s) => s.trim())
  const out = []
  const seen = new Set()
  for (const item of arr) {
    const v = String(item || '').trim().replace(/^["']|["']$/g, '')
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

function deriveCodeStyleConfidence(sourceRequirementIds) {
  const n = normalizeSourceRequirementIds(sourceRequirementIds).length
  if (n >= 3) return { status: 'Verified', confidence: 0.85, count: n }
  if (n >= 2) return { status: 'Consolidating', confidence: 0.6, count: n }
  return { status: 'Draft', confidence: 0.3, count: n }
}

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

function normalizeCodingPatchLayers(raw) {
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
    out.push(v.length > 120 ? v.slice(0, 120) : v)
    if (out.length >= 12) break
  }
  return out.length > 0 ? Array.from(new Set(out)) : undefined
}

function readArchitectureLayers(workspaceRoot) {
  const layersPath = path.join(
    workspaceRoot,
    'ai-docs',
    'global-assets',
    'standards',
    'architecture-layers.md',
  )
  const content = fs.existsSync(layersPath) ? fs.readFileSync(layersPath, UTF8) : ''
  return { layersPath, layers: parseArchitectureLayers(content), content }
}

function parseArchitectureLayers(content) {
  const ids = []
  const seen = new Set()
  const raw = String(content || '')
  const re = /^###\s+`?([^`\n]+?)`?\s*$/gm
  let m
  while ((m = re.exec(raw)) !== null) {
    const id = String(m[1] || '').trim()
    if (!id || id === '<layer-id>') continue
    if (/^Layer Template$/i.test(id)) continue
    if (id.includes('<') || id.includes('>')) continue
    if (!seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  return ids
}

function isArchitectureLayersCalibrated(workspaceRoot) {
  return readArchitectureLayers(workspaceRoot).layers.length > 0
}

// 从规则原文尾部循环抽取 `(layers: a, b)`、`(applies: a, b)` 与来源/置信度元数据；
// 返回 { content, layers, applies, sourceRequirementId, sourceRequirementIds }。
// 兼容两者顺序任意；其它形如 `(基于: ...)` 等已知后缀也会被剥离（不返回）。
function stripAppliesSuffix(raw) {
  let text = String(raw || '')
  let layers
  let applies
  let sourceRequirementId
  let sourceRequirementIds
  for (let i = 0; i < 8; i++) {
    const l = text.match(/\s*\(layers:\s*([^)]+)\)\s*$/i)
    if (l) {
      const v = normalizeCodingPatchLayers(l[1])
      if (v) layers = v
      text = text.slice(0, l.index)
      continue
    }
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
    const sources = text.match(/\s*\(sources:\s*([^)]+)\)\s*$/i)
    if (sources) {
      sourceRequirementIds = normalizeSourceRequirementIds(sources[1])
      text = text.slice(0, sources.index)
      continue
    }
    const status = text.match(/\s*\(status:\s*[^)]*\)\s*$/i)
    if (status) {
      text = text.slice(0, status.index)
      continue
    }
    const b = text.match(/\s*\(基于:\s*([^)]+)\)\s*$/)
    if (b) {
      text = text.slice(0, b.index)
      continue
    }
    break
  }
  return { content: text.trim(), layers, applies, sourceRequirementId, sourceRequirementIds }
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
    let layers
    let applies
    // 顺序无关地剥离尾部 `(layers: ...)`、`(applies: ...)` 与 `(基于: ...)` 后缀（可同时存在）
    for (let i = 0; i < 3; i++) {
      const layersMatch = raw.match(/\s*\(layers:\s*([^)]+)\)\s*$/i)
      if (layersMatch) {
        layers = normalizeCodingPatchLayers(layersMatch[1])
        raw = raw.slice(0, layersMatch.index).trim()
        continue
      }
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
    if (layers) item.layers = layers
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
    const layers = normalizeCodingPatchLayers(item && item.layers)
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
    if (layers) normalized.layers = layers
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
      const mergedLayers = Array.from(
        new Set([...(prev.layers || []), ...(normalized.layers || [])]),
      )
      if (mergedLayers.length > 0) normalized.layers = mergedLayers
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

function isBusinessScopedGlob(glob) {
  const text = String(glob || '').trim()
  if (!text) return false
  const normalized = text.replace(/\\/g, '/')
  const suspiciousSegments = normalized.split('/').filter(Boolean)
  return suspiciousSegments.some((seg) => {
    const s = seg.toLowerCase()
    if (/[*?{]/.test(s)) return false
    if (/^(src|packages|apps|pages|views|components|composition|composables|services|api|apis|store|stores|model|models|domain|domains|utils|shared|common|test|tests|__tests__|mock|mocks)$/.test(s)) return false
    return /[-_]/.test(s) && s.length > 10
  })
}

function looksImplementationSpecific(text) {
  const value = String(text || '')
  if (!value.trim()) return true
  if (/(本需求|当前需求|此次需求|本次需求|需求\s*\d+)/.test(value)) return true
  return false
}

function filterCodingPatchesForCodeStyle(workspaceRoot, patches) {
  const knownLayers = new Set(readArchitectureLayers(workspaceRoot).layers)
  const accepted = []
  const rejected = []
  for (const patch of Array.isArray(patches) ? patches : []) {
    const layers = normalizeCodingPatchLayers(patch && patch.layers)
    const applies = normalizeCodingPatchApplies(patch && patch.applies)
    const content = normalizeCodingPatchContent(patch && patch.content)
    const section = normalizeCodingPatchSection(patch && patch.section)
    const reasons = []

    if (!layers || layers.length === 0) {
      reasons.push('missing layers')
    } else if (knownLayers.size > 0) {
      const unknown = layers.filter((layer) => !knownLayers.has(layer))
      if (unknown.length > 0) reasons.push(`unknown layers: ${unknown.join(', ')}`)
    }
    if (looksImplementationSpecific(section) || looksImplementationSpecific(content)) {
      reasons.push('implementation-specific or business-scoped wording')
    }
    if (applies && applies.some(isBusinessScopedGlob)) {
      reasons.push('applies is scoped to a business module instead of an architecture layer')
    }

    if (reasons.length > 0) {
      rejected.push({ patch, reasons })
    } else {
      accepted.push({ ...patch, layers, applies })
    }
  }
  return { accepted, rejected, knownLayers: Array.from(knownLayers), architectureLayersEmpty: knownLayers.size === 0 }
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
        if (stripped.layers) rule.layers = stripped.layers
        if (stripped.applies) rule.applies = stripped.applies
        const sourceIds = stripped.sourceRequirementIds && stripped.sourceRequirementIds.length > 0
          ? stripped.sourceRequirementIds
          : normalizeSourceRequirementIds(stripped.sourceRequirementId)
        if (sourceIds.length > 0) {
          rule.sourceRequirementIds = sourceIds
          const ladder = deriveCodeStyleConfidence(sourceIds)
          rule.status = ladder.status
          rule.confidence = ladder.confidence
        }
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
      if (stripped.layers) rule.layers = stripped.layers
      if (stripped.applies) rule.applies = stripped.applies
      const sourceIds = stripped.sourceRequirementIds && stripped.sourceRequirementIds.length > 0
        ? stripped.sourceRequirementIds
        : normalizeSourceRequirementIds(stripped.sourceRequirementId)
      if (sourceIds.length > 0) {
        rule.sourceRequirementIds = sourceIds
        const ladder = deriveCodeStyleConfidence(sourceIds)
        rule.status = ladder.status
        rule.confidence = ladder.confidence
      }
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
      const mergedLayers = Array.from(
        new Set([...(prev.layers || []), ...(r.layers || [])]),
      )
      if (mergedLayers.length > 0) r.layers = mergedLayers
      const mergedSources = normalizeSourceRequirementIds([
        ...(prev.sourceRequirementIds || []),
        ...(r.sourceRequirementIds || []),
      ])
      if (mergedSources.length > 0) {
        r.sourceRequirementIds = mergedSources
        const ladder = deriveCodeStyleConfidence(mergedSources)
        r.status = ladder.status
        r.confidence = ladder.confidence
      }
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

function splitRulesByGlobal(workspaceRoot, extractedPatches) {
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
  return { existingInGlobal, requirementAdditions, requirementOverrides, globalPath }
}

function formatAppliesSuffix(applies) {
  const norm = normalizeCodingPatchApplies(applies)
  return norm ? ` (applies: ${norm.join(', ')})` : ''
}

function formatLayersSuffix(layers) {
  const norm = normalizeCodingPatchLayers(layers)
  return norm ? ` (layers: ${norm.join(', ')})` : ''
}

function collectUnmappedTechnicalSignals(rejectedItems) {
  const signals = []
  const seen = new Set()
  for (const item of Array.isArray(rejectedItems) ? rejectedItems : []) {
    const patch = item && item.patch ? item.patch : {}
    const reasons = Array.isArray(item && item.reasons) ? item.reasons : []
    for (const reason of reasons) {
      const unknown = String(reason || '').match(/^unknown layers:\s*(.+)$/i)
      if (unknown) {
        for (const layer of normalizeCodingPatchLayers(unknown[1]) || []) {
          if (!seen.has(layer)) {
            seen.add(layer)
            signals.push(layer)
          }
        }
      }
      if (
        /^missing layers$/i.test(String(reason || '')) ||
        /^architecture-layers is empty$/i.test(String(reason || ''))
      ) {
        const section = normalizeCodingPatchSection(patch.section)
        if (section && !seen.has(section)) {
          seen.add(section)
          signals.push(section)
        }
      }
    }
  }
  return signals
}

// 渲染单行规则：`- [section] [Hard] content (layers: ...) (applies: ...) (source: ...) (基于: ...)`
// 行格式保持与 parseGlobalCodeStyleRules 完全兼容，以便合并时可反解析
function renderRuleLine(rule, options = {}) {
  const section = normalizeCodingPatchSection(rule.section)
  const content = normalizeCodingPatchContent(rule.content)
  const strength = normalizeCodingPatchStrength(rule.strength)
  const strengthTag = strength ? `[${strength === STRENGTH_HARD ? 'Hard' : 'Soft'}] ` : ''
  const layers = formatLayersSuffix(rule.layers)
  const applies = formatAppliesSuffix(rule.applies)
  const parts = [`- [${section}] ${strengthTag}${content}${layers}${applies}`]
  // source 来源策略：优先用规则自身字段；defaultSource 仅在 includeDefaultSource=true 时兜底
  // 这样可避免把 requirementId 误贴到 "Reused From Global" 段
  const ownSource = String((rule && rule.sourceRequirementId) || '').trim()
  const defaultSource = options.includeDefaultSource === true
    ? String(options.defaultSource || '').trim()
    : ''
  const source = ownSource || defaultSource
  if (source && options.includeSource !== false) parts[0] += ` (source: ${source})`
  const sources = normalizeSourceRequirementIds(rule.sourceRequirementIds)
  if (sources.length > 0 && options.includeSources === true) {
    const ladder = deriveCodeStyleConfidence(sources)
    parts[0] += ` (sources: ${sources.join(', ')})`
    parts[0] += ` (status: ${ladder.status}, confidence: ${ladder.confidence})`
  }
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
  const requirementAdditions = Array.isArray(payload.requirementAdditions) ? payload.requirementAdditions : []
  const requirementOverrides = Array.isArray(payload.requirementOverrides) ? payload.requirementOverrides : []
  const unmappedSignals = Array.from(
    new Set((Array.isArray(payload.unmappedSignals) ? payload.unmappedSignals : [])
      .map((x) => String(x || '').trim())
      .filter(Boolean)),
  )
  const lines = [
    '# Requirement Code Style',
    '',
    `- Requirement: ${requirementId || '(unknown)'}`,
    `- Generated At: ${new Date().toISOString()}`,
    '',
    '> 本文件仅记录本需求发现的代码规范增量，用于归档时合并到全局规范；',
    '> 已存在的全局规范只在 Plan / Implement 阶段作为上下文参考，不在需求目录重复复制。',
    '',
  ]

  function pushRulesByLayer(title, rules, options) {
    lines.push(title)
    if (rules.length === 0) {
      lines.push('- (none)')
      return
    }
    const buckets = new Map()
    for (const rule of rules) {
      const layers = normalizeCodingPatchLayers(rule.layers) || ['unmapped']
      for (const layer of layers) {
        if (!buckets.has(layer)) buckets.set(layer, [])
        buckets.get(layer).push(rule)
      }
    }
    for (const layer of Array.from(buckets.keys()).sort((a, b) => a.localeCompare(b))) {
      lines.push(`### ${layer}`)
      for (const rule of buckets.get(layer)) {
        lines.push(renderRuleLine(rule, options))
      }
      lines.push('')
    }
  }

  pushRulesByLayer('## Requirement Additions (to merge on archive)', requirementAdditions, { defaultSource: requirementId })
  lines.push('')
  pushRulesByLayer(
    '## Requirement Overrides (requirement-scope only; not merged to global)',
    requirementOverrides,
    { includeSource: false },
  )
  lines.push('')
  if (unmappedSignals.length > 0) {
    lines.push(
      '<!-- specflow:layers-drift-hint -->',
      `> 本次需求发现以下技术信号无法映射到已有分层：${unmappedSignals.join('、')}。`,
      '> 若这反映了项目架构的实际变化，建议运行：',
      `> \`node "$PLUGIN_ROOT/tools/manage-state.cjs" recalibrate-layers <ws> ${requirementId || '<req-id>'}\``,
      '',
    )
  }
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
  const filtered = filterCodingPatchesForCodeStyle(workspaceRoot, extracted)
  const split = splitRulesByGlobal(workspaceRoot, filtered.accepted)
  const existingPatch = options.mergePatch ? safeReadJson(reqPatchPath, []) : []
  const existingFiltered = filterCodingPatchesForCodeStyle(workspaceRoot, existingPatch)
  const rejected = [...filtered.rejected, ...existingFiltered.rejected]
  const unmappedSignals = collectUnmappedTechnicalSignals(rejected)
  if (filtered.architectureLayersEmpty || existingFiltered.architectureLayersEmpty) {
    unmappedSignals.push('architecture-layers is empty')
  }
  // additions 与 overrides 一起合入 patch（kind 区分；归档侧仅回灌 additions）
  const mergedPatch = mergeCodingPatches(
    existingFiltered.accepted,
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
      unmappedSignals,
    }),
    UTF8,
  )

  return {
    generated: true,
    requirementCodeStylePath: reqMdPath,
    patchPath: reqPatchPath,
    extractedCount: extracted.length,
    rejectedCount: rejected.length,
    rejected,
    unmappedSignals,
    reusedFromGlobalCount: split.existingInGlobal.length,
    additionsCount: mergedAdditions.length,
    overridesCount: mergedOverrides.length,
    newAdditionsCount: mergedAdditions.length - existingFiltered.accepted.length,
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
  normalizeCodingPatchLayers,
  normalizeCodingPatchStrength,
  normalizeSourceRequirementIds,
  deriveCodeStyleConfidence,
  parseArchitectureLayers,
  readArchitectureLayers,
  isArchitectureLayersCalibrated,
  filterCodingPatchesForCodeStyle,
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
  collectUnmappedTechnicalSignals,
  renderRequirementCodeStyleMarkdown,
  writeRequirementCodeStyleArtifacts,
}
