const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const UTF8 = 'utf-8'

function normalizeCodingPatchSection(raw) {
  return String(raw || '').trim().toLowerCase() || 'general'
}

function normalizeCodingPatchContent(raw) {
  return String(raw || '').trim()
}

const PATCH_KIND_ADDITION = 'addition'
const PATCH_KIND_OVERRIDE = 'override'

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


function normalizeCodingPatchKind(raw) {
  const v = String(raw || '').trim().toLowerCase()
  return v === PATCH_KIND_OVERRIDE ? PATCH_KIND_OVERRIDE : PATCH_KIND_ADDITION
}

function normalizeCodingPatchBasedOn(raw) {
  const v = String(raw || '').trim()
  return v || undefined
}

// 向后兼容：从 content 前缀剥离历史 [Hard]/[Soft] 标记（旧文档格式），仅供 dedup 使用。
function stripStrengthPrefix(raw) {
  const text = String(raw || '')
  const m = text.match(/^\s*\[(hard|soft)\]\s*/i)
  const content = m ? text.slice(m[0].length).trim() : text.trim()
  return { content, strength: m ? m[1].toLowerCase() : undefined }
}

function contentWithoutStrength(raw) {
  return stripStrengthPrefix(raw).content
}

function normalizeCodingPatchStrength(raw) {
  const v = String(raw || '').trim().toLowerCase()
  if (v === 'hard' || v === 'soft') return v
  return undefined
}

