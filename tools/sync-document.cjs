/**
 * 需求变更同步：原子化更新 specify/plan 对应章节，并自动重置受影响任务的状态为 [ ] (Pending)，
 * 使 specflow-engine 在下次运行时自动调度 Implement 子代理重新编码。
 * 每次变更写入文档末尾的「修改日志 (Changelog)」章节，确保可追溯。
 *
 * 用法:
 *   统一:
 *   PLUGIN_ROOT=/path/to/specflow node "$PLUGIN_ROOT/tools/sync-document.cjs" [workspaceRoot] <需求号> <payload> [--target specify|plan|both] [--change-type patch|refactor|conflict]
 *   [--updates '<json>']  可选，章节级结构化更新，见下方 Updates 格式
 *   [--updates-file <path>] 可选，从文件读取 --updates JSON
 *
 * Updates JSON 格式（与具体需求无关）:
 *   { "specify": [ { "section": "2|4|5", "action": "append|replace", "anchor": "可选，匹配要替换的片段", "content": "新内容" } ],
 *     "plan": [ { "block": "F-01", "field": "Design|Contract|Verification", "action": "append|replace", "anchor": "可选", "content": "新内容" } ] }
 *   section: 2=业务实体 4=业务状态/AC 5=非功能边界。若 specify.md 仍为 Draft（仅 Section 1-3），则 section 4/5 的更新会静默跳过；block 为 F-xx；field 为 plan 内该 block 的字段。
 *   replace 且带 anchor 时：用 content 替换「包含 anchor 的那一行」；content 若需保留字段标题请写全（如 "- **Design (方案)**: ..."）。
 *
 * 输出: JSON 到 stdout
 *   成功: { ok, updated, reset_tasks, impacted_features, updated_sections }
 *   失败: { ok: false, error }
 */

const fs = require('fs');
const path = require('path');
const {
  extractCodingStandardPatchesFromPlan,
  writeRequirementCodeStyleArtifacts,
} = require('./code-style.cjs');

const UTF8 = 'utf-8';

function parseArgs() {
  const { parseCliArgs, resolveWorkspace, resolveRequirementId } = require('./cli-args.cjs');
  const { named, boolFlags, positional } = parseCliArgs(process.argv.slice(2));

  const workspaceRoot = resolveWorkspace(named, positional, 0);
  const requirementId = resolveRequirementId(named, positional, 1);
  const payload       = named['payload'] || positional[2] || '';

  const target        = named['target']         || 'both';
  const changeType    = named['change-type']    || named['changeType']    || 'patch';
  const mergeStrategy = named['merge-strategy'] || named['mergeStrategy'] || 'append';
  const updatesJson   = named['updates']        || null;
  const updatesFilePath = named['updates-file'] || named['updatesFile']   || null;
  const extract       = boolFlags.has('extract');

  return { workspaceRoot, requirementId, payload, target, changeType, mergeStrategy, updatesJson, updatesFilePath, extract };
}

function safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, UTF8);
  } catch {
    return null;
  }
}

