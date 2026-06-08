const fs = require('fs');
const path = require('path');
const { UTF8, safeReadFile, safeReadJson, safeWriteFile } = require('./engine-io.cjs');
const { normalizeDomainInitRef, domainRefToFileStem } = require('./specflow-state.cjs');

function tokenizeText(input) {
  return String(input || '')
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/i)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

function normalizeSlug(raw) {
  return (
    String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\-]/g, '-')
      .replace(/\-+/g, '-')
      .replace(/^\-|\-$/g, '') || ''
  );
}

function resolveRequirementDomainDir(workspaceRoot, requirementId) {
  const rid = String(requirementId || '').trim();
  if (!rid) return '';
  return path.join(workspaceRoot, 'ai-docs', rid, 'business-domains');
}

function readRequirementHintText(workspaceRoot, requirementId) {
  const reqDir = path.join(workspaceRoot, 'ai-docs', requirementId);
  const files = ['specify.md', 'plan.md'];
  const chunks = [];
  for (const f of files) {
    const p = path.join(reqDir, f);
    const c = safeReadFile(p);
    if (c) chunks.push(c.slice(0, 8000));
  }
  return chunks.join('\n');
}

function listEvidenceDocs(workspaceRoot, requirementId) {
  const docs = [];
  const addDir = (dir) => {
    if (!dir) return;
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        docs.push({
          full: path.join(dir, f),
          rel: path.relative(workspaceRoot, path.join(dir, f)),
        });
      }
    } catch {}
  };
  addDir(resolveRequirementDomainDir(workspaceRoot, requirementId));
  addDir(path.join(workspaceRoot, 'ai-docs', 'global-assets', 'domains'));
  return docs;
}

function hasStrongEvidenceStructure(md) {
  const t = String(md || '');
  const hasEntityTable =
    /\|\s*字段\s*\|\s*类型\s*\|\s*含义\s*\|/.test(t) ||
    /\|\s*Field\s*\|\s*Type\s*\|/i.test(t);
  const hasRule = /\bRule-\d{3,}\b/.test(t);
  const hasMermaid =
    t.includes('```mermaid') &&
    (/\bstateDiagram-v2\b/.test(t) || /\bstateDiagram\b/.test(t));
  return hasEntityTable || hasRule || hasMermaid;
}

function scoreEvidenceDoc(content, hintTokens) {
  if (!content) return 0;
  const hay = String(content).toLowerCase();
  let hit = 0;
  for (const token of hintTokens) {
    if (!token) continue;
    if (hay.includes(token)) hit++;
  }
  return hit;
}

