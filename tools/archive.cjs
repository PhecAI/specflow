/**
 * 归档原子操作：按年/季路径创建目录、搬运 ai-docs/{需求号} 下全部文件、更新 ARCHIVE_SUMMARY 索引、删除原目录。
 * 归档后自动执行知识瘦身：精简 specify.md（仅保留 Section 1, 2, 4 作为立项快照）、删除 plan.md。
 * 执行前须已在 ai-docs/{需求号}/ 下生成 summary.md（可由 AI 在 Archive 阶段先填写）；本脚本不生成 summary 内容。
 *
 * 用法:
 *   统一: PLUGIN_ROOT=/path/to/specflow node "$PLUGIN_ROOT/tools/archive.cjs" [workspaceRoot] <需求号> [--name "需求名称"] [--tags "#a #b"]
 *
 * 输出: JSON 到 stdout，成功时 { ok: true, targetDir, indexLine }，失败时 { ok: false, error }
 */

const fs = require('fs');
const path = require('path');
const { parseMarkdownTree, findByKey, renderNode, renderNodeShallow } = require('./plan-parser.cjs');

const UTF8 = 'utf-8';

/**
 * 精简 specify.md（使用健壮的 AST 解析器）：
 * 仅保留 H1 标题 + Executive Summary + User Roles & Scenarios + Acceptance Criteria。
 * 丢弃已被抽象到领域活文档的 Business Rules，以及过程性的 Clarification Log 和 Changelog。
 * @param {string} content - specify.md 原始内容
 * @returns {string} 精简后的内容
 */
function slimSpecifyContent(content) {
  const tree = parseMarkdownTree(content);
  const parts = [];

  // 1. 保留文档标题 (H1) 和顶部的模板说明
  const h1 = tree.children.find((n) => n.level === 1);
  if (h1) {
    let header = renderNodeShallow(h1).trim();
    header = header.replace(/\n---\s*$/, '').trim();
    if (header) parts.push(header);
  } else if (tree.content.length > 0) {
    parts.push(tree.content.join('\n').trim());
  }

  // 2. 按需保留核心章节（利用锚点精确提取，无视用户的额外 H2 排版）
  const keepKeys = ['executiveSummary', 'userScenarios', 'acceptanceCriteria'];
  for (const key of keepKeys) {
    const section = findByKey(tree, key);
    if (section) {
      parts.push(renderNode(section));
    }
  }

  let slimmed = parts.join('\n\n---\n\n');
  slimmed += '\n\n---\n> 归档精简：仅保留业务背景、用户场景与验收标准作为立项快照，完整的长效业务流转规则请查阅当前需求目录下 `business-domains/` 的活体领域文档。\n';
  return slimmed;
}

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

function parseArgs() {
  const { parseCliArgs, resolveWorkspace, resolveRequirementId } = require('./cli-args.cjs');
  const { named, positional } = parseCliArgs(process.argv.slice(2));
  const workspaceRoot = resolveWorkspace(named, positional, 0);
  const requirementId = resolveRequirementId(named, positional, 1);
  const name = named['name'] || '';
  const tags = named['tags'] || '';
  return { workspaceRoot, requirementId, name, tags };
}

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, UTF8));
  } catch {
    return fallback;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeDomainName(raw) {
  return String(raw || 'general')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\-]/g, '-')
    .replace(/\-+/g, '-')
    .replace(/^\-|\-$/g, '') || 'general';
}

// 老版本 bullet-list 合并实现已下线。归档统一走 merge-global-assets.cjs
// 的结构化合并路径（按 category 分桶 + 置信度阶梯）。保留本文件只为
// 给历史引用一个明确的失败信号，防止悄悄回退到旧格式。

