/**
 * Merge Global Assets
 *
 * 用途：把 `ai-docs/<reqId>/.temp/*-patch.json` 合并到 `ai-docs/global-assets/*`：
 * - knowledge-patch.json -> domains/<domain>.md + metadata.json
 * - coding-standard-patch.json -> standards/code-style.md
 *
 * 用法：
 *   统一: PLUGIN_ROOT=/path/to/specflow node "$PLUGIN_ROOT/tools/merge-global-assets.cjs" [workspaceRoot] <reqId>
 *
 * 输出：JSON 到 stdout
 */

const fs = require('fs')
const path = require('path')
const {
  normalizeCodingPatchSection,
  normalizeCodingPatchContent,
  normalizeCodingPatchStrength,
  normalizeSourceRequirementIds,
  deriveCodeStyleConfidence,
  stripStrengthPrefix,
  normalizeContentForDedup,
  parseGlobalCodeStyleRules,
  stripAppliesSuffix,
  renderRuleLine,
  renderRulesByScope,
  filterCodingPatchesForCodeStyle,
  STRENGTH_HARD,
} = require('./code-style.cjs')

const {
  normalizeKnowledgeCategory,
  shouldReflowToGlobal,
  mergePatchesIntoDomainMd,
  deriveConfidenceStatus,
} = require('./domain-knowledge.cjs')
const { normalizeDomainInitRef, domainRefToFileStem } = require('./specflow-state.cjs')
const { gatePassed } = require('./gates.cjs')

const UTF8 = 'utf-8'

function parseCodeStyleMap(content) {
  const out = new Map()
  const parsed = parseGlobalCodeStyleRules(content)
  for (const item of parsed) {
    const section = normalizeCodingPatchSection(item.section)
    const rule = normalizeCodingPatchContent(item.content)
    if (!rule) continue
    const key = `${section}::${normalizeContentForDedup(rule)}`
    const row = { section, content: rule, sourceRequirementId: null }
    const sourceRequirementIds = normalizeSourceRequirementIds(item.sourceRequirementIds)
    if (sourceRequirementIds.length > 0) {
      row.sourceRequirementIds = sourceRequirementIds
      const ladder = deriveCodeStyleConfidence(sourceRequirementIds)
      row.status = ladder.status
      row.confidence = ladder.confidence
    }
    if (Array.isArray(item.applies) && item.applies.length > 0) row.applies = item.applies
    const strength = normalizeCodingPatchStrength(item.strength)
    if (strength) row.strength = strength
    out.set(key, row)
  }

  // 兼容带来源行：- [section] content [可选 (applies: ...)] (source: req-id)
  const lines = String(content || '')
    .split('\n')
    .map((l) => l.trim())
  for (const line of lines) {
    const m = line.match(/^- \[([^\]]+)\]\s+(.+?)\s+\(source:\s*([^)]+)\)$/)
    if (!m) continue
    const sectionRaw = m[1]
    if (/^(hard|soft|codestyle|codingstyle|代码规范)$/i.test(sectionRaw.trim())) continue
    const section = normalizeCodingPatchSection(sectionRaw)
    const sourceRequirementId = String(m[3] || '').trim() || null
    const stripped = stripAppliesSuffix(m[2])
    const strengthSplit = stripStrengthPrefix(stripped.content)
    const rule = normalizeCodingPatchContent(strengthSplit.content)
    if (!rule) continue
    const key = `${section}::${normalizeContentForDedup(rule)}`
    const row = { section, content: rule, sourceRequirementId }
    const sourceRequirementIds = normalizeSourceRequirementIds(
      stripped.sourceRequirementIds && stripped.sourceRequirementIds.length > 0
        ? stripped.sourceRequirementIds
        : sourceRequirementId,
    )
    if (sourceRequirementIds.length > 0) {
      row.sourceRequirementIds = sourceRequirementIds
      const ladder = deriveCodeStyleConfidence(sourceRequirementIds)
      row.status = ladder.status
      row.confidence = ladder.confidence
    }
    if (Array.isArray(stripped.applies) && stripped.applies.length > 0) row.applies = stripped.applies
    if (strengthSplit.strength) row.strength = strengthSplit.strength
    // 与前一路径合并：取最强 strength + applies 并集
    const prev = out.get(key)
    if (prev) {
      if (prev.strength === STRENGTH_HARD || row.strength === STRENGTH_HARD) {
        row.strength = STRENGTH_HARD
      } else if (!row.strength && prev.strength) {
        row.strength = prev.strength
      }
      const appMerged = Array.from(new Set([...(prev.applies || []), ...(row.applies || [])]))
      if (appMerged.length > 0) row.applies = appMerged
      if (!row.sourceRequirementId && prev.sourceRequirementId) {
        row.sourceRequirementId = prev.sourceRequirementId
      }
      const sourceMerged = normalizeSourceRequirementIds([
        ...(prev.sourceRequirementIds || []),
        ...(row.sourceRequirementIds || []),
      ])
      if (sourceMerged.length > 0) {
        row.sourceRequirementIds = sourceMerged
        const ladder = deriveCodeStyleConfidence(sourceMerged)
        row.status = ladder.status
        row.confidence = ladder.confidence
      }
    }
    out.set(key, row)
  }
  return out
}