function autoResolveClarificationsWithEvidence(
  workspaceRoot,
  requirementId,
  specifyPath,
  specifyContent,
) {
  const text = String(specifyContent || '');
  if (!text) return { changed: false, autoCount: 0 };

  // 仅处理澄清草稿中的 `### [?] CQ-xx: title` 区块
  const cqRegex =
    /(^|\n)(#{3,6})\s+\[\?\]\s*(CQ[^\n:]*?)\s*[:：]\s*([^\n]*)\n([\s\S]*?)(?=\n#{3,6}\s+\[\?\]\s*CQ|\n##\s+|$)/g;

  const evidenceDocs = listEvidenceDocs(workspaceRoot, requirementId);
  if (evidenceDocs.length === 0) return { changed: false, autoCount: 0 };

  let changed = false;
  let autoCount = 0;
  let out = text;

  // 为了稳定：按出现顺序处理；每次替换只替换当前匹配块（用 slice 拼接）
  let match;
  let offset = 0;
  while ((match = cqRegex.exec(text)) !== null) {
    const fullStart = match.index;
    const fullText = match[0].startsWith('\n') ? match[0].slice(1) : match[0];
    const blockStart = match[0].startsWith('\n') ? fullStart + 1 : fullStart;
    const blockEnd = blockStart + fullText.length;

    const cqId = String(match[3] || '').trim();
    const cqTitle = String(match[4] || '').trim();
    const cqBody = String(match[5] || '');

    // 跳过特殊门禁型 CQ（由流程自己处理）
    if (cqId.startsWith('CQ-Domain-Init')) continue;

    const hintTokens = tokenizeText(`${cqTitle}\n${cqBody}`)
      .filter(Boolean)
      .slice(0, 20);
    if (hintTokens.length === 0) continue;

    let best = null;
    for (const doc of evidenceDocs) {
      const c = safeReadFile(doc.full);
      if (!c) continue;
      if (!hasStrongEvidenceStructure(c)) continue; // strict: 必须有结构支撑
      const score = scoreEvidenceDoc(c, hintTokens);
      if (score <= 0) continue;
      if (
        !best ||
        score > best.score ||
        (score === best.score && doc.rel < best.rel)
      ) {
        // tie-break: 路径字典序，保证确定性
        best = { rel: doc.rel, full: doc.full, score, content: c };
      }
    }
    if (!best) continue;

    // 结论：抽取第一条命中行（稳定：从上到下找）
    const lines = best.content.split('\n');
    let pickedLine = '';
    for (const line of lines) {
      const l = line.trim();
      if (!l) continue;
      const low = l.toLowerCase();
      if (hintTokens.some((t) => t && low.includes(t))) {
        pickedLine = l;
        break;
      }
    }
    const conclusion = pickedLine
      ? pickedLine.slice(0, 200)
      : '已找到相关定义，请以该领域文档为准对齐。';

    const heading = `${match[2]} [Auto] ${cqId}: ${cqTitle}`.trimEnd();
    const suffix = `\n\n**Conclusion**: ${conclusion}\n\n(Ref: ${best.rel})\n`;
    const newBlock = `${heading}\n${cqBody.trimEnd()}${suffix}`;

    // 应用替换到 out（基于原 text 的坐标；需映射到 out 的偏移）
    const adjStart = blockStart + offset;
    const adjEnd = blockEnd + offset;
    out = out.slice(0, adjStart) + newBlock + out.slice(adjEnd);
    offset += newBlock.length - (adjEnd - adjStart);
    changed = true;
    autoCount++;
  }

  if (changed) {
    safeWriteFile(specifyPath, out);
  }
  return { changed, autoCount };
}

function scoreKnowledgeChunk(name, content, hintTokens) {
  if (!hintTokens || hintTokens.length === 0) return 0;
  const hay = `${String(name || '').toLowerCase()} ${String(content || '').toLowerCase()}`;
  let score = 0;
  for (const token of hintTokens) {
    if (!token) continue;
    if (
      String(name || '')
        .toLowerCase()
        .includes(token)
    )
      score += 4;
    if (hay.includes(token)) score += 1;
  }
  return score;
}


function listDomainDocs(workspaceRoot) {
  const domainsDir = path.join(
    workspaceRoot,
    'ai-docs',
    'global-assets',
    'domains',
  );
  if (!fs.existsSync(domainsDir) || !fs.statSync(domainsDir).isDirectory())
    return [];
  return fs
    .readdirSync(domainsDir)
    .filter((f) => f.endsWith('.md') && f !== 'index.md')
    .map((file) => ({
      file,
      domain: file.replace(/\.md$/i, ''),
      full: path.join(domainsDir, file),
    }));
}

function listCodeFiles(workspaceRoot) {
  const roots = ['src', 'app', 'server', 'backend', 'frontend', 'packages'];
  const out = [];
  function walk(dir, depth) {
    if (depth > 5) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (
          ['node_modules', '.git', 'dist', 'build', 'coverage'].includes(
            ent.name,
          )
        )
          continue;
        walk(full, depth + 1);
      } else if (ent.isFile()) {
        if (!/\.(ts|tsx|js|jsx|py|go|java|md)$/i.test(ent.name)) continue;
        out.push(full);
        if (out.length >= 1200) return;
      }
    }
  }
  for (const r of roots) {
    const abs = path.join(workspaceRoot, r);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      walk(abs, 0);
      if (out.length >= 1200) break;
    }
  }
  return out;
}

