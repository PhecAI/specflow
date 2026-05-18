/**
 * 目录布局守卫：禁止 legacy `skills/specflow-assets/**` 回潮，强制可执行资产只在顶层 `tools/`。
 * 参考 Cursor 官方插件约定：skills/<Skill>/SKILL.md 只存纯指令，代码/协议/模板/长文档在顶层目录。
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')

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
