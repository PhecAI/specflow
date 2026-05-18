#!/usr/bin/env node
/**
 * 从 specflow-engine 的 JSON stdout 渲染用户可见 Markdown（渐进披露，不含内部字段名）。
 * 用法：
 *   统一: PLUGIN_ROOT=/path/to/specflow node "$PLUGIN_ROOT/tools/render-user-facing.cjs"   （从 stdin 读入引擎 JSON）
 *   统一: PLUGIN_ROOT=/path/to/specflow node "$PLUGIN_ROOT/tools/render-user-facing.cjs" --file <engine-output.json>
 */

const fs = require('fs')
const path = require('path')
const { renderUserFacingMarkdown, buildUserFacing } = require('./user-facing.cjs')

const PLUGIN_ROOT = path.join(__dirname, '..')

function extractJsonObject(text) {
  const t = String(text || '').trim()
  const i = t.indexOf('{')
  if (i === -1) throw new Error('未在输入中找到 JSON 对象')
  return JSON.parse(t.slice(i))
}

function main() {
  const argv = process.argv.slice(2)
  let raw = ''
  if (argv[0] === '--file' && argv[1]) {
    raw = fs.readFileSync(argv[1], 'utf-8')
  } else {
    try {
      raw = fs.readFileSync(0, 'utf-8')
    } catch {
      console.error('用法: 将引擎 JSON 通过 stdin 传入，或: node render-user-facing.cjs --file <path.json>')
      process.exit(1)
    }
  }

  let payload
  try {
    payload = extractJsonObject(raw)
  } catch (e) {
    console.error(String(e.message || e))
    process.exit(1)
  }

  let uf = payload.userFacing
  if (!uf || typeof uf !== 'object') {
    uf = buildUserFacing(payload)
  }

  const md = renderUserFacingMarkdown(uf, PLUGIN_ROOT)
  process.stdout.write(md)
}

if (require.main === module) {
  main()
}

module.exports = { main }