function listRequirementDomainSlugs(workspaceRoot, requirementId) {
  const dir = resolveRequirementDomainDir(workspaceRoot, requirementId);
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'index.md')
    .map((file) => {
      const stem = file.replace(/\.md$/i, '').trim().toLowerCase();
      const content = safeReadFile(path.join(dir, file));
      const m = content.match(/^domain:\s*(.+)\s*$/m);
      const fromFm = m ? normalizeDomainInitRef(m[1]) : null;
      if (fromFm) return fromFm;
      const parts = stem.split('__').filter(Boolean);
      if (parts.length >= 2) return normalizeDomainInitRef(`${parts.slice(0, -1).join('/')}::${parts[parts.length - 1]}`);
      return null;
    })
    .filter(Boolean);
}

function selectRelevantDomains(workspaceRoot, hintText, limit = 2, allowDomains = null) {
  const docs = listDomainDocs(workspaceRoot);
  if (docs.length === 0) return [];
  const allow = Array.isArray(allowDomains) && allowDomains.length > 0
    ? new Set(allowDomains.map((d) => domainRefToFileStem(d)).filter(Boolean))
    : null;
  if (allow) {
    return docs
      .map((d) => String(d.domain || '').trim().toLowerCase())
      .filter((domain) => allow.has(domain))
      .slice(0, limit);
  }
  const hintTokens = tokenizeText(hintText);
  const scored = [];
  for (const d of docs) {
    const content = safeReadFile(d.full);
    if (!content) continue;
    scored.push({
      domain: d.domain,
      file: d.file,
      score: scoreKnowledgeChunk(d.file, content, hintTokens),
    });
  }
  scored.sort((a, b) => b.score - a.score || a.domain.localeCompare(b.domain));
  const positive = scored.filter((x) => x.score > 0);
  const picked = (positive.length > 0 ? positive : scored.slice(0, 1)).slice(
    0,
    limit,
  );
  return picked.map((x) => x.domain);
}

// 从 domain md 抽取 status：
// - 新格式（v2）：frontmatter 仅有 sourceRequirementIds，status 由数组长度现算
// - 老格式（v1）：frontmatter 内有 status 字段（向下兼容）
// - 回退：body 里的 badge 行（`> **status**: Xxx`）
function readDomainStatus(content) {
  const text = String(content || '');
  if (!text.startsWith('---\n')) return 'Unknown';
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) return 'Unknown';
  const fm = text.slice(4, end);

  // v2：从 sourceRequirementIds 现算
  const m2 = fm.match(/^sourceRequirementIds:\s*\[([^\]]*)\]\s*$/m);
  if (m2) {
    const items = String(m2[1] || '')
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
    const n = items.length;
    if (n >= 3) return 'Verified';
    if (n >= 2) return 'Consolidating';
    if (n >= 1) return 'Draft';
    return 'Draft';
  }

  // v1：老 frontmatter 的 status 字段
  const m1 = fm.match(/^status:\s*(\S+)\s*$/m);
  if (m1) {
    const v = String(m1[1] || '').trim();
    if (/^verified$/i.test(v)) return 'Verified';
    if (/^consolidating$/i.test(v)) return 'Consolidating';
    if (/^draft$/i.test(v)) return 'Draft';
    return v || 'Unknown';
  }

  // 回退：body badge
  const body = text.slice(end + '\n---\n'.length);
  const mb = body.match(/\*\*status\*\*:\s*(Verified|Consolidating|Draft)\b/);
  if (mb) return mb[1];
  return 'Unknown';
}

