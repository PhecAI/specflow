/**
 * 目录布局守卫：禁止 legacy `skills/specflow-assets/**` 回潮，强制可执行资产只在顶层 `tools/`。
 * 参考 Cursor 官方插件约定：skills/<Skill>/SKILL.md 只存纯指令，代码/协议/模板/长文档在顶层目录。
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const {
  parseMarkdownTree,
  buildFocusPlanFromTree,
  buildFocusSpecify,
  isSpecifyCompleteFromTree,
} = require(path.join(ROOT, 'tools', 'plan-parser.cjs'))

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, acc)
    else acc.push(path.relative(ROOT, p))
  }
  return acc
}

test('layout-guard: legacy skills/specflow-assets/** 不应存在', () => {
  const legacyDir = path.join(ROOT, 'skills', 'specflow-assets')
  assert.ok(!fs.existsSync(legacyDir), `legacy 目录仍存在：${legacyDir}`)
})

test('layout-guard: skills/**/SKILL.md 下不得出现 .cjs 运行时脚本', () => {
  const skillsDir = path.join(ROOT, 'skills')
  const offenders = walk(skillsDir).filter((p) => p.endsWith('.cjs'))
  assert.deepStrictEqual(
    offenders,
    [],
    `skills/ 目录只允许放 SKILL.md / 纯文档；发现 .cjs：\n${offenders.join('\n')}`,
  )
})

test('layout-guard: 顶层运行时目录齐全（tools/protocols/templates/docs）', () => {
  for (const dir of ['tools', 'protocols', 'templates', 'docs']) {
    assert.ok(fs.existsSync(path.join(ROOT, dir)), `缺失顶层目录：${dir}`)
  }
})

test('specify-template: 使用功能切片结构，不再生成独立 AC 章节', () => {
  const tpl = fs.readFileSync(path.join(ROOT, 'templates', 'specify-template.md'), 'utf8')
  assert.match(tpl, /specflow:section=capabilities/)
  assert.match(tpl, /验收要点/)
  assert.match(tpl, /\*\*\[AC-001\]\*\*/)
  assert.doesNotMatch(tpl, /默认假设|推断/)
  assert.doesNotMatch(tpl, /specflow:section=acceptance-criteria/)
  assert.doesNotMatch(tpl, /^##\s+\d+\.\s+Acceptance Criteria/m)
})

test('plan-parser: 新 Specify 结构可判定完整并进入 focusSpecify', () => {
  const md = `# Spec

## Requirement Overview
<!-- specflow:section=overview -->
- **目标**: 完成素材管理。

## Product Decisions & Boundaries
<!-- specflow:section=product-decisions -->
- **已确认产品决策**: 本期先支持 Mock 推进。

## Capabilities
<!-- specflow:section=capabilities -->
### 3.1 素材批量上传
- **用户目标**: 批量上传素材。
- **验收要点**:
  - **[AC-001]** 未选择文件时不能提交。

## Business Objects & States
<!-- specflow:section=business-objects -->
- **素材**: 创意资产。

## Decision Log
<!-- specflow:section=clarification-log -->
无额外决策记录。

## Changelog
<!-- specflow:section=changelog -->
- Initial
`
  const tree = parseMarkdownTree(md)
  assert.equal(isSpecifyCompleteFromTree(tree), true)
  const focus = buildFocusSpecify(tree)
  assert.match(focus, /Requirement Overview/)
  assert.match(focus, /Capabilities/)
  assert.match(focus, /素材批量上传/)
  assert.match(focus, /Acceptance Criteria Index/)
  assert.match(focus, /AC-001/)
  assert.doesNotMatch(focus, /Decision Log/)
})

test('plan-parser: 旧 Specify 结构不再判完整，也不生成 focusSpecify', () => {
  const md = `# Spec

## Executive Summary
<!-- specflow:section=executive-summary -->
Legacy summary.

## User Roles & Scenarios
<!-- specflow:section=user-scenarios -->
- User does a thing.

## Acceptance Criteria
<!-- specflow:section=acceptance-criteria -->
- [x] Legacy AC.
`
  const tree = parseMarkdownTree(md)
  assert.equal(isSpecifyCompleteFromTree(tree), false)
  assert.equal(buildFocusSpecify(tree), null)
})

test('plan-parser: 非自足旧 Roadmap 不再回退拼接全局 Feature/Contract', () => {
  const plan = [
    '# Plan R1',
    '',
    '## 2. Technical Contracts',
    '<!-- specflow:section=contract -->',
    'GLOBAL CONTRACT SHOULD NOT LEAK',
    '',
    '## 3. Feature & Design',
    '<!-- specflow:section=feature -->',
    '### [F-01] Global Feature',
    'GLOBAL FEATURE SHOULD NOT LEAK',
    '',
    '## 4. Roadmap',
    '<!-- specflow:section=roadmap -->',
    '### Group A: legacy',
    '- [ ] **T-A1** | 旧任务 | F-01',
  ].join('\n')
  const focus = buildFocusPlanFromTree(parseMarkdownTree(plan), 'Group A')
  assert.equal(focus, null)
})

test('layout-guard: 仓库内不应再出现 specflow-assets 路径片段', () => {
  const offenders = []
  const skipDirs = new Set(['node_modules', '.git', 'ai-docs'])
  function scan(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skipDirs.has(entry.name)) continue
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        scan(p)
        continue
      }
      if (!/\.(cjs|js|ts|md|json|sh)$/.test(entry.name)) continue
      if (p === __filename) continue
      const txt = fs.readFileSync(p, 'utf8')
      if (/specflow-assets/.test(txt)) offenders.push(path.relative(ROOT, p))
    }
  }
  scan(ROOT)
  assert.deepStrictEqual(offenders, [], `仍含 'specflow-assets'：\n${offenders.join('\n')}`)
})
