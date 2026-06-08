/**
 * Inventory Scanner (Cold Start) — 原语化版
 *
 * 设计边界（硬红线）：
 * - 本脚本**不**承担"领域名称生成 / 领域识别"职责：不扫目录、不猜名字、不依赖
 *   任何项目结构假设（如 `src/services`）。领域的识别、命名与证据收集由
 *   specflow-domain-explorer（Recommend/Explore 模式）在独立 agent 轮次完成。
 * - 本脚本只提供两类**幂等 IO 原语**：
 *     1. init          建 `ai-docs/global-assets/` 空壳目录 + 空 index.md / 空
 *                      metadata.json / 默认 code-style.md（存在则不覆盖）。
 *     2. add-domain    根据 agent 显式传入的 `--ref <scope>::<slug> --source <hint>`
 *                      幂等写入 `domains/<scope__slug>.md` + index.md 行 + metadata 条目。
 *
 * 用法：
 *   init（空壳）:
 *     PLUGIN_ROOT=/path/to/specflow \
 *       node "$PLUGIN_ROOT/tools/inventory-scan.cjs" \
 *       --workspace <workspaceRoot>
 *
 *   add-domain（由 agent 调用）:
 *     PLUGIN_ROOT=/path/to/specflow \
 *       node "$PLUGIN_ROOT/tools/inventory-scan.cjs" \
 *       add-domain --workspace <ws> --ref <scope>::<slug> --source "<evidence-path-or-hint>"
 *
 * 输出：JSON 到 stdout
 */

const fs = require('fs')
const path = require('path')
const { normalizeDomainInitRef, domainRefToFileStem } = require('./specflow-state.cjs')

const UTF8 = 'utf-8'

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function safeReadText(filePath, fallback) {
  try {
    return fs.readFileSync(filePath, UTF8)
  } catch {
    return fallback
  }
}

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, UTF8))
  } catch {
    return fallback
  }
}

function renderTemplate(templateText, vars) {
  let out = String(templateText || '')
  for (const [k, v] of Object.entries(vars || {})) {
    out = out.split(`{{${k}}}`).join(String(v))
  }
  return out
}

function loadArchitectureLayersTemplate() {
  const templatePath = path.join(__dirname, '..', 'templates', 'architecture-layers.md')
  return safeReadText(
    templatePath,
    [
      '# Architecture Layers',
      '',
      '> 项目架构分层画像。`code-style.md` 中的规则只能引用本文件 `## Layers` 下已存在的 layer id。',
      '',
      '## Layers',
      '',
      '<!-- specflow:section Layers -->',
      '',
      '_（待 agent 校准填充）_',
      '',
    ].join('\n'),
  )
}

function shouldRepairArchitectureLayers(content) {
  const text = String(content || '')
  if (!text.trim()) return true
  return !/^##\s+Layers\s*$/m.test(text)
}

// slug 字符规范化工具（非策略）：仅做小写化 + 非 [a-z0-9-] 替换 + 去头尾连字符
// agent 在 Recommend 时已经产出了语义明确的候选 slug；本函数只是防御性兜底。
function normalizeDomainName(raw) {
  return (
    String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\-]/g, '-')
      .replace(/\-+/g, '-')
      .replace(/^\-|\-$/g, '') || ''
  )
}

let DOMAIN_TEMPLATE_CACHE = null
function loadDomainTemplate() {
  if (DOMAIN_TEMPLATE_CACHE != null) return DOMAIN_TEMPLATE_CACHE
  const p = path.join(__dirname, '..', 'templates', 'business-domain.md')
  const txt = safeReadText(p, '')
  DOMAIN_TEMPLATE_CACHE = txt
  return txt
}