const STATUS_RANK = { Verified: 0, Consolidating: 1, Draft: 2, Unknown: 3 };
const STATUS_BANNER = {
  Verified: '【已验证规则 · Verified】可作为硬约束；QA 允许据此判 Fail。',
  Consolidating:
    '【收敛中 · Consolidating · 2 次需求观测】仅作强参考，单点不作为 Fail 依据。',
  Draft:
    '【草案 · Draft · 仅 1 次需求观测】谨慎采信，**禁止作为 QA Fail 判据**；可作为启发。',
  Unknown: '【未标注置信度】按草案对待。',
};

// 单个 domain chunk 的字符上限（超限时截断 Draft 段，Verified/Consolidating 不截断）
const DRAFT_CHUNK_CHAR_BUDGET = 2000;

function readGlobalDomainKnowledge(workspaceRoot, domains) {
  const docs = listDomainDocs(workspaceRoot);
  if (docs.length === 0) return [];
  const allow = new Set((domains || []).map((d) => String(d).toLowerCase()));
  const selectedDocs = docs.filter((d) =>
    allow.has(String(d.domain).toLowerCase()),
  );
  const items = [];
  for (const d of selectedDocs) {
    const content = safeReadFile(d.full);
    if (!content) continue;
    const status = readDomainStatus(content);
    items.push({ file: d.file, status, content: String(content).trim() });
  }
  // 按 status 升序：Verified → Consolidating → Draft → Unknown
  items.sort(
    (a, b) =>
      (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) ||
      a.file.localeCompare(b.file),
  );
  const chunks = [];
  for (const it of items) {
    let body = it.content;
    // 对 Draft 段做预算截断，避免弱信度噪声挤占 Verified 的注意力
    if (it.status === 'Draft' && body.length > DRAFT_CHUNK_CHAR_BUDGET) {
      body = `${body.slice(0, DRAFT_CHUNK_CHAR_BUDGET)}\n\n> …（Draft 段超长已截断，完整内容见 ${it.file}）`;
    }
    const banner = STATUS_BANNER[it.status] || STATUS_BANNER.Unknown;
    chunks.push(`### ${it.file}\n> ${banner}\n\n${body}`);
  }
  return chunks;
}

// 从一批 domain md 文本里抽出所有已存在的 rowKey 集合，用于 patch 跨源去重。
// 返回 Map<domain, Set<rowKey>>。
function collectGlobalDomainKeys(workspaceRoot, domainNames) {
  const { parseDomainMd, rowKey } = require('./domain-knowledge.cjs');
  const out = new Map();
  const docs = listDomainDocs(workspaceRoot);
  const allow = new Set(
    (domainNames || []).map((d) => String(d).toLowerCase()),
  );
  for (const d of docs) {
    if (!allow.has(String(d.domain).toLowerCase())) continue;
    const content = safeReadFile(d.full);
    if (!content) continue;
    try {
      const { buckets } = parseDomainMd(content);
      const keys = new Set();
      for (const cat of ['entity', 'rule', 'stateMachine', 'formula', 'pitfall', 'techDebt']) {
        for (const row of buckets[cat] || []) keys.add(rowKey(cat, row));
      }
      out.set(String(d.domain).toLowerCase(), keys);
    } catch (_) {
      // 解析失败则不启用跨源去重（保守）
    }
  }
  return out;
}

