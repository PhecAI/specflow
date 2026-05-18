/**
 * SpecFlow 共享 CLI 参数解析器
 *
 * 核心原则：命名参数（named flags）优先于位置参数（positional），位置参数仅作向后兼容 fallback。
 * 新增参数永远用 named flag，绝不在已有位置参数中间插入。
 *
 * 解析规则：
 *   --key value   → named['key'] = 'value'（value 不以 '-' 开头）
 *   --flag        → boolFlags.add('flag')（下一个 arg 以 '-' 开头或不存在）
 *   -x value      → named['x'] = 'value'（单字母短别名）
 *   -x            → boolFlags.add('x')
 *   其他           → positional[]
 *   --            → 之后全部入 positional[]
 */
function parseCliArgs(argv) {
  const named = {}
  const boolFlags = new Set()
  const positional = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      for (let j = i + 1; j < argv.length; j++) positional.push(argv[j])
      break
    }
    if (arg.startsWith('--')) {
      // Handle --key=value inline-equals style
      const eqIdx = arg.indexOf('=', 2)
      if (eqIdx !== -1) {
        named[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1)
        continue
      }
      const key = arg.slice(2)
      const next =
        i + 1 < argv.length && !String(argv[i + 1]).startsWith('-')
          ? argv[i + 1]
          : null
      if (next !== null) {
        named[key] = next
        i++
      } else {
        boolFlags.add(key)
      }
    } else if (/^-[a-zA-Z]$/.test(arg)) {
      const key = arg.slice(1)
      const next =
        i + 1 < argv.length && !String(argv[i + 1]).startsWith('-')
          ? argv[i + 1]
          : null
      if (next !== null) {
        named[key] = next
        i++
      } else {
        boolFlags.add(key)
      }
    } else {
      positional.push(arg)
    }
  }

  return { named, boolFlags, positional }
}

/**
 * 解析 workspaceRoot
 * Named: --workspace | --ws | -w
 * Positional fallback: positional[idx]（默认 0）
 */
function resolveWorkspace(named, positional, idx = 0) {
  return (
    named['workspace'] ||
    named['ws'] ||
    named['w'] ||
    positional[idx] ||
    process.cwd()
  )
}

/**
 * 解析 requirementId
 * Named: --requirement-id | --requirementId | --rid | -r
 * Positional fallback: positional[idx]（默认 1）
 */
function resolveRequirementId(named, positional, idx = 1) {
  return (
    named['requirement-id'] ||
    named['requirementId'] ||
    named['rid'] ||
    named['r'] ||
    positional[idx] ||
    ''
  )
}

module.exports = { parseCliArgs, resolveWorkspace, resolveRequirementId }