function buildDomainSkeleton(domain, sourceHint) {
  const d = String(domain || '').trim() || 'unnamed'
  const src = String(sourceHint || '').trim()

  const tpl = loadDomainTemplate()
  if (tpl) {
    const body = renderTemplate(tpl, { domain: d, source: src || 'unknown' })
      .replace(/^# Domain:\s*\[scope::slug\]\s*$/m, `# Domain: ${d}`)
      .replace(/\[需求号或 PRD 章节\]/g, src || 'unknown')
      .replace(/\[owner 或 TBD\]/g, 'inventory-scanner')
    if (body) {
      return `---\n` +
        `domain: ${d}\n` +
        `maintainer: inventory-scanner\n` +
        `sourceRequirementIds: []\n` +
        `---\n` +
        `\n` +
        `> **status**: Draft · **confidence**: 0.3 · **observations**: 0 · **last_requirement**: null\n` +
        `> _（以上字段由 \`sourceRequirementIds\` 现算生成，请勿手改；如需回溯修改请直接编辑数组）_\n` +
        `\n` +
        `${body.trim()}\n`
    }
  }

  return `---\n` +
    `domain: ${d}\n` +
    `maintainer: inventory-scanner\n` +
    `sourceRequirementIds: []\n` +
    `---\n` +
    `\n` +
    `> **status**: Draft · **confidence**: 0.3 · **observations**: 0 · **last_requirement**: null\n` +
    `> _（以上字段由 \`sourceRequirementIds\` 现算生成，请勿手改；如需回溯修改请直接编辑数组）_\n` +
    `\n` +
    `## 概览\n` +
    `- Source: ${src || 'unknown'}\n` +
    `- 说明: 冷启动骨架，待需求归档补全并晋升 Verified\n` +
    `\n` +
    `## 核心实体定义（SSOT）\n` +
    `| 字段 | 类型 | 含义 |\n` +
    `| --- | --- | --- |\n` +
    `| id | string | 标识 |\n` +
    `\n` +
    `## 状态机（Mermaid）\n` +
    `\`\`\`mermaid\n` +
    `stateDiagram-v2\n` +
    `  [*] --> Init\n` +
    `  Init --> [*]\n` +
    `\`\`\`\n` +
    `\n` +
    `## 逻辑规则索引（可选）\n` +
    `- Rule-0001: TBD\n`
}

const EMPTY_INDEX_LINES = [
  '# Domain Index',
  '',
  '| Domain | Status | Source |',
  '| --- | --- | --- |',
  '',
]

function ensureIndexSkeleton(indexPath) {
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, EMPTY_INDEX_LINES.join('\n'), UTF8)
    return { created: true }
  }
  return { created: false }
}

function appendIndexRowIfMissing(indexPath, slug, source) {
  const prev = safeReadText(indexPath, EMPTY_INDEX_LINES.join('\n'))
  const needle = `| ${slug} |`
  if (prev.split('\n').some((l) => l.trim().startsWith(needle))) {
    return { appended: false }
  }
  const trimmed = prev.replace(/\s+$/, '')
  const next = `${trimmed}\n| ${slug} | Draft | ${source || 'unknown'} |\n`
  fs.writeFileSync(indexPath, next, UTF8)
  return { appended: true }
}

