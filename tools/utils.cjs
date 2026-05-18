/**
 * SpecFlow 通用工具函数：日期 / 季度计算等。
 * 合并了原 get-date / get-quarter 两个脚本。
 *
 * 用法（统一）: PLUGIN_ROOT=/path/to/specflow node "$PLUGIN_ROOT/tools/utils.cjs" <action>
 *
 * Actions:
 *   date    — 输出当前日期 YYYY-MM-DD（本地时区）
 *   quarter — 输出 JSON {"year":"2026","quarter":"Q1"}
 *
 * 输出: 单行文本 / JSON 到 stdout
 */

const ACTIONS = ['date', 'quarter'];

function getDate() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getQuarter() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const quarter = month <= 3 ? 'Q1' : month <= 6 ? 'Q2' : month <= 9 ? 'Q3' : 'Q4';
  return { year: String(year), quarter };
}

function main() {
  const action = process.argv[2];

  if (!ACTIONS.includes(action)) {
    console.error(`未知 action: ${action}。可选: ${ACTIONS.join(', ')}`);
    process.exit(1);
  }

  switch (action) {
    case 'date':
      console.log(getDate());
      break;
    case 'quarter':
      console.log(JSON.stringify(getQuarter()));
      break;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  getDate,
  getQuarter
};