// 全局 code-style.md 渲染：顶部 Rules by Scope（agent 主视图）+ 底部 Rules by Section（人读目录）
function renderCodeStyleFromMap(ruleMap) {
  const rows = Array.from(ruleMap.values()).sort((a, b) => {
    if (a.section === b.section) return a.content.localeCompare(b.content)
    return a.section.localeCompare(b.section)
  })
  const lines = [
    '# Code Style',
    '',
    '> 主视图 **Rules by Scope** 按 `applies` 分组；子代理按当前任务文件路径定位相关规则。',
    '> 次视图 **Rules by Section** 按分类铺陈，供人读与审计。',
    '',
    '## Rules by Scope',
    '',
  ]
  lines.push(renderRulesByScope(rows, { includeSources: true, includeSource: false }))
  lines.push('## Rules by Section', '')
  // 按 section 分组输出
  const bySection = new Map()
  for (const row of rows) {
    const s = row.section
    if (!bySection.has(s)) bySection.set(s, [])
    bySection.get(s).push(row)
  }
  const sections = Array.from(bySection.keys()).sort()
  for (const s of sections) {
    lines.push(`### \`${s}\``)
    for (const row of bySection.get(s)) {
      lines.push(renderRuleLine(row, { includeSources: true, includeSource: false }))
    }
    lines.push('')
  }
  if (sections.length === 0) lines.push('- (none)', '')
  return lines.join('\n')
}

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, UTF8))
  } catch {
    return fallback
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function normalizeDomainName(raw) {
  const ref = normalizeDomainInitRef(raw)
  return domainRefToFileStem(ref)
}

function canMergeAtCurrentStage(workspaceRoot, requirementId, options = {}) {
  if (options.allowPreArchive === true) return { ok: true }
  const reqDir = path.join(workspaceRoot, 'ai-docs', requirementId)
  if (gatePassed(reqDir, 'archive.user_anchor')) return { ok: true }
  const statePath = path.join(workspaceRoot, 'ai-docs', requirementId, '.temp', 'specflow-state.json')
  const state = safeReadJson(statePath, {})
  if (state && state.archiveAnchorDone === true) {
    return {
      ok: false,
      error:
        '归档确认仍停留在旧 state 字段，禁止提前执行全局合并。请先通过归档确认门禁后再由 archive 流程统一合并。',
    }
  }
  return {
    ok: false,
    error:
      '归档尚未确认，禁止提前执行全局合并。请先完成确认归档，再由 archive 流程统一合并（如需手动调试可追加 --allow-prearchive）。',
  }
}

function mergeKnowledgeIntoGlobalAssets(workspaceRoot, requirementId, options = {}) {
  const gate = canMergeAtCurrentStage(workspaceRoot, requirementId, options)
  if (!gate.ok) return gate

  const aiDocs = path.join(workspaceRoot, 'ai-docs')
  const reqDir = path.join(aiDocs, requirementId)
  const tempDir = path.join(reqDir, '.temp')
  const knowledgePatches = safeReadJson(path.join(tempDir, 'knowledge-patch.json'), [])
  const codingPatches = safeReadJson(path.join(tempDir, 'coding-standard-patch.json'), [])

  const globalAssetsDir = path.join(aiDocs, 'global-assets')
  const domainsDir = path.join(globalAssetsDir, 'domains')
  const standardsDir = path.join(globalAssetsDir, 'standards')
  const metadataPath = path.join(globalAssetsDir, 'metadata.json')
  const codeStylePath = path.join(standardsDir, 'code-style.md')

  ensureDir(domainsDir)
  ensureDir(standardsDir)

  const metadata = safeReadJson(metadataPath, {})
  const mergedDomains = new Set()
  let totalDroppedUi = 0

  // 按 domain 分组后一次性合并（domain-knowledge 模块负责分桶/去重/阶梯）
  const patchesByDomain = new Map()
  for (const patch of Array.isArray(knowledgePatches) ? knowledgePatches : []) {
    const ref = normalizeDomainInitRef(patch.domain || patch.domainRef || patch.slug || patch.module || '')
    const domain = normalizeDomainName(ref)
    if (!ref || !domain) continue
    if (!patchesByDomain.has(domain)) patchesByDomain.set(domain, { ref, patches: [] })
    patchesByDomain.get(domain).patches.push({ ...patch, domain: ref })
  }

  for (const [domain, grouped] of patchesByDomain.entries()) {
    const { ref, patches } = grouped
    const domainPath = path.join(domainsDir, `${domain}.md`)
    const prevText = fs.existsSync(domainPath) ? fs.readFileSync(domainPath, UTF8) : `# ${ref}\n\n`
    const result = mergePatchesIntoDomainMd(prevText, ref, patches, { requirementId: String(requirementId || '') })
    totalDroppedUi += result.droppedUiCount || 0

    // 若本轮没有任何可回流条目（全是 ui / 空），跳过写盘（保持原样）
    if (result.mergedCount === 0) continue

    fs.writeFileSync(domainPath, result.md, UTF8)
    mergedDomains.add(domain)

    const fm = result.frontmatter || {}
    const sourceIds = Array.isArray(fm.sourceRequirementIds) ? fm.sourceRequirementIds.slice() : []
    const ladder = result.confidenceLadder || { status: 'Draft', confidence: 0.3 }
    // metadata 作为"派生视图"：字段全部可由 sourceRequirementIds 推出；
    // 保留目的是让 CLI / 外部工具不必 parse md 即可读状态。
    metadata[domain] = {
      domain: ref,
      domainKey: domain,
      maintainer: 'specflow-knowledge-reviewer',
      sourceRequirementIds: sourceIds,
      status: ladder.status,
      confidence: ladder.confidence,
      last_requirement: sourceIds.length > 0 ? sourceIds[sourceIds.length - 1] : null,
      updatedAt: new Date().toISOString(),
    }
  }

  const codingFilter = filterCodingPatchesForCodeStyle(workspaceRoot, codingPatches)
  const acceptedCodingPatches = codingFilter.accepted
  if (acceptedCodingPatches.length > 0) {
    const prevStyle = fs.existsSync(codeStylePath) ? fs.readFileSync(codeStylePath, UTF8) : '# Code Style\n\n'
    const styleMap = parseCodeStyleMap(prevStyle)
    for (const patch of acceptedCodingPatches) {
      // Overrides 默认仅本需求生效，不回灌全局；如需提升为全局规则，应人工编辑 standards/code-style.md。
      const kind = String((patch && patch.kind) || 'addition').trim().toLowerCase()
      if (kind === 'override') continue
      const section = normalizeCodingPatchSection(patch.section)
      const rawContent = normalizeCodingPatchContent(patch.content)
      if (!rawContent) continue
      // 兼容 content 前缀 / 独立 strength 字段
      const stripped = stripStrengthPrefix(rawContent)
      const content = stripped.content
      const strength =
        stripped.strength || normalizeCodingPatchStrength(patch.strength) || undefined
      const key = `${section}::${normalizeContentForDedup(content)}`
      const row = {
        section,
        content,
        sourceRequirementId:
          String(patch.sourceRequirementId || '').trim() || String(requirementId || '').trim() || null,
      }
      const incomingApplies = Array.isArray(patch.applies) ? patch.applies.filter(Boolean) : null
      const prev = styleMap.get(key)
      const sourceRequirementIds = normalizeSourceRequirementIds([
        ...((prev && prev.sourceRequirementIds) || []),
        ...normalizeSourceRequirementIds(patch.sourceRequirementIds),
        row.sourceRequirementId,
      ])
      if (sourceRequirementIds.length > 0) {
        row.sourceRequirementIds = sourceRequirementIds
        const ladder = deriveCodeStyleConfidence(sourceRequirementIds)
        row.status = ladder.status
        row.confidence = ladder.confidence
      }
      const merged = new Set([
        ...((prev && Array.isArray(prev.applies)) ? prev.applies : []),
        ...((incomingApplies || [])),
      ])
      if (merged.size > 0) row.applies = Array.from(merged)
      // strength 合并：任一 hard 则 hard
      if (prev && prev.strength === STRENGTH_HARD) row.strength = STRENGTH_HARD
      else if (strength === STRENGTH_HARD) row.strength = STRENGTH_HARD
      else if (prev && prev.strength) row.strength = prev.strength
      else if (strength) row.strength = strength
      styleMap.set(key, row)
    }
    fs.writeFileSync(codeStylePath, renderCodeStyleFromMap(styleMap), UTF8)
  }

  // 合并完成后不保留补丁历史目录，避免持续膨胀
  fs.rmSync(path.join(globalAssetsDir, 'patches'), { recursive: true, force: true })

  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), UTF8)

  return {
    ok: true,
    mergedDomains: Array.from(mergedDomains),
    droppedUiCount: totalDroppedUi,
    droppedCodeStyleCount: codingFilter.rejected.length,
  }
}

function main() {
  const { parseCliArgs, resolveWorkspace, resolveRequirementId } = require('./cli-args.cjs')
  const { named, boolFlags, positional } = parseCliArgs(process.argv.slice(2))
  const workspaceRoot = resolveWorkspace(named, positional, 0)
  const requirementId = resolveRequirementId(named, positional, 1)
  const allowPreArchive = boolFlags.has('allow-prearchive') || boolFlags.has('allowPreArchive')
  if (!requirementId) {
    console.log(JSON.stringify({ ok: false, error: '缺少参数: 需求号' }))
    process.exit(1)
  }
  const out = mergeKnowledgeIntoGlobalAssets(path.resolve(workspaceRoot), String(requirementId), {
    allowPreArchive,
  })
  console.log(JSON.stringify(out, null, 2))
  if (out.ok !== true) process.exit(1)
}

if (require.main === module) {
  main()
}

module.exports = { mergeKnowledgeIntoGlobalAssets }