function runInventoryScan(workspaceRoot) {
  const globalAssetsDir = path.join(workspaceRoot, 'ai-docs', 'global-assets')
  const domainsDir = path.join(globalAssetsDir, 'domains')
  const standardsDir = path.join(globalAssetsDir, 'standards')
  const metadataPath = path.join(globalAssetsDir, 'metadata.json')
  const indexPath = path.join(domainsDir, 'index.md')
  const codeStylePath = path.join(standardsDir, 'code-style.md')
  const architectureLayersPath = path.join(standardsDir, 'architecture-layers.md')

  ensureDir(domainsDir)
  ensureDir(standardsDir)

  if (!fs.existsSync(codeStylePath)) {
    const templatePath = path.join(__dirname, '..', 'templates', 'code-style.md')
    const templateText = safeReadText(templatePath, '# Code Style & Architecture\n\n')
    fs.writeFileSync(codeStylePath, templateText, UTF8)
  }
  const architectureLayersContent = fs.existsSync(architectureLayersPath)
    ? safeReadText(architectureLayersPath, '')
    : ''
  if (!fs.existsSync(architectureLayersPath) || shouldRepairArchitectureLayers(architectureLayersContent)) {
    fs.writeFileSync(architectureLayersPath, loadArchitectureLayersTemplate(), UTF8)
  }

  ensureIndexSkeleton(indexPath)

  if (!fs.existsSync(metadataPath)) {
    fs.writeFileSync(metadataPath, JSON.stringify({}, null, 2), UTF8)
  }

  return {
    ok: true,
    globalAssetsDir: path.relative(workspaceRoot, globalAssetsDir),
    domainsDir: path.relative(workspaceRoot, domainsDir),
    indexPath: path.relative(workspaceRoot, indexPath),
    codeStylePath: path.relative(workspaceRoot, codeStylePath),
    architectureLayersPath: path.relative(workspaceRoot, architectureLayersPath),
    metadataPath: path.relative(workspaceRoot, metadataPath),
  }
}

function runAddDomain({ workspaceRoot, name, source }) {
  const ref = normalizeDomainInitRef(name)
  const stem = domainRefToFileStem(ref)
  if (!ref || !stem) {
    return { ok: false, error: '缺少或无效的 --ref <scope>::<slug>' }
  }
  const src = String(source || '').trim()

  const globalAssetsDir = path.join(workspaceRoot, 'ai-docs', 'global-assets')
  const domainsDir = path.join(globalAssetsDir, 'domains')
  const metadataPath = path.join(globalAssetsDir, 'metadata.json')
  const indexPath = path.join(domainsDir, 'index.md')

  ensureDir(domainsDir)
  ensureIndexSkeleton(indexPath)

  const domainPath = path.join(domainsDir, `${stem}.md`)
  let created = false
  if (!fs.existsSync(domainPath)) {
    fs.writeFileSync(domainPath, buildDomainSkeleton(ref, src), UTF8)
    created = true
  }

  const indexResult = appendIndexRowIfMissing(indexPath, stem, src)

  const metadata = safeReadJson(metadataPath, {})
  let metadataUpdated = false
  if (!metadata[stem]) {
    metadata[stem] = {
      domain: ref,
      maintainer: 'inventory-scanner',
      sourceRequirementIds: [],
      status: 'Draft',
      confidence: 0.3,
      last_requirement: null,
      source: src || null,
    }
    metadataUpdated = true
  }
  if (metadataUpdated) {
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), UTF8)
  }

  return {
    ok: true,
    domain: ref,
    domainKey: stem,
    source: src || null,
    created,
    indexAppended: indexResult.appended,
    metadataUpdated,
    domainPath: path.relative(workspaceRoot, domainPath),
  }
}

function main() {
  const { parseCliArgs, resolveWorkspace } = require('./cli-args.cjs')
  const argv = process.argv.slice(2)

  const subcommands = new Set(['init', 'add-domain'])
  let sub = 'init'
  let rest = argv
  if (argv.length > 0 && subcommands.has(argv[0])) {
    sub = argv[0]
    rest = argv.slice(1)
  }

  const { named, positional } = parseCliArgs(rest)
  const workspaceRoot = path.resolve(resolveWorkspace(named, positional, 0))

  if (sub === 'init') {
    const result = runInventoryScan(workspaceRoot)
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (sub === 'add-domain') {
    const name = named['ref'] || named['domain-ref'] || positional[1] || ''
    const source = named['source'] || named['s'] || positional[2] || ''
    const result = runAddDomain({ workspaceRoot, name, source })
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok) process.exit(1)
    return
  }
}

if (require.main === module) {
  main()
}

module.exports = {
  runInventoryScan,
  runAddDomain,
  normalizeDomainName,
  buildDomainSkeleton,
}