function appendChangelog(content, changeType, payload, mergeStrategy = 'append') {
  const date = new Date().toISOString().split('T')[0];
  const logEntry = `- **${date}** [${changeType}] ${payload.replace(/\n/g, ' ')}`;
  if (mergeStrategy === 'append_unique' && content.includes(logEntry)) {
    return content;
  }
  
  // 兼容多种标题格式：## 6. 修改日志 / ## 4. 修改日志 / ## Changelog
  const changelogRegex = /^(## (?:\d+\.\s*)?(?:修改日志|Changelog).*)/m;
  const match = content.match(changelogRegex);
  
  if (match) {
    const pos = match.index + match[0].length;
    return content.slice(0, pos) + `\n${logEntry}` + content.slice(pos);
  }
  return content + `\n\n## Changelog (修改日志)\n\n${logEntry}\n`;
}

function applySpecifyUpdates(content, updates) {
  if (!updates || !Array.isArray(updates)) return content;
  
  let newContent = content;
  for (const up of updates) {
    if (!up.section || !up.content) continue;
    // 简易定位：## [section].
    const sectionRegex = new RegExp(`## ${up.section}\\..*`, 'i');
    const match = newContent.match(sectionRegex);
    if (!match) continue; // 没找到章节

    const sectionStart = match.index;
    const nextSectionIndex = newContent.indexOf('\n## ', sectionStart + 5);
    const sectionEnd = nextSectionIndex > 0 ? nextSectionIndex : newContent.length;
    const sectionBody = newContent.slice(sectionStart, sectionEnd);

    let newSectionBody = sectionBody;
    
    if (up.action === 'append') {
      newSectionBody += `\n${up.content}`;
    } else if (up.action === 'replace') {
      if (up.anchor) {
        // 按行替换包含 anchor 的行
        const lines = sectionBody.split('\n');
        const newLines = lines.map(line => line.includes(up.anchor) ? up.content : line);
        newSectionBody = newLines.join('\n');
      } else {
        // 整个章节内容追加（暂不支持全章节替换，防止误删）
        newSectionBody += `\n${up.content}`; 
      }
    }

    newContent = newContent.slice(0, sectionStart) + newSectionBody + newContent.slice(sectionEnd);
  }
  return newContent;
}

function applyPlanUpdates(content, updates) {
  if (!updates || !Array.isArray(updates)) return content;

  let newContent = content;
  for (const up of updates) {
    if (!up.block || !up.field || !up.content) continue;
    
    // 定位 Block: ### [F-xx] 或 ### F-xx
    const blockRegex = new RegExp(`### .*${up.block}.*`, 'i');
    const blockMatch = newContent.match(blockRegex);
    if (!blockMatch) continue;

    const blockStart = blockMatch.index;
    const nextBlockIndex = newContent.indexOf('\n### ', blockStart + 5);
    const blockEnd = nextBlockIndex > 0 ? nextBlockIndex : newContent.length;
    const blockBody = newContent.slice(blockStart, blockEnd);

    // 定位 Field: - **Field**:
    const fieldRegex = new RegExp(`- \\*\\*${up.field}.*\\*\\*:`, 'i');
    const fieldMatch = blockBody.match(fieldRegex);
    
    let newBlockBody = blockBody;

    if (fieldMatch) {
      const fieldStart = fieldMatch.index;
      // 找下一个字段 - ** 或 Block 结束
      const nextFieldMatch = blockBody.slice(fieldStart + 5).match(/\n- \*\*/);
      const fieldEnd = nextFieldMatch ? (fieldStart + 5 + nextFieldMatch.index) : blockBody.length;
      
      const fieldFull = blockBody.slice(fieldStart, fieldEnd);
      
      let newFieldFull = fieldFull;
      if (up.action === 'append') {
        const line = `  ${up.content}`; // 简单缩进
        if (!newFieldFull.includes(line)) newFieldFull += `\n${line}`;
      } else if (up.action === 'replace') {
        if (up.anchor) {
           const lines = fieldFull.split('\n');
           // 排除第一行（标题）
           const newLines = lines.map((line, idx) => (idx > 0 && line.includes(up.anchor)) ? `  ${up.content}` : line);
           newFieldFull = newLines.join('\n');
        } else {
           // 替换整个字段值，保留标题
           const titleLine = fieldFull.split('\n')[0];
           newFieldFull = `${titleLine}\n  ${up.content}`;
        }
      }
      
      newBlockBody = blockBody.slice(0, fieldStart) + newFieldFull + blockBody.slice(fieldEnd);
    } else {
      // 字段不存在，追加在 block 末尾
      const line = `- **${up.field}**: ${up.content}`;
      if (!newBlockBody.includes(line)) newBlockBody += `\n${line}`;
    }

    newContent = newContent.slice(0, blockStart) + newBlockBody + newContent.slice(blockEnd);
  }
  return newContent;
}

function extractKnowledgePatchesFromSpecify(specifyContent) {
  const patches = [];
  if (!specifyContent) return patches;

  const re =
    /###\s+\[Resolved\]\s*(CQ[^\n:]*?)\s*[:：]\s*([^\n]*)\n([\s\S]*?)(?=\n###\s+\[(?:Resolved|\?)\]|\n##\s+|$)/g;
  let m;
  while ((m = re.exec(specifyContent)) !== null) {
    const cqId = (m[1] || '').trim();
    const title = (m[2] || '').trim();
    const body = (m[3] || '').trim();
    if (!cqId && !title && !body) continue;
    patches.push({
      type: 'clarification',
      cqId,
      title,
      content: body.replace(/\n{2,}/g, '\n').trim(),
      extractedAt: new Date().toISOString(),
    });
  }
  return patches;
}

/**
 * 根据受影响的 Feature ID，重置 plan.md Roadmap 中关联任务的状态为 [ ] (Pending)。
 * 任务行格式: - [x] **T-A1** | 描述... | F-01, F-02
 * @param {string} content plan.md 完整内容
 * @param {string[]} impactedFeatures 受影响的 Feature ID 列表 (如 ['F-01'])
 * @returns {{ content: string, resetTasks: string[] }}
 */
function resetRoadmapTasks(content, impactedFeatures) {
  if (!impactedFeatures || impactedFeatures.length === 0) return { content, resetTasks: [] };

  const featureSet = new Set(impactedFeatures.map(f => f.toUpperCase()));
  const resetTasks = [];

  const newContent = content.replace(
    /^(\s*-\s+)\[([x?!])\](\s+\*\*(\S+)\*\*.*)$/gm,
    (match, prefix, marker, rest, taskId) => {
      const featureRefs = [];
      const fidRegex = /F-\d+/gi;
      let m;
      while ((m = fidRegex.exec(rest)) !== null) {
        featureRefs.push(m[0].toUpperCase());
      }
      if (featureRefs.some(fid => featureSet.has(fid))) {
        resetTasks.push(taskId);
        return `${prefix}[ ]${rest}`;
      }
      return match;
    }
  );

  return { content: newContent, resetTasks };
}

function main() {
  const { workspaceRoot, requirementId, payload, target, changeType, mergeStrategy, updatesJson, updatesFilePath, extract } =
    parseArgs();

  if (!requirementId) {
    console.log(JSON.stringify({ ok: false, error: '缺少参数: 需求号' }));
    process.exit(1);
  }

  const aiDocs = path.join(workspaceRoot, 'ai-docs', requirementId);
  const specifyPath = path.join(aiDocs, 'specify.md');
  const planPath = path.join(aiDocs, 'plan.md');
  const tempDir = path.join(aiDocs, '.temp');

  if (!fs.existsSync(aiDocs)) {
    console.log(JSON.stringify({ ok: false, error: `需求目录不存在: ${aiDocs}` }));
    process.exit(1);
  }

  // 解析 Updates
  let structuredUpdates = { specify: [], plan: [] };
  if (updatesFilePath && fs.existsSync(updatesFilePath)) {
    try {
      structuredUpdates = JSON.parse(fs.readFileSync(updatesFilePath, UTF8));
    } catch {}
  } else if (updatesJson) {
    try {
      structuredUpdates = JSON.parse(updatesJson);
    } catch {}
  }

  const result = {
    ok: true,
    updated: [],
    updated_sections: [],
    impacted_features: [],
    reset_tasks: [],
    extracted: false,
  };

  // 1. Update Specify
  if ((target === 'specify' || target === 'both') && fs.existsSync(specifyPath)) {
    let content = safeReadFile(specifyPath);
    if (content) {
      content = applySpecifyUpdates(content, structuredUpdates.specify);
      content = appendChangelog(content, changeType, payload, mergeStrategy);
      fs.writeFileSync(specifyPath, content, UTF8);
      result.updated.push('specify.md');
      
      if (structuredUpdates.specify && structuredUpdates.specify.length > 0) {
        result.updated_sections = structuredUpdates.specify.map(u => u.section);
      }
    }
  }

  if (extract && fs.existsSync(specifyPath)) {
    const specifyContent = safeReadFile(specifyPath);
    const patches = extractKnowledgePatchesFromSpecify(specifyContent);
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'knowledge-patch.json'), JSON.stringify(patches, null, 2), UTF8);
    result.extracted = true;
    result.extracted_count = patches.length;
  }

  // 2. Update Plan & Reset Impacted Tasks
  if ((target === 'plan' || target === 'both') && fs.existsSync(planPath)) {
    let content = safeReadFile(planPath);
    if (content) {
      content = applyPlanUpdates(content, structuredUpdates.plan);

      const impactedFeatures = (structuredUpdates.plan || [])
        .map(u => u.block)
        .filter(Boolean);

      if (impactedFeatures.length > 0) {
        const { content: resetContent, resetTasks } = resetRoadmapTasks(content, impactedFeatures);
        content = resetContent;
        result.reset_tasks = resetTasks;
        result.impacted_features = impactedFeatures;
      }

      content = appendChangelog(content, changeType, payload, mergeStrategy);
      fs.writeFileSync(planPath, content, UTF8);
      result.updated.push('plan.md');

      if (extract) {
        const codingPatches = extractCodingStandardPatchesFromPlan(content);
        const codeStyleArtifacts = writeRequirementCodeStyleArtifacts(
          workspaceRoot,
          requirementId,
          content,
          { mergePatch: true }
        );
        result.extracted = true;
        result.extracted_code_style_count = codingPatches.length;
        result.requirement_code_style = {
          md: codeStyleArtifacts.requirementCodeStylePath
            ? path.relative(workspaceRoot, codeStyleArtifacts.requirementCodeStylePath)
            : null,
          patch: codeStyleArtifacts.patchPath
            ? path.relative(workspaceRoot, codeStyleArtifacts.patchPath)
            : null,
          reused_from_global: codeStyleArtifacts.reusedFromGlobalCount || 0,
          additions: codeStyleArtifacts.additionsCount || 0,
        };
      }
    }
  }

  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}
