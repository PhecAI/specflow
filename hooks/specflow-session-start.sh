#!/usr/bin/env bash
# Specflow — Cursor sessionStart：注入 skills/using-specflow/SKILL.md 全文
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 优先使用平台注入的插件根（若可用），否则回退到脚本反推路径。
if [[ -n "${CURSOR_PLUGIN_ROOT:-}" && -d "${CURSOR_PLUGIN_ROOT}" ]]; then
  PLUGIN_ROOT="$(cd "${CURSOR_PLUGIN_ROOT}" && pwd)"
else
  PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
fi

WORKSPACE_ROOT="${CURSOR_WORKSPACE_PATH:-${PWD}}"
SKILL_FILE="${PLUGIN_ROOT}/skills/using-specflow/SKILL.md"

if [[ ! -f "${SKILL_FILE}" ]]; then
  printf '%s\n' '{"additional_context": ""}'
  exit 0
fi

body=$(cat "${SKILL_FILE}")

escape_for_json() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

prefix=$'<EXTREMELY_IMPORTANT>\n[Specflow] 工作区：'"${WORKSPACE_ROOT}"$'\n[Specflow] 插件根：'"${PLUGIN_ROOT}"$'\n[Specflow] 统一路径锚点：PLUGIN_ROOT='"${PLUGIN_ROOT}"$'\n\n以下为 **skills/using-specflow/SKILL.md** 全文。请按此执行：先跑 orchestrator/engine，再行动。\n\n'
suffix=$'\n</EXTREMELY_IMPORTANT>'
session_context="${prefix}${body}${suffix}"
session_escaped=$(escape_for_json "$session_context")

printf '{\n  "additional_context": "%s"\n}\n' "$session_escaped"
exit 0
