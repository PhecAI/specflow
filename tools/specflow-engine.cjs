/**
 * Specflow 工作流引擎：根据 ai-docs 物理状态判定当前环节与门禁是否通过。
 * 需求号：以用户提供为准；未提供则取当前 Git 分支名（取最后一段，如 feature/1419 → 1419），不要求纯数字。
 * 用法（统一）: PLUGIN_ROOT=/path/to/specflow node "$PLUGIN_ROOT/tools/specflow-engine.cjs" [workspaceRoot] [需求号]
 * 输出: JSON 到 stdout
 */

const child_process = require('child_process');
const fs = require('fs');
const path = require('path');
const { readState, normalizeDomainInitRef, domainRefToFileStem, domainRefSlug } = require('./specflow-state.cjs');
const {
  readGates,
  passGate,
  resetGate,
  gatePassed,
  fileSnapshot,
  getGate,
  snapshotsEqual,
} = require('./gates.cjs');
const {
  parseMarkdownTree,
  parseGroupsFromTree,
  deriveRoadmapStats,
  parseClarificationFromTree,
  findInlineClarificationMarkers,
  isSpecifyCompleteFromTree,
  buildFocusPlanFromTree,
  buildFocusSpecify,
  buildFocusArchive,
  SECTION_REGISTRY,
  findSectionByAnchor,
  findByKey,
  renderNode,
} = require('./plan-parser.cjs');
const {
  UTF8,
  clearPendingProtocol,
  getFileMtimeMs,
  getLastModified,
  getRecentRequirementIds,
  safeReadFile,
} = require('./engine-io.cjs');
const {
  autoResolveClarificationsWithEvidence,
  buildKnowledgeContext,
  buildKnowledgePolicy,
  getKnowledgeDomainAllowlist,
  renderSpecifyKnowledgeBaselineNotice,
} = require('./engine-knowledge.cjs');
const {
  detectTechnicalClarificationDebt,
  mergeClarificationStates,
  parseTempClarifications,
} = require('./engine-clarify.cjs');
const {
  buildSpecifyKnowledgeHint,
  countBlockers,
  detectPhase,
  dispatchArrayItems,
  isArchiveAnchorAllowed,
  syncArtifactGate,
} = require('./engine-gates.cjs');
const { determineAction } = require("./engine-action.cjs");
const {
  analyzeParallelGroupActions,
} = require('./engine-implement.cjs');

const SPECIFY_KEYS = [
  'overview',
  'productDecisions',
  'capabilities',
  'businessObjects',
  'clarificationLog',
  'changelog',
];
const PLAN_KEYS = [
  'architecture',
  'roadmap',
];

function ensureInitGlobalAssets(workspaceRoot, requirementDir) {
  if (!workspaceRoot || !requirementDir || !fs.existsSync(requirementDir)) {
    return { ok: false, skipped: true }
  }
  try {
    const { runInventoryScan } = require('./inventory-scan.cjs')
    const result = runInventoryScan(workspaceRoot)
    if (result && result.ok) {
      const { isArchitectureLayersCalibrated, isGlobalCodeStylePopulated } = require('./code-style.cjs')
      passGate(requirementDir, 'init.global_assets', {
        stage: 'Init',
        scope: 'global',
        subject: 'ai-docs/global-assets',
        evidence: [
          result.globalAssetsDir,
          result.codeStylePath,
        ].filter(Boolean),
      })
      if (isArchitectureLayersCalibrated(workspaceRoot)) {
        passGate(requirementDir, 'init.architecture_layers', {
          stage: 'Init',
          scope: 'global',
          subject: 'ai-docs/global-assets/standards/architecture-layers.md',
          evidence: 'architecture-layers.md ## Layers section',
        })
      } else {
        resetGate(requirementDir, 'init.architecture_layers', {
          stage: 'Init',
          scope: 'global',
          subject: 'ai-docs/global-assets/standards/code-style.md',
          reason: 'architecture layers require agent calibration',
        })
      }
      if (isGlobalCodeStylePopulated(workspaceRoot)) {
        passGate(requirementDir, 'init.code_style', {
          stage: 'Init',
          scope: 'global',
          subject: 'ai-docs/global-assets/standards/code-style.md',
          evidence: 'code-style.md has rules or SOPs',
        })
      } else {
        resetGate(requirementDir, 'init.code_style', {
          stage: 'Init',
          scope: 'global',
          subject: 'ai-docs/global-assets/standards/code-style.md',
          reason: 'code-style.md has no rules or SOPs yet',
        })
      }
    }
    return result || { ok: true }
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) }
  }
}

function autoFixAnchors(tree, filePath, targetKeys) {
  if (!tree) return [];
  const fixed = [];
  let dirty = false;

  for (const key of targetKeys) {
    const cfg = SECTION_REGISTRY[key];
    if (!cfg) continue;

    // 1. 已经有锚点 -> 跳过
    const sectionByAnchor = findSectionByAnchor(tree, cfg.anchor);
    if (sectionByAnchor) continue;

    // 2. 无锚点，尝试正则兜底
    const section = findByKey(tree, key);
    if (section) {
      // 找到了 Section 但没锚点 -> 修复
      const anchorComment = `<!-- specflow:section=${cfg.anchor} -->`;
      // 检查 content 是否已有（防止重复）
      if (!section.content.some((line) => line.includes(cfg.anchor))) {
        // 插入空行和注释
        section.content.unshift('', anchorComment);
        fixed.push(cfg.anchor);
        dirty = true;
      }
    }
  }

  if (dirty) {
    try {
      // renderNode 会基于 tree 重新生成 markdown
      const newContent = renderNode(tree);
      fs.writeFileSync(filePath, newContent, UTF8);
    } catch (e) {
      // ignore write error
    }
  }
  return fixed;
}