// 读取需求级 business-domains/<slug>.md 活文档（Explorer 产出的"本期法典"）。
// 只在与 hintText 相关的 slug 上取，避免全量注入；按相关性 top 2。
function readRequirementDomainDocs(workspaceRoot, requirementId, hintText, allowDomains = null) {
  const dir = resolveRequirementDomainDir(workspaceRoot, requirementId);
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const allow = Array.isArray(allowDomains) && allowDomains.length > 0
    ? new Set(allowDomains.map((d) => domainRefToFileStem(d)).filter(Boolean))
    : null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'index.md')
    .filter((f) => !allow || allow.has(f.replace(/\.md$/i, '').trim().toLowerCase()));
  if (files.length === 0) return [];
  const hintTokens = tokenizeText(hintText);
  const scored = [];
  for (const f of files) {
    const full = path.join(dir, f);
    const content = safeReadFile(full);
    if (!content) continue;
    scored.push({
      slug: f.replace(/\.md$/i, ''),
      file: f,
      content: String(content).trim(),
      score: scoreKnowledgeChunk(f, content, hintTokens),
    });
  }
  scored.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
  // 即使全部 0 分也至少保留 1 个（本期法典应尽量让 agent 看到）
  const positive = scored.filter((x) => x.score > 0);
  return (positive.length > 0 ? positive : scored.slice(0, 1)).slice(0, 2);
}

// patch 按 category 分组渲染（扁平 schema 优先，兼容 legacy attributes.*）
// ui 类别一律丢弃（不应跨任务污染 agent；ui 只在需求内部文档存在）
// 若某条 patch 的 rowKey 已出现在全局 domain md，跳过（避免重复）
function renderLocalPatchSection(patches, globalKeysByDomain) {
  const {
    normalizeKnowledgeCategory,
    shouldReflowToGlobal,
    patchToRow,
    rowKey,
  } = require('./domain-knowledge.cjs');
  const { domainRefToFileStem } = require('./specflow-state.cjs');
  const buckets = { entity: [], rule: [], stateMachine: [], formula: [], pitfall: [], techDebt: [] };
  let droppedUi = 0;
  let dedupedGlobal = 0;
  for (const patch of Array.isArray(patches) ? patches : []) {
    if (!patch) continue;
    const category = normalizeKnowledgeCategory(patch.category);
    if (!shouldReflowToGlobal(category)) {
      droppedUi += 1;
      continue;
    }
    const row = patchToRow(category, patch, '');
    if (row.slice(0, -1).every((c) => !String(c || '').trim())) continue;
    const domain = domainRefToFileStem(String(
      patch.domain || patch.slug || patch.module || 'general',
    )) || '';
    const existing = globalKeysByDomain.get(domain);
    if (existing && existing.has(rowKey(category, row))) {
      dedupedGlobal += 1;
      continue;
    }
    buckets[category].push(row);
  }
  const any = Object.values(buckets).some((arr) => arr.length > 0);
  if (!any) return { text: '', stats: { droppedUi, dedupedGlobal, shown: 0 } };
  const labels = {
    entity: '实体 / 术语',
    rule: '业务规则（草案）',
    stateMachine: '状态机 / 门禁',
    formula: '核心公式',
    pitfall: '避坑 / 风险',
    techDebt: '技术债 / TODO',
  };
  const columnLabels = {
    entity: (r) =>
      `- **${r[0] || '（未命名术语）'}** — ${r[1] || ''}${r[2] ? `（${r[2]}）` : ''}`,
    rule: (r) => `- [${r[2] || 'Soft'}] **${r[0] || '通用'}**：${r[1] || ''}`,
    stateMachine: (r) =>
      `- \`${r[0] || '*'}\` ─[${r[1] || ''}]→ \`${r[2] || '*'}\``,
    formula: (r) => `- **${r[0] || '通用'}**：${r[1] || ''}${r[2] ? `（${r[2]}）` : ''}`,
    pitfall: (r) => `- **${r[0] || '通用'}**：${r[1] || ''}${r[2] ? `；影响：${r[2]}` : ''}`,
    techDebt: (r) =>
      `- **${r[0] || 'TD'}**${r[2] ? ` (@${r[2]})` : ''}：${r[1] || ''}`,
  };
  const lines = ['## 局部 Patch（本期草案，尚未回流全局）'];
  lines.push(
    '> 仅展示本期新增/变更的规则草案；已进入全局资产的规则不再重复（见「全局资产基准」）。',
  );
  if (droppedUi > 0 || dedupedGlobal > 0) {
    lines.push(
      `> 注入过滤：丢弃 UI 类 ${droppedUi} 条；与全局重复已去重 ${dedupedGlobal} 条。`,
    );
  }
  lines.push('');
  let shown = 0;
  for (const cat of ['entity', 'rule', 'stateMachine', 'formula', 'pitfall', 'techDebt']) {
    if (buckets[cat].length === 0) continue;
    lines.push(`### ${labels[cat]}`);
    for (const r of buckets[cat]) {
      lines.push(columnLabels[cat](r));
      shown += 1;
    }
    lines.push('');
  }
  return {
    text: lines.join('\n').trim(),
    stats: { droppedUi, dedupedGlobal, shown },
  };
}

