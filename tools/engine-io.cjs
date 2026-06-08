const fs = require('fs');
const path = require('path');

const UTF8 = 'utf-8';
const EXCLUDED_AI_DOCS_DIRS = new Set(['history', 'knowledge-base']);

function getFileMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function clearPendingProtocol(requirementDir) {
  if (!requirementDir) return;
  try {
    const protoPath = path.join(requirementDir, '.temp', 'pending-protocol.json');
    if (fs.existsSync(protoPath)) fs.unlinkSync(protoPath);
  } catch (_) {
    // 清理失败不影响引擎主流程；下一次 dispatch 会覆盖协议。
  }
}

function safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, UTF8);
  } catch {
    return null;
  }
}

function safeWriteFile(filePath, content) {
  try {
    fs.writeFileSync(filePath, content, UTF8);
    return true;
  } catch {
    return false;
  }
}

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, UTF8));
  } catch {
    return fallback;
  }
}

/** 扫描 ai-docs 下需求目录，按目录内最新文件 mtime 排序，返回前 limit 个目录名 */
function getRecentRequirementIds(aiDocs, limit) {
  try {
    if (!fs.existsSync(aiDocs) || !fs.statSync(aiDocs).isDirectory()) return [];
    const entries = fs.readdirSync(aiDocs, { withFileTypes: true });
    const dirs = [];
    for (const e of entries) {
      if (!e.isDirectory() || EXCLUDED_AI_DOCS_DIRS.has(e.name)) continue;
      const dirPath = path.join(aiDocs, e.name);
      let maxMtime = 0;
      try {
        const files = fs.readdirSync(dirPath);
        for (const f of files) {
          const fp = path.join(dirPath, f);
          try {
            const stat = fs.statSync(fp);
            if (stat.isFile() && stat.mtimeMs > maxMtime)
              maxMtime = stat.mtimeMs;
          } catch {
            // ignore per-file errors
          }
        }
      } catch {
        continue;
      }
      dirs.push({ name: e.name, mtime: maxMtime });
    }
    dirs.sort((a, b) => b.mtime - a.mtime);
    return dirs.slice(0, limit).map((d) => d.name);
  } catch {
    return [];
  }
}

/** 取目录下 specify.md、plan.md 的 mtime 最大值，返回 ISO 8601 字符串 */
function getLastModified(dir) {
  let maxMs = 0;
  for (const f of ['specify.md', 'plan.md']) {
    const fp = path.join(dir, f);
    try {
      const stat = fs.statSync(fp);
      if (stat.isFile() && stat.mtimeMs > maxMs) maxMs = stat.mtimeMs;
    } catch {
      // ignore
    }
  }
  if (maxMs === 0) return null;
  return new Date(maxMs).toISOString();
}

module.exports = {
  UTF8,
  clearPendingProtocol,
  getFileMtimeMs,
  getLastModified,
  getRecentRequirementIds,
  safeReadFile,
  safeReadJson,
  safeWriteFile,
};