/**
 * 需求号未解析或需确认时：统一返回 interaction_required，供编排层用 AskQuestion。
 * - **init_requirement_id**（可选）：至多 2 个单选候选需求号。
 * - **init_requirement_text**（必有）：手动输入，`responseType: 'text'` 提示客户端渲染**输入框**（Cursor 若忽略扩展字段，则按文案在聊天中收集文本）。
 * @param {'conflict'|'empty'|'suggested_new'} kind
 */
function buildInitRequirementInteraction({
  kind,
  branch_id,
  recent_ids,
  suggestedId,
  message,
}) {
  const recentIds = Array.isArray(recent_ids) ? recent_ids : [];
  const pickedIds = [];
  const seen = new Set();
  function pushId(id) {
    if (id === undefined || id === null || String(id).trim() === '') return;
    const key = String(id);
    if (seen.has(key)) return;
    seen.add(key);
    pickedIds.push(key);
  }

  if (kind === 'conflict') {
    pushId(branch_id);
    pushId(recentIds[0]);
  } else if (kind === 'suggested_new') {
    pushId(suggestedId);
    pushId(branch_id);
    for (const rid of recentIds) {
      if (pickedIds.length >= 2) break;
      pushId(rid);
    }
  } else {
    for (const rid of recentIds) {
      if (pickedIds.length >= 2) break;
      pushId(rid);
    }
  }

  const two = pickedIds.slice(0, 2);
  const choiceOptions = two.map((id) => ({ id, label: String(id) }));

  const questions = [];
  if (choiceOptions.length > 0) {
    let choicePrompt =
      message && String(message).trim() ? String(message).trim() : '';
    if (!choicePrompt) {
      if (kind === 'conflict') {
        const latest = recentIds[0] || '—';
        choicePrompt = `分支 ${branch_id} · 近期 ${latest}`;
      } else if (kind === 'suggested_new' && suggestedId) {
        choicePrompt = `建议 ${suggestedId}`;
      } else {
        choicePrompt = '候选需求号';
      }
    }
    questions.push({
      id: 'init_requirement_id',
      prompt: choicePrompt,
      allow_multiple: false,
      options: choiceOptions,
    });
  }

  let textPrompt;
  if (choiceOptions.length > 0) {
    textPrompt = '其他（非空则优先于上项）';
  } else if (kind === 'empty') {
    textPrompt = '输入需求号';
  } else {
    textPrompt = '输入需求号';
  }

  questions.push({
    id: 'init_requirement_text',
    prompt: textPrompt,
    allow_multiple: false,
    responseType: 'text',
    placeholder: '需求号',
    options: [],
  });

  return {
    type: 'interaction_required',
    reason: '未提供需求号',
    questions,
    init_context: {
      kind,
      branch_id: branch_id || null,
      recent_ids: recentIds,
      suggestedId: suggestedId || null,
    },
  };
}

// parseClarification / isSpecifyComplete 已迁移至 plan-parser.cjs（AST + 锚点解析）