function buildKnowledgeContext(workspaceRoot, requirementId, hintText, options = {}) {
  const parts = [];
  const domainAllowlist = Array.isArray(options.domainAllowlist)
    ? options.domainAllowlist.map((d) => String(d || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const requireDomainAllowlist = options.requireDomainAllowlist === true;
  const hasDomainAllowlist = domainAllowlist.length > 0;
  const relevantDomains = requireDomainAllowlist && !hasDomainAllowlist
    ? []
    : selectRelevantDomains(
        workspaceRoot,
        hintText,
        2,
        domainAllowlist,
      );

  // 1) 需求级 business-domains（本期法典：Explorer 产出的活文档）
  const reqDomainDocs = requireDomainAllowlist && !hasDomainAllowlist
    ? []
    : readRequirementDomainDocs(
        workspaceRoot,
        requirementId,
        hintText,
        domainAllowlist,
      );
  if (reqDomainDocs.length > 0) {
    const chunks = reqDomainDocs.map((it) => `### ${it.file}\n\n${it.content}`);
    parts.push(
      [
        '## 本期业务知识（需求级权威）',
        '> 来自 `ai-docs/<需求号>/business-domains/`。本期未定版但 Explorer 已梳理，优先以此为准。',
        '',
        chunks.join('\n\n'),
      ].join('\n'),
    );
  }

  // 2) 全局资产基准（按 status 排序 + Draft 截断）
  const globalChunks = readGlobalDomainKnowledge(
    workspaceRoot,
    relevantDomains,
  );
  if (globalChunks.length > 0) {
    parts.push(`## 全局资产基准\n${globalChunks.join('\n\n')}`);
  }

  // 3) 局部 Patch（按 category 分组；丢 ui；跨源去重）
  const localPatchPath = path.join(
    workspaceRoot,
    'ai-docs',
    requirementId,
    '.temp',
    'knowledge-patch.json',
  );
  const localPatches = safeReadJson(localPatchPath, []);
  if (Array.isArray(localPatches) && localPatches.length > 0) {
    const globalKeysByDomain = collectGlobalDomainKeys(
      workspaceRoot,
      relevantDomains,
    );
    const { text } = renderLocalPatchSection(localPatches, globalKeysByDomain);
    if (text) parts.push(text);
  }

  // 4) 代码规范命中切片：按 hintText（优先为 focusPlan）里的 Create/Modify 路径
  try {
    const codeStyleSlice = buildCodeStyleSlice(
      workspaceRoot,
      requirementId,
      hintText,
    );
    if (codeStyleSlice) parts.push(codeStyleSlice);
  } catch {
    // 代码规范切片失败时静默降级
  }

  if (parts.length === 0) return '';
  return parts.join('\n\n');
}

function buildCodeStyleSlice(workspaceRoot, requirementId, hintText) {
  const {
    readGlobalCodeStyleRules,
    parseGlobalCodeStyleRules,
    readArchitectureLayers,
    parseCodeStyleSops,
    extractTaskFilePaths,
    matchRulesForPaths,
    globToRegExp,
  } = require('./code-style.cjs');

  const filePaths = extractTaskFilePaths(hintText || '');
  if (filePaths.length === 0) return '';

  // 合并全局规则 + 需求级 code-style.md（若存在）；再按路径过滤
  const { globalRules } = readGlobalCodeStyleRules(workspaceRoot);
  const globalCodeStylePath = path.join(
    workspaceRoot,
    'ai-docs',
    'global-assets',
    'standards',
    'code-style.md',
  );
  const globalCodeStyleText = fs.existsSync(globalCodeStylePath)
    ? fs.readFileSync(globalCodeStylePath, UTF8)
    : '';
  const layers = readArchitectureLayers(workspaceRoot).layerObjects || [];
  const sops = parseCodeStyleSops(globalCodeStyleText);
  const reqCodeStylePath = path.join(
    workspaceRoot,
    'ai-docs',
    String(requirementId || ''),
    'code-style.md',
  );
  let reqRules = [];
  if (requirementId && fs.existsSync(reqCodeStylePath)) {
    const text = fs.readFileSync(reqCodeStylePath, UTF8);
    reqRules = parseGlobalCodeStyleRules(text);
  }

  const allRules = [
    ...(Array.isArray(globalRules) ? globalRules : []),
    ...reqRules,
  ];
  const hitRules = matchRulesForPaths(allRules, filePaths, {
    includeGlobal: true,
  });
  const activeLayers = layers.filter((layer) => {
    const globs = Array.isArray(layer.globs) ? layer.globs : [];
    return globs.some((g) => {
      const re = globToRegExp(g);
      return filePaths.some((p) => re.test(p));
    });
  });
  const activeLayerIds = new Set(activeLayers.map((l) => l.id));
  const hitSops = sops.filter((sop) => {
    const sopLayers = Array.isArray(sop.layers) ? sop.layers : [];
    if (sopLayers.some((id) => activeLayerIds.has(id))) return true;
    const applies = Array.isArray(sop.applies) ? sop.applies : [];
    return applies.some((g) => {
      const re = globToRegExp(g);
      return filePaths.some((p) => re.test(p));
    });
  });
  if (hitRules.length === 0 && activeLayers.length === 0 && hitSops.length === 0) return '';

  const lines = [
    '## Code Style Context',
    '',
    `> 本次 Active Group 涉及 ${filePaths.length} 个路径，命中 ${activeLayers.length} 个 layer、${hitSops.length} 条 SOP、${hitRules.length} 条规则。`,
    '',
  ];
  if (activeLayers.length > 0) {
    lines.push('### Active Layers', '');
    for (const layer of activeLayers) {
      lines.push(`- \`${layer.id}\`${layer.role ? `：${layer.role}` : ''}`);
      for (const item of layer.should || []) lines.push(`  - should: ${item}`);
      for (const item of layer.should_not || []) lines.push(`  - should_not: ${item}`);
    }
    lines.push('');
  }
  if (hitSops.length > 0) {
    lines.push('### SOPs', '');
    for (const sop of hitSops) {
      lines.push(`- \`${sop.id}\``);
      for (const step of sop.pattern || []) lines.push(`  - ${step}`);
      if (sop.validation) lines.push(`  - validation: ${sop.validation}`);
    }
    lines.push('');
  }
  // 按 section 分组输出
  if (hitRules.length > 0) {
    lines.push('### Rules', '');
    const bySection = new Map();
    for (const r of hitRules) {
      const s = r.section || 'general';
      if (!bySection.has(s)) bySection.set(s, []);
      bySection.get(s).push(r);
    }
    for (const [section, rules] of bySection) {
      lines.push(`- **${section}**`);
      for (const r of rules) {
        lines.push(`  - ${r.content}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

/**
 * 仅合并已经被「确认」的领域来源：state、需求目录内的 business-domains/*.md。
 * 候选（尚未确认）保留在 state.domainInitCandidateRefs，由引擎单独处理成 yes/no 问题。
 * 不再做任何基于代码/目录/关键词的启发式推断——统一下放到 agent prompt。
 */
function inferInitDomainSlugs(gates, requirementId) {
  const fromStateList = Array.isArray(gates.domainInitRefs)
    ? gates.domainInitRefs.filter(Boolean)
    : [];
  const fromReq = listRequirementDomainSlugs(
    gates.workspaceRoot,
    requirementId,
  );
  const merged = [...fromStateList, ...fromReq];
  const out = [];
  const seen = new Set();
  for (const x of merged) {
    const v = normalizeDomainInitRef(String(x || ''));
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function getKnowledgeDomainAllowlist(gates, requirementId) {
  const stateDomains = (Array.isArray(gates.domainInitRefs) ? gates.domainInitRefs : [])
    .map((x) => normalizeDomainInitRef(String(x || '')))
    .filter(Boolean);
  const out = [];
  const seen = new Set();
  const source = stateDomains.length > 0
    ? stateDomains
    : listRequirementDomainSlugs(gates.workspaceRoot, requirementId);
  for (const x of source) {
    const v = normalizeDomainInitRef(String(x || ''));
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function buildKnowledgePolicy(gates, requirementId, agent, knowledgeContext, domainAllowlist) {
  const allowlist = Array.isArray(domainAllowlist) ? domainAllowlist.filter(Boolean) : [];
  let baselineStatus = 'not_required';
  let baselineReason = '';
  if (agent === 'specflow-specify') {
    if (allowlist.length > 0) {
      baselineStatus = 'confirmed';
      baselineReason = `confirmed domains: ${allowlist.join(', ')}`;
    } else if (gates && gates.domainInitChoice === 'skip') {
      baselineStatus = 'skipped';
      baselineReason = 'user chose to skip business-domain initialization';
    } else {
      baselineStatus = 'empty';
      baselineReason = 'no confirmed domainAllowlist or requirement business-domain document';
    }
  }
  return {
    required: Boolean(knowledgeContext) || agent === 'specflow-specify',
    decisionCardFormat: '任务意图 | 采用规则(<=3) | 忽略规则及理由',
    logRequirement:
      'Ready-for-QA 或 QA Evidence 中必须回填 Knowledge Rules Used',
    baselineStatus,
    baselineReason,
    domainAllowlist: allowlist,
    requirementId,
  };
}

function renderSpecifyKnowledgeBaselineNotice(policy) {
  if (!policy || policy.baselineStatus === 'confirmed') return '';
  if (policy.baselineStatus === 'skipped') {
    return [
      '【Knowledge Baseline】',
      '用户已选择跳过业务知识库初始化。Specify 阶段不得把存量业务规则写成强结论；凡依赖线上规则、权限、状态流转、历史行为的判断，必须按 PRD 明文或用户澄清处理。',
    ].join('\n');
  }
  if (policy.baselineStatus === 'empty') {
    return [
      '【Knowledge Baseline】',
      '当前没有已确认业务领域或需求级业务知识库。Specify 阶段必须保守处理：不得将“应确认”误写为“直接决策”；凡依赖存量业务规则、权限、状态流转、历史行为的判断，必须生成澄清或标为候选线索。',
    ].join('\n');
  }
  return '';
}


module.exports = {
  DRAFT_CHUNK_CHAR_BUDGET,
  STATUS_BANNER,
  STATUS_RANK,
  autoResolveClarificationsWithEvidence,
  buildCodeStyleSlice,
  buildKnowledgeContext,
  buildKnowledgePolicy,
  collectGlobalDomainKeys,
  getKnowledgeDomainAllowlist,
  inferInitDomainSlugs,
  listDomainDocs,
  listRequirementDomainSlugs,
  readDomainStatus,
  readGlobalDomainKnowledge,
  readRequirementDomainDocs,
  readRequirementHintText,
  renderLocalPatchSection,
  renderSpecifyKnowledgeBaselineNotice,
  resolveRequirementDomainDir,
  selectRelevantDomains,
  tokenizeText,
};