function main() {
  const { workspaceRoot, requirementId, name, tags } = parseArgs();
  if (!requirementId) {
    console.log(JSON.stringify({ ok: false, error: '缺少参数: 需求号' }));
    process.exit(1);
  }

  const aiDocs = path.join(workspaceRoot, 'ai-docs');
  const sourceDir = path.join(aiDocs, requirementId);
  const indexPath = path.join(aiDocs, 'history', 'ARCHIVE_SUMMARY.md');

  if (!fs.existsSync(aiDocs) || !fs.statSync(aiDocs).isDirectory()) {
    console.log(JSON.stringify({ ok: false, error: `ai-docs 不存在或非目录: ${aiDocs}` }));
    process.exit(1);
  }
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    console.log(JSON.stringify({ ok: false, error: `需求目录不存在: ${sourceDir}` }));
    process.exit(1);
  }

  const archiveDirName = path.basename(path.resolve(sourceDir));
  const { year, quarter } = getQuarter();
  const date = getDate();
  const targetDir = path.join(aiDocs, 'history', year, quarter, archiveDirName);

  const requireSpecify = path.join(sourceDir, 'specify.md');
  const requirePlan = path.join(sourceDir, 'plan.md');
  if (!fs.existsSync(requireSpecify)) {
    console.log(JSON.stringify({ ok: false, error: '缺少 specify.md，禁止归档' }));
    process.exit(1);
  }
  if (!fs.existsSync(requirePlan)) {
    console.log(JSON.stringify({ ok: false, error: '缺少 plan.md，禁止归档' }));
    process.exit(1);
  }

  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: `创建目录失败: ${targetDir} - ${String(e)}` }));
    process.exit(1);
  }

  const tempDir = path.join(sourceDir, '.temp');
  // 全局资产合并统一在确认归档后执行（单一入口：archive），严格走结构化合并路径。
  // 若 merge-global-assets.cjs 不可用则归档失败——禁止回退到老 bullet 版本以避免格式漂移。
  let merged = { mergedDomains: [] };
  try {
    const { mergeKnowledgeIntoGlobalAssets } = require('./merge-global-assets.cjs');
    const r = mergeKnowledgeIntoGlobalAssets(workspaceRoot, requirementId);
    if (r && r.ok) {
      merged = r;
    } else {
      console.log(JSON.stringify({ ok: false, error: `全局合并失败：${(r && r.error) || '未知错误'}` }));
      process.exit(1);
    }
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: `全局合并模块加载失败，禁止降级到老 bullet 合并: ${String(e)}` }));
    process.exit(1);
  }
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  // ── 知识瘦身与物理归档：仅保留 specify.md ──
  const sourceSpecify = path.join(sourceDir, 'specify.md');
  const targetSpecify = path.join(targetDir, 'specify.md');
  
  if (fs.existsSync(sourceSpecify)) {
    try {
      const specifyContent = fs.readFileSync(sourceSpecify, UTF8);
      const slimmed = slimSpecifyContent(specifyContent);
      fs.writeFileSync(targetSpecify, slimmed, UTF8);
    } catch (e) {
      // 如果瘦身失败，作为 fallback 直接拷贝原文件
      fs.copyFileSync(sourceSpecify, targetSpecify);
    }
  } else {
    console.warn(`警告: 未找到源文件 ${sourceSpecify}`);
  }

  function removeSourceDir() {
    if (!fs.existsSync(sourceDir)) return;
    try {
      fs.rmSync(sourceDir, { recursive: true, force: true });
    } catch {
      try {
        fs.rmSync(sourceDir, { recursive: true, force: true });
      } catch (e2) {
        throw new Error(`原需求目录删除失败: ${sourceDir} - ${String(e2)}`);
      }
    }
  }
  removeSourceDir();
  if (fs.existsSync(sourceDir)) {
    try {
      fs.rmdirSync(sourceDir);
    } catch {
      console.log(JSON.stringify({ ok: false, error: `归档后原目录仍存在且无法删除: ${sourceDir}，请手动移除` }));
      process.exit(1);
    }
  }

  const displayName = name || archiveDirName;
  const indexLine = `- **${archiveDirName}**: ${displayName} | \`ai-docs/history/${year}/${quarter}/${archiveDirName}/\` | 完成日期: ${date} | 标签: ${tags || '(无)'}`;
  const sectionTitle = `## ${year}-${quarter}`;

  let indexContent = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, UTF8) : '# 归档索引 (Archive Summary)\n\n> 按年份/季度组织的需求归档索引\n\n';

  if (!indexContent.includes(sectionTitle)) {
    const lastSection = indexContent.match(/## \d{4}-Q[1-4]/g);
    const insertAt = lastSection
      ? (() => {
          const lastTitle = lastSection[lastSection.length - 1];
          const start = indexContent.lastIndexOf(lastTitle);
          const nextH2 = indexContent.indexOf('\n## ', start + 2);
          return nextH2 > 0 ? nextH2 : indexContent.length;
        })()
      : indexContent.length;
    indexContent = indexContent.slice(0, insertAt) + '\n\n' + sectionTitle + '\n\n' + indexLine + '\n' + indexContent.slice(insertAt);
  } else {
    const sectionStart = indexContent.indexOf(sectionTitle);
    const sectionEnd = indexContent.indexOf('\n## ', sectionStart + 2);
    const end = sectionEnd > 0 ? sectionEnd : indexContent.length;
    const section = indexContent.slice(sectionStart, end);
    const lastLine = section.trimEnd().split('\n').pop() || '';
    const newSection = section + (lastLine.endsWith('\n') ? '' : '\n') + indexLine + '\n';
    indexContent = indexContent.slice(0, sectionStart) + newSection + indexContent.slice(end);
  }

  fs.writeFileSync(indexPath, indexContent, UTF8);

  console.log(JSON.stringify({
    ok: true,
    targetDir: `ai-docs/history/${year}/${quarter}/${archiveDirName}/`,
    indexLine,
    mergedDomains: merged.mergedDomains,
    date,
    yearQuarter: `${year}-${quarter}`,
  }, null, 2));
}

if (require.main === module) {
  main();
}