function runEngineInner(workspaceRoot, requirementId) {
  const aiDocs = path.join(workspaceRoot, 'ai-docs');
  const historyDir = path.join(aiDocs, 'history');
  const resolveDir = (id) => {
    const inRoot = path.join(aiDocs, id);
    if (fs.existsSync(inRoot) && fs.statSync(inRoot).isDirectory())
      return { dir: inRoot, inHistory: false };
    if (fs.existsSync(historyDir)) {
      for (const year of fs.readdirSync(historyDir)) {
        const yearPath = path.join(historyDir, year);
        if (!fs.statSync(yearPath).isDirectory()) continue;
        for (const quarter of fs.readdirSync(yearPath)) {
          const qPath = path.join(yearPath, quarter);
          if (!fs.statSync(qPath).isDirectory()) continue;
          const idPath = path.join(qPath, id);
          if (fs.existsSync(idPath) && fs.statSync(idPath).isDirectory())
            return { dir: idPath, inHistory: true };
        }
      }
    }
    return { dir: '', inHistory: false };
  };

  let dir = '';
  let inHistory = false;
  let id = requirementId;
  const idFromUser = requirementId != null && requirementId !== '';

  if (!id) {
    // 1. Git 分支检测
    let gitId = null;
    try {
      const branch = child_process
        .execSync('git rev-parse --abbrev-ref HEAD', {
          encoding: UTF8,
          cwd: workspaceRoot,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        .trim();
      const name = branch.split('/').pop() || branch;
      // 忽略非需求分支
      if (
        ![
          'main',
          'master',
          'dev',
          'develop',
          'staging',
          'test',
          'head',
        ].includes(name.toLowerCase())
      ) {
        gitId = name;
      }
    } catch {}

    // 2. 活跃需求检测 (ai-docs 最近修改)；冲突/init 时近期列表取 INIT_RECENT_LIMIT 条
    const INIT_RECENT_LIMIT = 5;
    const recentIds = getRecentRequirementIds(aiDocs, 1);
    const latestId = recentIds.length > 0 ? recentIds[0] : null;
    const recentIdsForInit = getRecentRequirementIds(aiDocs, INIT_RECENT_LIMIT);

    // 3. 冲突检测：若 Git 分支与最近修改不一致，且都存在 -> init 询问
    if (gitId && latestId && gitId !== latestId) {
      return {
        requirementId: null,
        phase: 'Specify',
        suggestedAction: buildInitRequirementInteraction({
          kind: 'conflict',
          branch_id: gitId,
          recent_ids: recentIdsForInit,
        }),
        pathSpecify: null,
        pathPlan: null,
        pathDir: null,
        inHistory: false,
        gates: defaultGates('Specify'),
      };
    }

    // 4. 自动锁定：Git 优先，其次活跃 ID
    id = gitId || latestId;

    // 5. 仍未找到 -> init
    if (!id) {
      return {
        requirementId: null,
        phase: 'Specify',
        suggestedAction: buildInitRequirementInteraction({
          kind: 'empty',
          branch_id: null,
          recent_ids: recentIdsForInit,
        }),
        pathSpecify: null,
        pathPlan: null,
        pathDir: null,
        inHistory: false,
        gates: defaultGates('Specify'),
      };
    }

    // 6. 新需求：推断出的 ID 对应目录不存在时，必须用户确认需求号后再创建文档
    const inferredResolve = resolveDir(id);
    if (!inferredResolve.dir) {
      return {
        requirementId: null,
        phase: 'Specify',
        suggestedAction: buildInitRequirementInteraction({
          kind: 'suggested_new',
          branch_id: gitId || null,
          recent_ids: recentIdsForInit,
          suggestedId: id,
          message: `检测到疑似新需求，建议需求号：**${id}**。请确认需求号后再生成文档（回复需求号或「确认 ${id}」）。`,
        }),
        pathSpecify: null,
        pathPlan: null,
        pathDir: null,
        inHistory: false,
        gates: defaultGates('Specify'),
      };
    }
    dir = inferredResolve.dir;
    inHistory = inferredResolve.inHistory;
  }

  if (id && !dir) {
    const r = resolveDir(id);
    dir = r.dir;
    inHistory = r.inHistory;

    // 用户已提供需求号且目录不存在：视为新需求已确认，创建目录后继续
    if (!dir && idFromUser) {
      const newDir = path.join(aiDocs, id);
      try {
        fs.mkdirSync(newDir, { recursive: true });
        dir = newDir;
        inHistory = false;
      } catch (e) {
        return {
          requirementId: id,
          phase: 'Specify',
          suggestedAction: {
            type: 'block',
            reason: `无法创建目录 ai-docs/${id}：${e.message}`,
          },
          pathSpecify: null,
          pathPlan: null,
          pathDir: null,
          inHistory: false,
          gates: defaultGates('Specify'),
        };
      }
    }
  }

  if (!dir) {
    return {
      requirementId: id,
      phase: 'Specify',
      suggestedAction: { type: 'block', reason: `未找到需求号 ${id} 对应目录` },
      pathSpecify: null,
      pathPlan: null,
      pathDir: null,
      inHistory: false,
      gates: defaultGates('Specify'),
      error: `未找到需求号 ${id} 对应目录（ai-docs/${id} 或 history 下）`,
    };
  }

  if (!inHistory) {
    const initResult = ensureInitGlobalAssets(workspaceRoot, dir);
    if (initResult && initResult.ok === false && !initResult.skipped) {
      return {
        requirementId: id,
        phase: 'Init',
        suggestedAction: {
          type: 'block',
          reason: `初始化全局资产失败：${initResult.error || 'unknown error'}`,
        },
        pathSpecify: null,
        pathPlan: null,
        pathDir: dir,
        inHistory: false,
        gates: defaultGates('Init'),
      };
    }
  }

  // 资源读取失败映射门禁：.temp/resource-load-failed.json 为 { "<url>": { "reason", "message" }, ... }，有任意 key 即 block
  const resourceLoadFailedPath = path.join(
    dir,
    '.temp',
    'resource-load-failed.json',
  );
  if (fs.existsSync(resourceLoadFailedPath)) {
    try {
      const mapping = JSON.parse(fs.readFileSync(resourceLoadFailedPath, UTF8));
      const entries =
        typeof mapping === 'object' && mapping !== null
          ? Object.entries(mapping)
          : [];
      if (entries.length > 0) {
        const first = entries[0];
        const firstMsg =
          first[1]?.message ||
          first[1]?.reason ||
          '需求文档链接无法读取，请检查 MCP/权限或粘贴正文后重试。';
        const reason =
          entries.length === 1
            ? firstMsg
            : `${firstMsg}（共 ${entries.length} 条链接未就绪）`;
        return {
          requirementId: id,
          phase: 'Specify',
          suggestedAction: { type: 'block', reason },
          pathSpecify: null,
          pathPlan: null,
          pathDir: dir,
          inHistory: false,
          gates: defaultGates('Specify'),
        };
      }
    } catch (_) {
      // 文件损坏时删除并继续
      try {
        fs.unlinkSync(resourceLoadFailedPath);
      } catch (_) {}
    }
  }

  const pathSpecify = path.join(dir, 'specify.md');
  const pathPlan = path.join(dir, 'plan.md');
  let specifyContent = safeReadFile(pathSpecify);
  const planContent = safeReadFile(pathPlan);
  const hasSpecify = !!specifyContent;
  const hasPlan = !!planContent;

  // 需求级规范产物只在 plan 存在后生成：
  // plan 生成阶段参考 architecture-layers 分层画像与全局 code-style 规则；
  // 需求内 code-style 仅承载本需求发现的 Additions/Overrides，供归档合并。
  if (!inHistory && hasPlan) {
    try {
      const {
        writeRequirementCodeStyleArtifacts,
      } = require('./code-style.cjs');
      writeRequirementCodeStyleArtifacts(workspaceRoot, id, planContent || '', {
        mergePatch: true,
      });
    } catch (_) {
      // 规范文件生成失败不阻断引擎主流程
    }
  }

  const blockerInSpecify = specifyContent ? countBlockers(specifyContent) : 0;
  const blockerInPlan = planContent ? countBlockers(planContent) : 0;

  // AST 解析：一次构建树，复用于门禁检测 / Groups / Roadmap / Focus 构建
  // EBA: evidence-based auto-clarification（严格证据）
  if (specifyContent && specifyContent.includes('### [?]')) {
    const r = autoResolveClarificationsWithEvidence(
      workspaceRoot,
      id,
      pathSpecify,
      specifyContent,
    );
    if (r.changed) {
      // 重新读取，确保后续 gates/mtime 对齐
      specifyContent = safeReadFile(pathSpecify);
    }
  }

  const specifyTree = specifyContent ? parseMarkdownTree(specifyContent) : null;
  const planTree = planContent ? parseMarkdownTree(planContent) : null;

  // 自检并修复锚点
  if (hasSpecify && specifyTree) {
    const fixed = autoFixAnchors(specifyTree, pathSpecify, SPECIFY_KEYS);
    if (fixed.length > 0) {
      console.error(
        `[SpecFlow] Warning: Fixed missing anchors in specify.md: ${fixed.join(', ')}`,
      );
    }
  }
  if (hasPlan && planTree) {
    const fixed = autoFixAnchors(planTree, pathPlan, PLAN_KEYS);
    if (fixed.length > 0) {
      console.error(
        `[SpecFlow] Warning: Fixed missing anchors in plan.md: ${fixed.join(', ')}`,
      );
    }
  }

  // 读取 state 与 mtime（供 EBA/门禁计算使用）
  const state = readState(dir);
  const activeGroupId = state.activeGroup;
  const specifyMtimeNow = hasSpecify ? getFileMtimeMs(pathSpecify) : 0;

  const markdownClarification = specifyTree
    ? parseClarificationFromTree(specifyTree, specifyContent || '')
    : { open: false, openCount: 0, questions: [], questionsAll: [] };
  const tempClarificationPath = path.join(dir, '.temp', 'clarifications.json');
  const tempClarification = parseTempClarifications(tempClarificationPath);
  const clarification = mergeClarificationStates(
    markdownClarification,
    tempClarification,
  );
  const inlineClarificationDebt = specifyContent
    ? findInlineClarificationMarkers(specifyContent)
    : { count: 0, items: [] };
  const technicalClarificationDebt = detectTechnicalClarificationDebt(specifyContent);

  // EBA：自动澄清审阅门禁。存在 [Auto] 且未 ack 时，视为仍需确认（阻止阶段推进）
  const autoAckMtime =
    typeof state.autoClarificationAckMtime === 'number' &&
    Number.isFinite(state.autoClarificationAckMtime)
      ? state.autoClarificationAckMtime
      : 0;
  const hasAutoClarifications =
    typeof specifyContent === 'string'
      ? /###\s+\[Auto\]\s*CQ/i.test(specifyContent)
      : false;
  const autoClarificationNeedsReview =
    hasAutoClarifications &&
    specifyMtimeNow > 0 &&
    specifyMtimeNow !== autoAckMtime;

  const specifyComplete = specifyTree
    ? isSpecifyCompleteFromTree(specifyTree) &&
      !clarification.open &&
      inlineClarificationDebt.count === 0 &&
      !autoClarificationNeedsReview
    : false;
  const productClarificationClosed =
    hasSpecify &&
    blockerInSpecify === 0 &&
    !clarification.open &&
    inlineClarificationDebt.count === 0 &&
    !autoClarificationNeedsReview;

  if (specifyComplete && fs.existsSync(tempClarificationPath)) {
    try {
      fs.unlinkSync(tempClarificationPath);
    } catch (_) {
      // 清理失败不阻断引擎主流程；下一轮仍会按文件状态重算。
    }
  }
  const groups = planTree ? parseGroupsFromTree(planTree) : [];
  const roadmap = planTree
    ? deriveRoadmapStats(planTree, groups)
    : { pending: 0, readyForQA: 0, failed: 0, completed: 0, hasBlocked: false };

  // 进入 Plan 门禁：无 Blocker + 无未闭合澄清 + 文档完整
  const canProceedToPlan =
    blockerInSpecify === 0 &&
    !clarification.open &&
    inlineClarificationDebt.count === 0 &&
    specifyComplete;
  const canProceedToImplement =
    hasPlan &&
    blockerInPlan === 0 &&
    (roadmap.pending > 0 ||
      roadmap.readyForQA > 0 ||
      roadmap.failed > 0 ||
      roadmap.completed > 0);
  const canProceedToArchive =
    hasPlan &&
    roadmap.pending === 0 &&
    roadmap.readyForQA === 0 &&
    roadmap.failed === 0 &&
    roadmap.completed > 0;

  // specify.md 在锚点自检写入后取 mtime，与 manage-state ack-specify-review / ack-specify-before-plan / ack-auto-clarifications 对齐
  const specifyReviewStatus =
    state.specifyReviewStatus === 'ready' || state.specifyReviewStatus === 'blocked'
      ? state.specifyReviewStatus
      : null;
  const specifyReviewMtimeStored =
    typeof state.specifyReviewMtime === 'number' &&
    Number.isFinite(state.specifyReviewMtime)
      ? state.specifyReviewMtime
      : null;
  const specifyReviewPassedMtimeStored =
    typeof state.specifyReviewPassedMtime === 'number' &&
    Number.isFinite(state.specifyReviewPassedMtime)
      ? state.specifyReviewPassedMtime
      : null;
  const specifyReviewValid =
    hasSpecify &&
    specifyMtimeNow > 0 &&
    specifyReviewStatus === 'ready' &&
    specifyReviewMtimeStored != null &&
    specifyMtimeNow === specifyReviewMtimeStored &&
    specifyReviewPassedMtimeStored != null &&
    specifyMtimeNow === specifyReviewPassedMtimeStored;
  const gateRegistry = readGates(dir);
  const {
    isArchitectureLayersCalibrated,
    isGlobalCodeStylePopulated,
    buildCodeStyleSyncSnapshot,
  } = require('./code-style.cjs');
  const architectureLayersReady =
    gatePassed(gateRegistry, 'init.architecture_layers') &&
    isArchitectureLayersCalibrated(workspaceRoot);
  const codeStyleReady =
    architectureLayersReady &&
    gatePassed(gateRegistry, 'init.code_style') &&
    isGlobalCodeStylePopulated(workspaceRoot);
  const specifySnapshot = fileSnapshot(
    workspaceRoot,
    path.join('ai-docs', id, 'specify.md'),
  );
  const planSnapshot = fileSnapshot(
    workspaceRoot,
    path.join('ai-docs', id, 'plan.md'),
  );
  const codeStyleSnapshot = buildCodeStyleSyncSnapshot(planContent || '');
  const codeStyleSynced =
    hasPlan &&
    gatePassed(gateRegistry, 'plan.code_style_synced', { snapshot: codeStyleSnapshot });
  syncArtifactGate(
    dir,
    gateRegistry,
    'specify.product_clarification',
    productClarificationClosed,
    null,
    'product clarifications closed',
  );
  const productClarificationGateValid =
    hasSpecify && gatePassed(gateRegistry, 'specify.product_clarification');
  const specifyPreviewGateValid =
    gatePassed(gateRegistry, 'specify.product_preview');
  const specifyPreviewGate = getGate(gateRegistry, 'specify.product_preview');
  const specifyPreviewGateBlocked =
    specifyPreviewGate && specifyPreviewGate.status === 'blocked';
  syncArtifactGate(
    dir,
    gateRegistry,
    'specify.document_ready',
    specifyComplete,
    specifySnapshot,
    'specify.md complete and clarifications closed',
  );
  const specifyDocumentReadyGateValid =
    hasSpecify &&
    gatePassed(gateRegistry, 'specify.document_ready', {
      snapshot: specifySnapshot,
    });
  const planDocumentCandidateReady = hasPlan;
  syncArtifactGate(
    dir,
    gateRegistry,
    'plan.document_ready',
    planDocumentCandidateReady,
    planSnapshot,
    'plan.md exists',
  );
  const planDocumentReadyGateValid =
    hasPlan &&
    gatePassed(gateRegistry, 'plan.document_ready', {
      snapshot: planSnapshot,
    });
  const planReadinessGateValid =
    hasSpecify &&
    gatePassed(gateRegistry, 'plan.readiness_review', {
      snapshot: specifySnapshot,
    });
  const planReadinessGate = getGate(gateRegistry, 'plan.readiness_review');
  const planReadinessGateBlocked =
    hasSpecify &&
    planReadinessGate &&
    planReadinessGate.status === 'blocked' &&
    (!planReadinessGate.snapshot ||
      snapshotsEqual(planReadinessGate.snapshot, specifySnapshot));
  const planUserConfirmGateValid =
    hasSpecify &&
    gatePassed(gateRegistry, 'plan.user_confirm_start', {
      snapshot: specifySnapshot,
    });
  const implementUserConfirmGateValid =
    hasPlan &&
    gatePassed(gateRegistry, 'implement.user_confirm_start', {
      snapshot: planSnapshot,
    });
  const planImplementApprovedGateValid =
    hasPlan &&
    gatePassed(gateRegistry, 'plan.implement_approved', {
      snapshot: planSnapshot,
    });
  const planImplementApprovedGate = getGate(gateRegistry, 'plan.implement_approved');
  const planImplementApprovedEverPassed =
    hasPlan && planImplementApprovedGate && planImplementApprovedGate.status === 'passed';
  const roadmapImplementationStarted =
    roadmap.readyForQA > 0 || roadmap.failed > 0 || roadmap.completed > 0;
  const implementApprovalValid =
    planImplementApprovedGateValid ||
    implementUserConfirmGateValid ||
    (planImplementApprovedEverPassed && roadmapImplementationStarted);
  const archiveDomainMergedGateValid = gatePassed(gateRegistry, 'archive.domain_merged');
  const archiveKnowledgeReviewedGateValid = gatePassed(gateRegistry, 'archive.knowledge_reviewed');
  const effectiveSpecifyReviewValid =
    specifyReviewValid || planReadinessGateValid;
  const effectiveAckSpecifyBeforePlan =
    (state.ackSpecifyBeforePlan === true &&
      specifyMtimeNow > 0 &&
      typeof state.specifyAckMtime === 'number' &&
      state.specifyAckMtime >= specifyMtimeNow) ||
    planUserConfirmGateValid;
  const planReadinessComplete =
    productClarificationGateValid &&
    specifyDocumentReadyGateValid &&
    effectiveSpecifyReviewValid &&
    effectiveAckSpecifyBeforePlan &&
    !planReadinessGateBlocked &&
    technicalClarificationDebt.count === 0;
  const phase = detectPhase(
    hasSpecify,
    specifyDocumentReadyGateValid,
    hasPlan,
    planReadinessComplete,
    planDocumentReadyGateValid,
    roadmap.pending,
    roadmap.readyForQA,
    roadmap.failed,
    roadmap.completed,
  );

  const gates = {
    phase,
    hasSpecify,
    hasPlan,
    pathSpecify,
    pathPlan,
    workspaceRoot,
    specifyMtimeNow,
    specifyReviewStatus,
    specifyReviewMtime: specifyReviewMtimeStored,
    specifyReviewPassedMtime: specifyReviewPassedMtimeStored,
    specifyReviewBlockReason:
      typeof state.specifyReviewBlockReason === 'string'
        ? state.specifyReviewBlockReason
        : '',
    specifyReviewContractEvidence:
      typeof state.specifyReviewContractEvidence === 'string'
        ? state.specifyReviewContractEvidence
        : '',
    gateRegistry,
    architectureLayersReady,
    codeStyleReady,
    specifySnapshot,
    specifyDocumentReady: specifyDocumentReadyGateValid,
    planSnapshot,
    planDocumentReady: planDocumentReadyGateValid,
    productClarificationGateValid,
    specifyPreviewGateValid,
    specifyPreviewGateBlocked,
    specifyPreviewGateReason:
      specifyPreviewGate && typeof specifyPreviewGate.reason === 'string'
        ? specifyPreviewGate.reason
        : '',
    planReadinessGateValid,
    planReadinessGateBlocked,
    planReadinessGateReason:
      planReadinessGate && typeof planReadinessGate.reason === 'string'
        ? planReadinessGate.reason
        : '',
    planUserConfirmGateValid,
    planImplementApprovedGateValid,
    implementApprovalValid,
    implementUserConfirmGateValid,
    specifyReviewValid: effectiveSpecifyReviewValid,
    ackSpecifyBeforePlan: effectiveAckSpecifyBeforePlan,
    specifyAckMtime:
      typeof state.specifyAckMtime === 'number' &&
      Number.isFinite(state.specifyAckMtime)
        ? state.specifyAckMtime
        : 0,
    autoClarificationAckMtime:
      typeof state.autoClarificationAckMtime === 'number' &&
      Number.isFinite(state.autoClarificationAckMtime)
        ? state.autoClarificationAckMtime
        : 0,
    autoClarificationNeedsReview,
    // 并行策略：仅自动托管（autoProceedGroups=true）时开启并行派发
    parallelEnabled: state.autoProceedGroups === true,
    blockerCountInSpecify: blockerInSpecify,
    blockerCountInPlan: blockerInPlan,
    clarificationOpen: clarification.open,
    openClarificationCount: clarification.openCount,
    questions: clarification.questions || [],
    clarificationQuestionsAll: clarification.questionsAll || [],
    closedClarificationAnswers: clarification.closedAnswers || [],
    inlineClarificationDebtCount: inlineClarificationDebt.count,
    inlineClarificationDebtItems: inlineClarificationDebt.items,
    technicalClarificationDebtCount: technicalClarificationDebt.count,
    technicalClarificationDebtItems: technicalClarificationDebt.items,
    specifyComplete,
    pendingTaskCount: roadmap.pending,
    readyForQACount: roadmap.readyForQA,
    failedTaskCount: roadmap.failed,
    completedTaskCount: roadmap.completed,
    hasBlockedTask: roadmap.hasBlocked,
    canProceedToPlan,
    canProceedToImplement,
    canProceedToArchive,
    /** plan.md 已存在但规格未达标（常见于架构师打回后新增 CQ） */
    planExistsWhileSpecifyIncomplete: hasPlan && !specifyComplete,
    activeGroupId, // 传递给 determineAction
    groupRetryCount: state.groupRetryCount || 0,
    autoProceedGroups: state.autoProceedGroups || false,
    domainMerged: archiveDomainMergedGateValid,
    knowledgeReviewed: archiveKnowledgeReviewedGateValid,
    codeStyleExplored: state.codeStyleExplored === true,
    codeStyleExploredMtime:
      typeof state.codeStyleExploredMtime === 'number'
        ? state.codeStyleExploredMtime
        : 0,
    codeStyleSynced,
    domainInitChoice:
      state.domainInitChoice === 'scan' || state.domainInitChoice === 'skip'
        ? state.domainInitChoice
        : undefined,
    domainInitRefs: Array.isArray(state.domainInitRefs)
      ? state.domainInitRefs
      : undefined,
    domainInitCandidateRefs: Array.isArray(state.domainInitCandidateRefs)
      ? state.domainInitCandidateRefs
      : undefined,
    dir, // 用于 determineAction 中直接更新 state
    planContent: planContent || '',
    nextPendingGroup: groups.find(
      (g) => g.status !== 'completed' && g.status !== 'empty',
    ), // 寻找第一个未完成的 Group
  };

  if (state.autoProceedGroups === true && planTree && phase === 'Implement') {
    gates.parallelGroupActions = analyzeParallelGroupActions(planTree, {
      pendingTaskCount: roadmap.pending,
      failedTaskCount: roadmap.failed,
      readyForQACount: roadmap.readyForQA,
    });
  }

  const archiveAnchorRequired =
    !inHistory &&
    phase === 'Archive' &&
    canProceedToArchive &&
    !isArchiveAnchorAllowed(gateRegistry);

  const suggestedAction = determineAction(
    gates,
    phase,
    archiveAnchorRequired,
    id,
    inHistory,
  );

  if (
    suggestedAction.type !== 'dispatch' &&
    suggestedAction.type !== 'dispatch_array'
  ) {
    clearPendingProtocol(dir);
  }

  // dispatch_array（自动托管下的 per-group pipeline 并行派发）：为每个 action 附 focusPlan，并整批落盘 pending-protocol
  if (suggestedAction.type === 'dispatch_array') {
    const batchActions = dispatchArrayItems(suggestedAction);
    suggestedAction.items = batchActions;
    delete suggestedAction.agents;
    // 先为每个 action 预计算 focusPlan（后续既作为 action.focusPlan，也作为 knowledgeContext 的 hint）
    const focusPlansByAction = new Map();
    for (const action of batchActions) {
      const gid = action && action.groupId;
      let focusPlan = null;
      if (planTree && gid) {
        try {
          focusPlan = buildFocusPlanFromTree(planTree, gid) || null;
        } catch (_) {
          focusPlan = null;
        }
      }
      focusPlansByAction.set(action, focusPlan);
    }

    // hintText = 各 group 的 focusPlan 拼接（包含 Create/Modify 路径 + Active Group 任务描述）
    // 这样 buildCodeStyleSlice 能抽到所有 group 的文件路径；scoreKnowledgeChunk 也能命中 domain。
    const hintForKnowledge = batchActions
      .map((a) => focusPlansByAction.get(a) || (a && a.context) || '')
      .filter(Boolean)
      .join('\n\n');
    const sharedKnowledgeContext = buildKnowledgeContext(
      workspaceRoot,
      id,
      hintForKnowledge,
      { domainAllowlist: getKnowledgeDomainAllowlist(gates, id) },
    );

    const items = [];
    for (const action of batchActions) {
      const gid = action && action.groupId;
      const focusPlan = focusPlansByAction.get(action) || null;
      if (focusPlan) action.focusPlan = focusPlan;

      if (sharedKnowledgeContext) {
        action.context =
          `${action.context || ''}\n\n【Knowledge Context】\n${sharedKnowledgeContext}`.trim();
      }

      items.push({
        groupId: gid || null,
        agent: action.agent,
        context: action.context,
        focusPlan: focusPlan,
        dependsOn: Array.isArray(action.dependsOn) ? action.dependsOn : [],
        ...(action.mode ? { mode: action.mode } : {}),
        ...(action.qaMode ? { qaMode: action.qaMode } : {}),
        ...(action.finalQa === true ? { finalQa: true } : {}),
      });
    }

    try {
      const tempDir = path.join(dir, '.temp');
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
      const protocolPayload = {
        kind: 'dispatch_array',
        requirementId: id,
        phase,
        waitPolicy: suggestedAction.waitPolicy || 'any_done',
        groupIsolation: suggestedAction.groupIsolation === true,
        items,
        knowledgeContext: sharedKnowledgeContext || null,
        knowledgePolicy: sharedKnowledgeContext
          ? {
              required: true,
              decisionCardFormat: '任务意图 | 采用规则(<=3) | 忽略规则及理由',
              logRequirement:
                'Ready-for-QA 或 QA Evidence 中必须回填 Knowledge Rules Used',
            }
          : null,
      };
      fs.writeFileSync(
        path.join(tempDir, 'pending-protocol.json'),
        JSON.stringify(protocolPayload, null, 2),
        UTF8,
      );
    } catch (_) {
      // 落盘失败不影响引擎主流程
    }
  }

  // 为各子代理附加精简版上下文，减少无关信息
  if (suggestedAction.type === 'dispatch') {
    let computedFocusPlan = null;
    if (
      planTree &&
      (suggestedAction.agent === 'specflow-implement' ||
        suggestedAction.agent === 'specflow-qa')
    ) {
      const targetGroupId =
        suggestedAction.groupId ||
        gates.activeGroupId ||
        (gates.nextPendingGroup && gates.nextPendingGroup.id);
      if (targetGroupId) {
        const focusPlan = buildFocusPlanFromTree(planTree, targetGroupId);
        if (focusPlan) {
          computedFocusPlan = focusPlan;
          suggestedAction.focusPlan = focusPlan;
        }
      }
    }

    if (suggestedAction.agent === 'specflow-plan' && specifyTree) {
      const focusSpecify = buildFocusSpecify(specifyTree);
      if (focusSpecify) suggestedAction.focusSpecify = focusSpecify;
    }

    if (
      suggestedAction.agent === 'specflow-archive' ||
      (suggestedAction.agent === 'specflow-domain-explorer' &&
        suggestedAction.mode === 'Merge')
    ) {
      const focusArchive = buildFocusArchive(specifyTree, planTree);
      if (focusArchive) suggestedAction.focusArchive = focusArchive;
    }

    // 相关性提示优先使用 focusPlan；code-style explorer 的派发上下文本身较泛，改用 plan.md 抽取领域与路径信号。
    const knowledgeHint =
      computedFocusPlan ||
      (suggestedAction.agent === 'specflow-specify' ||
      suggestedAction.agent === 'specflow-specify-preview'
        ? buildSpecifyKnowledgeHint(gates, suggestedAction, specifyContent)
        : '') ||
      (suggestedAction.agent === 'specflow-code-style-explorer' && planContent
        ? planContent
        : suggestedAction.context || '');
    const domainAllowlist = getKnowledgeDomainAllowlist(gates, id);
    const isSpecifyDispatch =
      suggestedAction.agent === 'specflow-specify' ||
      suggestedAction.agent === 'specflow-specify-preview';
    const knowledgeContext = buildKnowledgeContext(
      workspaceRoot,
      id,
      knowledgeHint,
      {
        domainAllowlist,
        requireDomainAllowlist: isSpecifyDispatch,
      },
    );
    const knowledgePolicy = buildKnowledgePolicy(
      gates,
      id,
      suggestedAction.agent,
      knowledgeContext,
      domainAllowlist,
    );
    const baselineNotice = isSpecifyDispatch
      ? renderSpecifyKnowledgeBaselineNotice(knowledgePolicy)
      : '';
    if (baselineNotice) {
      suggestedAction.context =
        `${suggestedAction.context || ''}\n\n${baselineNotice}`.trim();
    }
    if (knowledgeContext) {
      suggestedAction.context =
        `${suggestedAction.context || ''}\n\n【Knowledge Context】\n${knowledgeContext}`.trim();
    }

    // 落盘 pending-protocol.json 供 print-protocol.cjs 渲染
    try {
      const tempDir = path.join(dir, '.temp');
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
      const protocolPayload = {
        requirementId: id,
        phase,
        agent: suggestedAction.agent,
        context: suggestedAction.context,
        knowledgeContext: knowledgeContext || null,
        knowledgePolicy,
        mode: suggestedAction.mode,
        qaMode: suggestedAction.qaMode || null,
        focusPlan: suggestedAction.focusPlan || null,
        focusSpecify: suggestedAction.focusSpecify || null,
        focusArchive: suggestedAction.focusArchive || null,
        domainInitChoice:
          state.domainInitChoice === 'scan' || state.domainInitChoice === 'skip'
            ? state.domainInitChoice
            : null,
        domainInitRefs: Array.isArray(state.domainInitRefs)
          ? state.domainInitRefs
          : null,
        domainInitCandidateRefs: Array.isArray(state.domainInitCandidateRefs)
          ? state.domainInitCandidateRefs
          : null,
      };
      fs.writeFileSync(
        path.join(tempDir, 'pending-protocol.json'),
        JSON.stringify(protocolPayload, null, 2),
        UTF8,
      );
    } catch (_) {
      // 落盘失败不影响引擎主流程
    }
  }

  return {
    requirementId: id,
    phase,
    suggestedAction,
    pathSpecify: hasSpecify ? pathSpecify : null,
    pathPlan: hasPlan ? pathPlan : null,
    pathDir: dir,
    inHistory,
    gates,
    last_modified: getLastModified(dir),
  };
}

function defaultGates(phase) {
  return {
    phase,
    hasSpecify: false,
    hasPlan: false,
    pathSpecify: null,
    pathPlan: null,
    workspaceRoot: '',
    specifyMtimeNow: 0,
    specifyReviewPassedMtime: null,
    specifyReviewValid: false,
    ackSpecifyBeforePlan: false,
    specifyAckMtime: 0,
    blockerCountInSpecify: 0,
    blockerCountInPlan: 0,
    clarificationOpen: false,
    openClarificationCount: 0,
    specifyComplete: false,
    pendingTaskCount: 0,
    readyForQACount: 0,
    failedTaskCount: 0,
    completedTaskCount: 0,
    hasBlockedTask: false,
    canProceedToPlan: false,
    canProceedToImplement: false,
    canProceedToArchive: false,
    domainMerged: false,
    architectureLayersReady: false,
    domainInitChoice: undefined,
    domainInitRefs: undefined,
    domainInitCandidateRefs: undefined,
  };
}

function runEngine(workspaceRoot, requirementId) {
  const result = runEngineInner(workspaceRoot, requirementId);
  const { syncResidualToState } = require('./residual-metrics.cjs');
  let acResidual = {
    acTotal: 0,
    acPassed: 0,
    remaining: 0,
    residualItems: [],
    residual: null,
    residualDelta: null,
    engineTurn: 0,
  };
  let residual = null;
  if (
    result.pathDir &&
    typeof result.pathDir === 'string' &&
    result.pathDir.length > 0
  ) {
    try {
      const snap = syncResidualToState(
        result.pathDir,
        workspaceRoot,
        result.gates,
        { fromEngine: true },
      );
      residual = snap.residual;
      acResidual = {
        acTotal: snap.acTotal,
        acPassed: snap.acPassed,
        remaining: snap.remaining,
        residualItems: snap.residualItems,
        residual: snap.residual,
        residualDelta: snap.residualDelta,
        engineTurn: snap.engineTurn,
      };
      try {
        const protoPath = path.join(
          result.pathDir,
          '.temp',
          'pending-protocol.json',
        );
        if (fs.existsSync(protoPath)) {
          const payload = JSON.parse(fs.readFileSync(protoPath, 'utf-8'));
          payload.residual = snap.residual;
          payload.residualDelta = snap.residualDelta;
          payload.engineTurn = snap.engineTurn;
          fs.writeFileSync(
            protoPath,
            JSON.stringify(payload, null, 2),
            'utf-8',
          );
        }
      } catch (_) {
        // 忽略协议补写失败
      }
    } catch (_) {
      // 保持默认
    }
  }
  const { buildUserFacing } = require('./user-facing.cjs');
  return {
    ...result,
    residual,
    acResidual,
    userFacing: buildUserFacing({ ...result, residual, acResidual }),
  };
}

if (require.main === module) {
  const {
    parseCliArgs,
    resolveWorkspace,
    resolveRequirementId,
  } = require('./cli-args.cjs');
  const { named, positional } = parseCliArgs(process.argv.slice(2));
  const workspaceRoot = resolveWorkspace(named, positional, 0);
  const requirementId = resolveRequirementId(named, positional, 1) || null;
  const result = runEngine(workspaceRoot, requirementId);
  console.log(JSON.stringify(result, null, 2));
}