function mergeStrength(a, b) {
  const av = normalizeCodingPatchStrength(a)
  const bv = normalizeCodingPatchStrength(b)
  if (av === 'hard' || bv === 'hard') return 'hard'
  if (av === 'soft' || bv === 'soft') return 'soft'
  return undefined
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

function extractMarkdownSection(content, heading) {
  const text = String(content || '')
  const escaped = String(heading || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^##\\s+${escaped}\\s*$`, 'mi')
  const match = text.match(re)
  if (!match || typeof match.index !== 'number') return ''
  const start = match.index + match[0].length
  const rest = text.slice(start)
  const next = rest.search(/^##\s+/m)
  return (next >= 0 ? rest.slice(0, next) : rest).trim()
}

function replaceMarkdownSection(content, heading, body) {
  const text = String(content || '')
  const escaped = String(heading || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^##\\s+${escaped}\\s*$`, 'mi')
  const match = text.match(re)
  const normalizedBody = String(body || '').replace(/^\s+|\s+$/g, '')
  const section = `## ${heading}\n\n${normalizedBody}\n`
  if (!match || typeof match.index !== 'number') {
    const prefix = text.trim() ? text.replace(/\s+$/, '') : '# Code Style & Architecture'
    return `${prefix}\n\n${section}`
  }
  const start = match.index
  const afterHeading = match.index + match[0].length
  const rest = text.slice(afterHeading)
  const next = rest.search(/^##\s+/m)
  const end = next >= 0 ? afterHeading + next : text.length
  const before = text.slice(0, start).replace(/\s+$/, '')
  const after = text.slice(end).replace(/^\s+/, '')
  return `${before}\n\n${section}${after ? `\n${after}` : ''}`
}

function stripMarkdownHtmlComments(raw) {
  return String(raw || '').replace(/<!--[\s\S]*?-->/g, '')
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
  const layerObjects = parseCodeStyleLayers(content)
  const layers = layerObjects.map((l) => l.id)
  return { layersPath, layers, layerObjects, content }
}

function parseArchitectureLayers(layersContent) {
  return parseCodeStyleLayers(String(layersContent || '')).map((l) => l.id)
}

function parseCodeStyleLayers(content) {
  const ids = []
  const objects = []
  const seen = new Set()
  const section = extractMarkdownSection(content, 'Layers')
  const raw = stripMarkdownHtmlComments(section || String(content || ''))
  const re = /^###\s+`?([^`\n]+?)`?\s*$/gm
  let m
  while ((m = re.exec(raw)) !== null) {
    const id = String(m[1] || '').trim()
    if (!id || id === '<layer-id>' || id === 'layer-id') continue
    if (/^Layer Template$/i.test(id)) continue
    if (id.includes('<') || id.includes('>')) continue
    if (seen.has(id)) continue
    seen.add(id)
    ids.push({ id, index: m.index, end: re.lastIndex })
  }
  for (let i = 0; i < ids.length; i++) {
    const cur = ids[i]
    const next = ids[i + 1]
    const body = raw.slice(cur.end, next ? next.index : raw.length)
    objects.push(parseLayerBody(cur.id, body))
  }
  return objects
}

function parseLayerBody(id, body) {
  return {
    id,
    globs: parseBulletSublist(body, 'globs'),
    role: parseBulletScalar(body, 'role'),
    should: parseBulletSublist(body, 'should'),
    should_not: parseBulletSublist(body, 'should_not'),
    evidence: parseBulletSublist(body, 'evidence'),
  }
}

function parseBulletScalar(body, key) {
  const re = new RegExp(`^-\\s+${key}:\\s*(.*)$`, 'mi')
  const m = String(body || '').match(re)
  return m ? stripBackticks(m[1]).trim() : ''
}

function parseBulletSublist(body, key) {
  const lines = String(body || '').split('\n')
  const out = []
  let inBlock = false
  for (const line of lines) {
    const keyMatch = line.match(new RegExp(`^-\\s+${key}:\\s*(.*)$`, 'i'))
    if (keyMatch) {
      inBlock = true
      const inline = stripBackticks(keyMatch[1]).trim()
      if (inline) out.push(inline)
      continue
    }
    if (inBlock) {
      const child = line.match(/^\s+-\s+(.+?)\s*$/)
      if (child) {
        out.push(stripBackticks(child[1]).trim())
        continue
      }
      if (/^-\s+\S/.test(line) || /^###\s+/.test(line)) inBlock = false
    }
  }
  return out.filter(Boolean)
}

function stripBackticks(raw) {
  return String(raw || '').replace(/^`|`$/g, '')
}

function isArchitectureLayersCalibrated(workspaceRoot) {
  return readArchitectureLayers(workspaceRoot).layers.length > 0
}

function isGlobalCodeStylePopulated(workspaceRoot) {
  const { globalRules } = readGlobalCodeStyleRules(workspaceRoot)
  if (globalRules.length > 0) return true
  const globalPath = path.join(
    workspaceRoot,
    'ai-docs',
    'global-assets',
    'standards',
    'code-style.md',
  )
  if (!fs.existsSync(globalPath)) return false
  const content = fs.readFileSync(globalPath, UTF8)
  const sops = parseCodeStyleSops(content)
  return sops.length > 0
}

function parseCodeStyleSops(content) {
  const section = stripMarkdownHtmlComments(extractMarkdownSection(content, 'SOPs'))
  if (!section) return []
  const out = []
  const heads = []
  const re = /^###\s+`?([^`\n]+?)`?\s*$/gm
  let m
  while ((m = re.exec(section)) !== null) {
    const id = String(m[1] || '').trim()
    if (!id || id === 'sop-id' || id.includes('<') || id.includes('>')) continue
    heads.push({ id, index: m.index, end: re.lastIndex })
  }
  for (let i = 0; i < heads.length; i++) {
    const cur = heads[i]
    const next = heads[i + 1]
    const body = section.slice(cur.end, next ? next.index : section.length)
    out.push({
      id: cur.id,
      applies: parseBulletSublist(body, 'applies'),
      layers: parseBulletSublist(body, 'layers').map(stripBackticks),
      pattern: parseNumberedOrBulletSublist(body, 'pattern'),
      validation: parseBulletScalar(body, 'validation'),
      reference: parseBulletSublist(body, 'reference'),
    })
  }
  return out
}

function parseNumberedOrBulletSublist(body, key) {
  const lines = String(body || '').split('\n')
  const out = []
  let inBlock = false
  for (const line of lines) {
    const keyMatch = line.match(new RegExp(`^-\\s+${key}:\\s*(.*)$`, 'i'))
    if (keyMatch) {
      inBlock = true
      const inline = stripBackticks(keyMatch[1]).trim()
      if (inline) out.push(inline)
      continue
    }
    if (inBlock) {
      const child = line.match(/^\s+(?:-\s+|\d+\.\s+)(.+?)\s*$/)
      if (child) {
        out.push(stripBackticks(child[1]).trim())
        continue
      }
      if (/^-\s+\S/.test(line) || /^###\s+/.test(line)) inBlock = false
    }
  }
  return out.filter(Boolean)
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
    // 向后兼容：剥离历史 [Hard]/[Soft] 前缀
    const strippedStrength = stripStrengthPrefix(content)
    const finalContent = strippedStrength.content
    if (!finalContent) continue
    const item = {
      section,
      content: finalContent,
      kind,
      extractedAt: new Date().toISOString(),
    }
    const strength = mergeStrength(strippedStrength.strength)
    if (strength) item.strength = strength
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

    // 向后兼容：剥离历史 [Hard]/[Soft] 前缀
    const stripped = stripStrengthPrefix(rawContent)
    const content = stripped.content
    const strength = mergeStrength(item && item.strength, stripped.strength)

    // dedup key 用归一化文本
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
    if (basedOn) normalized.basedOn = basedOn
    if (layers) normalized.layers = layers
    if (applies) normalized.applies = applies
    if (strength) normalized.strength = strength

    const prev = seen.get(dedupKey)
    if (prev) {
      // 合并策略：applies 取并集，sourceRequirementId 取最新非空
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
      const mergedStrength = mergeStrength(prev.strength, normalized.strength)
      if (mergedStrength) normalized.strength = mergedStrength
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
  // Business/domain-specific class or component names such as ShortDramaMaterial
  // indicate a rule is still tied to one implementation instead of an architecture layer.
  const backticked = value.match(/`([^`]+)`/g) || []
  for (const raw of backticked) {
    const token = raw.slice(1, -1).trim()
    if (looksBusinessNamedIdentifier(token)) return true
  }
  if (looksBusinessNamedIdentifier(value)) return true
  return false
}

function looksBusinessNamedIdentifier(text) {
  const value = String(text || '')
  const allowed = new Set([
    'Vue',
    'Pinia',
    'DTO',
    'DOM',
    'API',
    'REST',
    'GraphQL',
    'RPC',
    'SCSS',
    'BEM',
    'Element',
    'ElementPlus',
  ])
  const matches = value.match(/\b[A-Z][A-Za-z0-9]*(?:[A-Z][a-z0-9]+){2,}\b/g) || []
  return matches.some((name) => !allowed.has(name))
}

function filterCodingPatchesForCodeStyle(workspaceRoot, patches) {
  const layerInfo = readArchitectureLayers(workspaceRoot)
  const layerMap = new Map((layerInfo.layerObjects || []).map((layer) => [layer.id, layer]))
  const knownLayers = new Set(layerInfo.layers)
  const accepted = []
  const rejected = []
  for (const patch of Array.isArray(patches) ? patches : []) {
    const layers = normalizeCodingPatchLayers(patch && patch.layers)
    const applies = normalizeCodingPatchApplies(patch && patch.applies)
    const content = normalizeCodingPatchContent(patch && patch.content)
    const section = normalizeCodingPatchSection(patch && patch.section)
    const reasons = []

    if (knownLayers.size === 0) {
      reasons.push('code-style Layers section is empty')
    }
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
    let finalApplies = applies
    if (reasons.length === 0 && layers && knownLayers.size > 0) {
      const inheritedGlobs = Array.from(new Set(
        layers.flatMap((layer) => {
          const obj = layerMap.get(layer)
          return obj && Array.isArray(obj.globs) ? obj.globs : []
        }).filter(Boolean),
      ))
      if (!finalApplies || finalApplies.length === 0) {
        finalApplies = inheritedGlobs.length > 0 ? inheritedGlobs : undefined
      } else if (inheritedGlobs.length > 0) {
        const invalid = finalApplies.filter((g) => !globCoveredByAny(g, inheritedGlobs))
        if (invalid.length > 0) {
          reasons.push(`applies outside layer globs: ${invalid.join(', ')}`)
        }
      }
    }

    if (reasons.length > 0) {
      rejected.push({ patch, reasons })
    } else {
      accepted.push({ ...patch, layers, applies: finalApplies })
    }
  }
  return { accepted, rejected, knownLayers: Array.from(knownLayers), architectureLayersEmpty: knownLayers.size === 0 }
}

function globCoveredByAny(glob, layerGlobs) {
  const target = normalizeGlobForCoverage(glob)
  return layerGlobs.some((candidate) => {
    const base = normalizeGlobForCoverage(candidate)
    if (target === base) return true
    const prefix = globCoveragePrefix(base)
    return prefix && target.startsWith(prefix)
  })
}

function normalizeGlobForCoverage(glob) {
  return String(glob || '').trim().replace(/\\/g, '/').replace(/^`|`$/g, '')
}

function globCoveragePrefix(glob) {
  const s = normalizeGlobForCoverage(glob)
  const idx = s.search(/[*?{]/)
  if (idx < 0) return s.endsWith('/') ? s : path.dirname(s).replace(/\\/g, '/') + '/'
  const prefix = s.slice(0, idx)
  const slash = prefix.lastIndexOf('/')
  return slash >= 0 ? prefix.slice(0, slash + 1) : ''
}

function parseGlobalCodeStyleRules(content) {
  const rules = []
  if (!content) return rules
  rules.push(...parseStructuredCodeStyleRules(content))
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
      const strippedStrength = stripStrengthPrefix(stripped.content)
      const content = strippedStrength.content
      const rule = {
        section: normalizeCodingPatchSection(sectionRaw),
        content: normalizeCodingPatchContent(content),
      }
      if (strippedStrength.strength) rule.strength = strippedStrength.strength
        if (stripped.layers) rule.layers = stripped.layers
        if (stripped.applies) rule.applies = stripped.applies
        const sourceIds = stripped.sourceRequirementIds && stripped.sourceRequirementIds.length > 0
          ? stripped.sourceRequirementIds
          : normalizeSourceRequirementIds(stripped.sourceRequirementId)
        if (sourceIds.length > 0) {
          rule.sourceRequirementIds = sourceIds
        }
        rules.push(rule)
        continue
      }
    }
    // 兼容文档式写法：- [CodeStyle] section: content
    m = line.match(/^-\s*\[(?:CodeStyle|CodingStyle|代码规范)\]\s*([^:\]]*?)\s*:\s*(.+)$/i)
    if (m) {
      const stripped = stripAppliesSuffix(m[2])
      const strippedStrength = stripStrengthPrefix(stripped.content)
      const content = strippedStrength.content
      const rule = {
        section: normalizeCodingPatchSection(m[1]),
        content: normalizeCodingPatchContent(content),
      }
      if (strippedStrength.strength) rule.strength = strippedStrength.strength
      if (stripped.layers) rule.layers = stripped.layers
      if (stripped.applies) rule.applies = stripped.applies
      const sourceIds = stripped.sourceRequirementIds && stripped.sourceRequirementIds.length > 0
        ? stripped.sourceRequirementIds
        : normalizeSourceRequirementIds(stripped.sourceRequirementId)
      if (sourceIds.length > 0) {
        rule.sourceRequirementIds = sourceIds
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
      }
    }
    seen.set(key, r)
  }
  return Array.from(seen.values())
}

function parseStructuredCodeStyleRules(content) {
  const section = stripMarkdownHtmlComments(extractMarkdownSection(content, 'Rules by Layer'))
  if (!section) return []
  const heads = []
  const re = /^###\s+`?([^`\n]+?)`?\s*$/gm
  let m
  while ((m = re.exec(section)) !== null) {
    const id = String(m[1] || '').trim()
    if (!id || id === 'layer-id' || id.includes('<') || id.includes('>')) continue
    heads.push({ id, index: m.index, end: re.lastIndex })
  }
  const out = []
  for (let i = 0; i < heads.length; i++) {
    const cur = heads[i]
    const next = heads[i + 1]
    const body = section.slice(cur.end, next ? next.index : section.length)
    const should = parseBulletSublist(body, 'should')
    for (const line of should) {
      const rule = parseStructuredRuleLine(line, cur.id)
      if (rule) out.push(rule)
    }
  }
  return out
}

function parseStructuredRuleLine(raw, layerId) {
  let text = String(raw || '').trim()
  if (!text || text === '(none)') return null
  let section = normalizeCodingPatchSection(layerId)
  const sectionMatch = text.match(/^`?([a-zA-Z0-9_.-]+)`?\s*[:：]\s*(.+)$/)
  if (sectionMatch) {
    section = normalizeCodingPatchSection(sectionMatch[1])
    text = sectionMatch[2].trim()
  }
  const stripped = stripAppliesSuffix(text)
  const strippedStrength = stripStrengthPrefix(stripped.content)
  const content = normalizeCodingPatchContent(strippedStrength.content)
  if (!content) return null
  const rule = {
    section,
    content,
    layers: stripped.layers || [layerId],
  }
  if (strippedStrength.strength) rule.strength = strippedStrength.strength
  if (stripped.applies) rule.applies = stripped.applies
  const sourceIds = stripped.sourceRequirementIds && stripped.sourceRequirementIds.length > 0
    ? stripped.sourceRequirementIds
    : normalizeSourceRequirementIds(stripped.sourceRequirementId)
  if (sourceIds.length > 0) {
    rule.sourceRequirementIds = sourceIds
  }
  return rule
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
        /^code-style Layers section is empty$/i.test(String(reason || ''))
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


// 按 layers[0] 分组输出结构化格式，与模板 code-style.md 保持一致

function renderStructuredRulesByLayer(rules, options = {}) {
  const layerMap = new Map()
  const unmappedBucket = []
  for (const rule of rules) {
    const layers = normalizeCodingPatchLayers(rule.layers)
    if (!layers || layers.length === 0) {
      unmappedBucket.push(rule)
      continue
    }
    const primary = layers[0]
    if (!layerMap.has(primary)) layerMap.set(primary, [])
    layerMap.get(primary).push(rule)
  }
  const lines = []
  const sortedLayers = Array.from(layerMap.keys()).sort()
  for (const layer of sortedLayers) {
    lines.push(`### \`${layer}\``)
    lines.push('- should:')
    for (const rule of layerMap.get(layer)) {
      lines.push(`  - ${renderStructuredRuleLine(rule)}`)
    }
    lines.push('')
  }
  if (unmappedBucket.length > 0) {
    lines.push('### `unmapped`')
    lines.push('- should:')
    for (const rule of unmappedBucket) {
      lines.push(`  - ${renderStructuredRuleLine(rule)}`)
    }
    lines.push('')
  }
  if (sortedLayers.length === 0 && unmappedBucket.length === 0) {
    lines.push('_（暂无全局规则，由需求归档逐步填充）_', '')
  }
  return lines.join('\n').replace(/\n+$/, '\n')
}

function renderStructuredRuleLine(rule) {
  const section = normalizeCodingPatchSection(rule.section)
  const content = normalizeCodingPatchContent(rule.content)
  const strength = normalizeCodingPatchStrength(rule.strength)
  const renderedContent = strength ? `[${strength === 'hard' ? 'Hard' : 'Soft'}] ${content}` : content
  let line = `${section}: ${renderedContent}${formatAppliesSuffix(rule.applies)}`
  return line
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
    `# 代码规范（需求 ${requirementId || '(unknown)'}）`,
    '',
    '> 本文档只记录本需求发现的代码规范增量，用于归档时合并到全局 code-style.md。',
    '> 已存在的全局规范只作为上下文参考，不在需求目录重复复制。',
    '',
  ]

  function pushRulesByLayer(title, rules, options) {
    lines.push(title)
    if (rules.length === 0) {
      lines.push('_（无）_')
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
      lines.push(`### \`${layer}\``)
      lines.push('- should:')
      for (const rule of buckets.get(layer)) {
        lines.push(`  - ${renderStructuredRuleLine(rule)}`)
      }
      lines.push('')
    }
  }

  pushRulesByLayer('## Additions（本次需求新增；归档时回流全局）', requirementAdditions, { defaultSource: requirementId })
  lines.push('')
  pushRulesByLayer(
    '## Overrides（本次需求的临时覆盖；不回流全局）',
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
  const existingSplit = splitRulesByGlobal(workspaceRoot, existingFiltered.accepted)
  const rejected = [...filtered.rejected, ...existingFiltered.rejected]
  const unmappedSignals = collectUnmappedTechnicalSignals(rejected)
  if (filtered.architectureLayersEmpty || existingFiltered.architectureLayersEmpty) {
    unmappedSignals.push('code-style Layers section is empty')
  }
  // additions 与 overrides 一起合入 patch（kind 区分；归档侧仅回灌 additions）
  const mergedPatch = mergeCodingPatches(
    [...existingSplit.requirementAdditions, ...existingSplit.requirementOverrides],
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
    reusedFromGlobalCount: split.existingInGlobal.length + existingSplit.existingInGlobal.length,
    additionsCount: mergedAdditions.length,
    overridesCount: mergedOverrides.length,
    newAdditionsCount: mergedAdditions.length - existingSplit.requirementAdditions.length,
    globalCodeStylePath: split.globalPath,
  }
}

function normalizePlanForCodeStyleSync(planContent) {
  return String(planContent || '')
    .replace(
      /^(\s*-\s+)\[[\s?!x]\](\s+\*\*[^*]+\*\*)/gm,
      '$1[ ]$2',
    )
    .replace(/[ \t]+$/gm, '')
    .trim()
}

function buildCodeStyleSyncSnapshot(planContent) {
  const normalized = normalizePlanForCodeStyleSync(planContent)
  return {
    hash: crypto.createHash('sha256').update(normalized).digest('hex'),
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
  normalizeCodingPatchSection,
  normalizeCodingPatchContent,
  normalizeCodingPatchKind,
  normalizeCodingPatchBasedOn,
  normalizeCodingPatchApplies,
  normalizeCodingPatchLayers,
  normalizeCodingPatchStrength,
  normalizeSourceRequirementIds,
  parseArchitectureLayers,
  parseCodeStyleLayers,
  parseCodeStyleSops,
  extractMarkdownSection,
  replaceMarkdownSection,
  readArchitectureLayers,
  isArchitectureLayersCalibrated,
  isGlobalCodeStylePopulated,
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
  renderStructuredRulesByLayer,
  renderStructuredRuleLine,
  collectUnmappedTechnicalSignals,
  renderRequirementCodeStyleMarkdown,
  writeRequirementCodeStyleArtifacts,
  normalizePlanForCodeStyleSync,
  buildCodeStyleSyncSnapshot,
}
