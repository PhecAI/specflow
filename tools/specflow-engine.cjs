/**
 * Specflow 工作流引擎：根据 ai-docs 物理状态判定当前环节与门禁是否通过。
 * 需求号：以用户提供为准；未提供则取当前 Git 分支名（取最后一段，如 feature/1419 → 1419），不要求纯数字。
 * 用法（统一）: PLUGIN_ROOT=/path/to/specflow node "$PLUGIN_ROOT/tools/specflow-engine.cjs" [workspaceRoot] [需求号]
 * 输出: JSON 到 stdout
 */

const child_process = require('child_process');
const fs = require('fs');
const path = require('path');
const { readState, normalizeDomainInitRef, domainRefToFileStem } = require('./specflow-state.cjs');
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

const UTF8 = 'utf-8';

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
  'contract',
  'feature',
  'roadmap',
  'executionLog',
  'changelog',
];

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

function extractClarificationLogText(specifyContent) {
  const raw = String(specifyContent || '');
  if (!raw.trim()) return '';
  const anchorIdx = raw.search(/<!--\s*specflow:section=clarification-log\s*-->/i);
  if (anchorIdx >= 0) {
    const tail = raw.slice(anchorIdx);
    const end = tail.search(/\n##\s+6[\.、]|\n##\s+6\s|<!--\s*specflow:section=changelog/i);
    return end >= 0 ? tail.slice(0, end) : tail;
  }
  const headingIdx = raw.search(/\n##\s+5[\.、]?\s+.*?(Clarification|Decision\s*Log|决策记录|Open\s*Product\s*(?:Decisions|Questions)|待决策|待产品决策|待产品确认|待确认|澄清)/i);
  if (headingIdx >= 0) {
    const tail = raw.slice(headingIdx);
    const end = tail.search(/\n##\s+6[\.、]|\n##\s+6\s/i);
    return end >= 0 ? tail.slice(0, end) : tail;
  }
  return '';
}

function detectTechnicalClarificationDebt(specifyContent) {
  const section = extractClarificationLogText(specifyContent);
  if (!section) return { count: 0, items: [] };

  const lines = section.split('\n');
  let inNonBlockingBucket = false;
  const items = [];
  const maxItems = 8;
  for (const raw of lines) {
    const line = String(raw || '').trim();
    if (
      /^#{3,6}\s+(Notes?|非阻塞|待后续|Plan\s*验证)\b/i.test(line) ||
      /^###\s+.*?(非阻塞|待后续|Plan\s*验证|备注)/i.test(line)
    ) {
      inNonBlockingBucket = true;
      continue;
    }
    if (/^#{3,6}\s+\[\?\]\s*CQ/i.test(line)) {
      inNonBlockingBucket = false;
      continue;
    }
    if (/^##\s+/.test(line)) {
      inNonBlockingBucket = false;
      continue;
    }
    if (!inNonBlockingBucket || !line) continue;

    const mentionsTechCq = /\bCQ-(?:Contract|Tech)-[A-Za-z0-9_-]+/i.test(line);
    const mentionsTechnicalDebt =
      /(接口|API|endpoint|字段|field|契约|Contract|对接|权限配置|Mock\s*边界|Plan\s*闭合|plan\.md\s*中显式标注|未确认|待确认)/i.test(
        line,
      );
    if (mentionsTechCq || mentionsTechnicalDebt) {
      items.push(line.replace(/^[-*]\s*/, '').slice(0, 300));
      if (items.length >= maxItems) break;
    }
  }

  return { count: items.length, items };
}

function ensureInitGlobalAssets(workspaceRoot, requirementDir) {
  if (!workspaceRoot || !requirementDir || !fs.existsSync(requirementDir)) {
    return { ok: false, skipped: true }
  }
  try {
    const { runInventoryScan } = require('./inventory-scan.cjs')
    const result = runInventoryScan(workspaceRoot)
    if (result && result.ok) {
      const { isArchitectureLayersCalibrated } = require('./code-style.cjs')
      passGate(requirementDir, 'init.global_assets', {
        stage: 'Init',
        scope: 'global',
        subject: 'ai-docs/global-assets',
        evidence: [
          result.globalAssetsDir,
          result.codeStylePath,
          result.architectureLayersPath,
        ].filter(Boolean),
      })
      if (isArchitectureLayersCalibrated(workspaceRoot)) {
        passGate(requirementDir, 'init.architecture_layers', {
          stage: 'Init',
          scope: 'global',
          subject: result.architectureLayersPath || 'ai-docs/global-assets/standards/architecture-layers.md',
          evidence: result.architectureLayersPath || 'architecture-layers.md',
        })
      } else {
        resetGate(requirementDir, 'init.architecture_layers', {
          stage: 'Init',
          scope: 'global',
          subject: result.architectureLayersPath || 'ai-docs/global-assets/standards/architecture-layers.md',
          reason: 'architecture layers require agent calibration',
        })
      }
    }
    return result || { ok: true }
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) }
  }
}

function normalizeClarificationEntries(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.items)) return raw.items;
  const out = [];
  for (const key of ['product', 'acceptance', 'technical', 'questions']) {
    if (Array.isArray(raw[key])) {
      for (const item of raw[key]) out.push({ ...item, type: item.type || key });
    }
  }
  return out;
}

function parseTempClarifications(filePath) {
  const raw = safeReadJson(filePath, null);
  const entries = normalizeClarificationEntries(raw);
  const questions = [];
  for (let idx = 0; idx < entries.length; idx++) {
    const item = entries[idx] || {};
    const status = String(item.status || item.state || '').toLowerCase();
    const hasAnswer =
      item.answer != null ||
      item.userAnswer != null ||
      item.resolution != null ||
      item.decision != null;
    if (['closed', 'resolved', 'done'].includes(status) || hasAnswer) continue;

    const id = String(item.id || item.cqId || `${item.type || 'clarification'}_${idx + 1}`);
    const promptParts = [];
    const prompt =
      item.prompt ||
      item.question ||
      item.decisionPrompt ||
      item.confirmationPrompt ||
      item.title ||
      '请补充澄清信息';
    promptParts.push(String(prompt).trim());
    if (item.whyCritical) promptParts.push(`为什么关键：${String(item.whyCritical).trim()}`);
    if (item.recommendation) promptParts.push(`SpecFlow 建议：${String(item.recommendation).trim()}`);

    const rawOptions = Array.isArray(item.options) ? item.options : [];
    const options = rawOptions.map((option, optionIdx) => {
      if (typeof option === 'string') {
        return { id: `option_${optionIdx + 1}`, label: option };
      }
      return {
        id: String(option.id || option.value || `option_${optionIdx + 1}`),
        label: String(option.label || option.text || option.title || option.id || `Option ${optionIdx + 1}`),
      };
    });

    questions.push({
      id,
      prompt: promptParts.filter(Boolean).join('\n\n'),
      allow_multiple: false,
      responseType: options.length > 0 ? undefined : 'text',
      options,
    });
  }

  return {
    open: questions.length > 0,
    openCount: questions.length,
    questions,
    questionsAll: questions,
  };
}

function mergeClarificationStates(primary, secondary) {
  const a = primary || { open: false, openCount: 0, questions: [], questionsAll: [] };
  const b = secondary || { open: false, openCount: 0, questions: [], questionsAll: [] };
  const questions = [
    ...(Array.isArray(a.questions) ? a.questions : []),
    ...(Array.isArray(b.questions) ? b.questions : []),
  ];
  const questionsAll = [
    ...(Array.isArray(a.questionsAll) ? a.questionsAll : []),
    ...(Array.isArray(b.questionsAll) ? b.questionsAll : []),
  ];
  return {
    open: Boolean(a.open || b.open),
    openCount: Number(a.openCount || 0) + Number(b.openCount || 0),
    questions,
    questionsAll,
  };
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

function determineAction(gates, phase, archiveAnchorRequired, id, inHistory) {
  // 1. Specify 阶段 [BLOCKER] 优先于澄清
  if (phase === 'Specify' && gates.blockerCountInSpecify > 0) {
    return {
      type: 'block',
      reason: `存在 ${gates.blockerCountInSpecify} 个未解决的 [BLOCKER]，请先消除。`,
    };
  }

  // 2. 全局：未闭合澄清优先于进入 Plan / Implement / Archive（避免澄清漏检时误弹 confirm_start_plan）
  //    含架构师反向打回（接口/对接文档缺失等）——强制门禁，禁止跳过。
  if (gates.clarificationOpen && gates.openClarificationCount > 0) {
    const n = gates.openClarificationCount;
    return {
      type: 'interaction_required',
      reason: `存在 ${n} 条未闭合澄清。**此为强制门禁，编排不得跳过。** 请通过交互工具选择或补充决策后再继续；全部闭合后方可进入 Plan / 修订 plan。`,
      questions: gates.questions,
    };
  }

  if (gates.inlineClarificationDebtCount > 0) {
    const n = gates.inlineClarificationDebtCount;
    const examples = Array.isArray(gates.inlineClarificationDebtItems)
      ? gates.inlineClarificationDebtItems
          .slice(0, 3)
          .map((x) => `L${x.line}: ${x.text}`)
          .join('；')
      : '';
    return {
      type: 'block',
      reason:
        `specify.md 正文存在 ${n} 个内联 [?] 疑问点。正式规格不得散落未闭合问题；请先转成成文前澄清并闭合，或沉淀为已确认决策后再进入 Plan。` +
        (examples ? ` 示例：${examples}` : ''),
    };
  }

  // 2.1 Specify：若存在自动解决的澄清，要求一次性审阅确认（EBA anchor）
  if (phase === 'Specify' && gates.hasSpecify) {
    try {
      const content =
        safeReadFile(gates.pathSpecify || path.join(gates.dir, 'specify.md')) ||
        '';
      const hasAuto = /###\s+\[Auto\]\s*CQ/i.test(content);
      const mtime =
        typeof gates.specifyMtimeNow === 'number' ? gates.specifyMtimeNow : 0;
      const ack =
        typeof gates.autoClarificationAckMtime === 'number'
          ? gates.autoClarificationAckMtime
          : 0;
      if (hasAuto && mtime > 0 && mtime !== ack) {
        return {
          type: 'anchor',
          headline: '请审阅自动解决的待确认项',
          message:
            '我已基于领域知识库自动解决了一些待确认项。请打开需求说明文档快速浏览标记为 [Auto] 的条目，确认无误后点一次“确认”继续。',
          next: { action: 'ack-auto-clarifications' },
        };
      }
    } catch {
      // ignore
    }
  }

  if (phase === 'Init' && !gates.hasSpecify && gates.architectureLayersReady !== true) {
    return {
      type: 'dispatch',
      agent: 'specflow-architecture-layers',
      context:
        '初始化项目分层画像：基于仓库目录、配置、路由/模块入口、典型文件与既有规范生成 ai-docs/global-assets/standards/architecture-layers.md。必须产出项目专属抽象 layer；禁止硬编码前端/后端固定分层，禁止写具体业务模块名。',
    };
  }

  // 2.5 Init：领域初始化——纯 prompt 驱动，不做任何启发式扫描。
  //   两阶段协议：
  //     S1) 尚无 confirmed 且尚无 candidates：发 1 道 text 题，
  //         由 agent 结合项目（前端路由 / 后端 domain·service）与需求摘要，
  //         输出 1 或多个 domain ref（<scope>::<slug>），落盘至 state.domainInitCandidateRefs。
  //     S2) 有 candidate refs 但尚未产生 confirmed：对「全局缺失」的候选逐一发 yes/no 题，
  //         用户/agent 逐条采纳；全局已有的直接复用到 domainInitRefs。
  //   采纳结果统一落到 domainInitRefs（写法：set-domain-init-pref --pref scan --ref a::b,c::d）。
  //   之后若 business-domains/<slug>.md 缺失，按 dispatch_array（上限 5）并行派发。
  if ((phase === 'Init' || phase === 'Specify') && !gates.hasSpecify) {
    const hasConfirmed =
      (Array.isArray(gates.domainInitRefs) &&
        gates.domainInitRefs.length > 0) ||
      gates.domainInitChoice === 'scan';
    const requirementHintText = readRequirementHintText(
      gates.workspaceRoot,
      id,
    );
    const requirementExcerpt = String(requirementHintText || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400);
    const globalDomains = listDomainDocs(gates.workspaceRoot)
      .map((d) => String(d.domain || '').toLowerCase())
      .filter(Boolean);
    const globalSet = new Set(globalDomains);

    const candidates = Array.isArray(gates.domainInitCandidateRefs)
      ? gates.domainInitCandidateRefs
        .map((s) => normalizeDomainInitRef(String(s || '')))
        .filter(Boolean)
      : [];

    if (!hasConfirmed) {
      // --- S1: 无候选 → 让 agent 自主分析项目 + 需求，产出 slug 列表 ---
      if (candidates.length === 0) {
        return {
          type: 'interaction_required',
          reason: '请基于项目结构与需求内容，提交本次需求的业务领域候选列表。',
          init_context: {
            requirementExcerpt,
            existingGlobalDomains: globalDomains,
          },
          questions: [
            {
              id: 'domain_init_candidates_text',
              prompt:
                [
                  '请结合【需求内容】与【项目代码结构】判断本次需求涉及的业务领域身份，并以逗号分隔提交，格式为 <scope>::<slug>。',
                  '- scope 是代码归属边界：package / app / service / bounded-context / module path；',
                  '- slug 是业务领域名：英文小写，短横线连字符；',
                  '- 优先复用 init_context.existingGlobalDomains 已存在的领域身份文件名所代表的 scope + slug；',
                  '- 若是前端项目：scope 优先取 app/package + 路由根或页面模块（如 apps/admin-web::content-library）；',
                  '- 若是后端项目：scope 优先取 service / bounded-context / module 路径（如 services/order::payment）；',
                  '- 允许多值，上限 8；若只有 1 个也以同样格式提交（无尾逗号）。',
                  '',
                  '写入命令示例：',
                  '  node $PLUGIN_ROOT/tools/manage-state.cjs set-domain-init-candidates <workspace> <requirementId> --ref services/order::payment,apps/admin-web::content-library',
                ].join('\n'),
              allow_multiple: false,
              responseType: 'text',
              placeholder: 'services/order::payment,apps/admin-web::content-library',
              options: [],
            },
          ],
        };
      }

      // --- S2: 已有候选 → 对「全局缺失」的逐条 yes/no；全局已有的自动列入 accept ---
      const autoAccept = candidates.filter((ref) => globalSet.has(domainRefToFileStem(ref)));
      const needConfirm = candidates.filter((ref) => !globalSet.has(domainRefToFileStem(ref)));
      const questions = needConfirm.map((ref, idx) => ({
        id: `domain_init_accept__${domainRefToFileStem(ref) || idx}`,
        prompt: `是否为本次需求采纳并创建业务领域「${ref}」？（若否则丢弃该候选）`,
        allow_multiple: false,
        options: [
          { id: 'yes', label: `是，采纳 ${ref}` },
          { id: 'no', label: `否，丢弃 ${ref}` },
        ],
      }));

      return {
        type: 'interaction_required',
        reason:
          autoAccept.length > 0
            ? `候选中已有 ${autoAccept.length} 个与全局领域重名，默认采纳；其余 ${needConfirm.length} 个请逐一确认。`
            : '请逐一确认候选是否采纳。',
        init_context: {
          candidates,
          autoAcceptFromGlobal: autoAccept,
          needConfirm,
          existingGlobalDomains: globalDomains,
        },
        questions:
          questions.length > 0
            ? questions
            : [
                {
                  id: 'domain_init_all_from_global_ack',
                  prompt:
                    '全部候选均可从全局领域复用，确认后将直接写入 domainInitRefs。',
                  allow_multiple: false,
                  options: [
                    { id: 'ok', label: '确认（全部采纳）' },
                  ],
                },
              ],
        next: {
          action: 'set-domain-init-pref',
          hint:
            'agent 汇总 yes 的答案（并合并 autoAcceptFromGlobal），调用：node $PLUGIN_ROOT/tools/manage-state.cjs set-domain-init-pref <ws> <id> --pref scan --ref <accepted_ref_csv>；若全部为否则 --pref skip',
        },
      };
    }

    // --- 已确认 → 计算本地缺失，pendingLocal>1 走 dispatch_array（上限 5） ---
    const effectiveSlugs = inferInitDomainSlugs(gates, id);
    const finalSlugs = effectiveSlugs.length > 0 ? effectiveSlugs : ['general'];
    const pendingLocal = finalSlugs.filter((s) => {
      const p = path.join(gates.dir, 'business-domains', `${domainRefToFileStem(s)}.md`);
      return !fs.existsSync(p);
    });

    if (pendingLocal.length === 1) {
      return {
        type: 'dispatch',
        agent: 'specflow-domain-explorer',
        context: `目标领域身份: ${pendingLocal[0]}。请在编写需求说明前只扫描该 scope 边界内代码，逆向提取存量业务规则并初始化业务知识库（渐进式：先骨架与关键规则，勿一次写满）。`,
      };
    }
    if (pendingLocal.length > 1) {
      const DOMAIN_DISPATCH_LIMIT = 5;
      const batch = pendingLocal.slice(0, DOMAIN_DISPATCH_LIMIT);
      return {
        type: 'dispatch_array',
        items: batch.map((slug) => ({
          agent: 'specflow-domain-explorer',
          groupId: `domain-init:${domainRefToFileStem(slug)}`,
          context: `目标领域身份: ${slug}。请在编写需求说明前只扫描该 scope 边界内代码，逆向提取存量业务规则并初始化业务知识库（渐进式：先骨架与关键规则，勿一次写满）。`,
        })),
        waitPolicy: 'all',
        note:
          pendingLocal.length > DOMAIN_DISPATCH_LIMIT
            ? `本轮仅派发前 ${DOMAIN_DISPATCH_LIMIT} 个；剩余 ${pendingLocal.length - DOMAIN_DISPATCH_LIMIT} 个在下一轮继续。`
            : undefined,
      };
    }

    let initSpecifyCtx = '初始化已完成，请基于用户输入、已确认业务领域与全局资产骨架生成正式规格';
    const autoRef =
      (Array.isArray(gates.domainInitRefs) && gates.domainInitRefs[0]) ||
      '';
    if (autoRef) {
      initSpecifyCtx += `。已确认领域身份「${autoRef}」，编写需求说明前必须先阅读需求内 business-domains。`;
    }
    return { type: 'dispatch', agent: 'specflow-specify', context: initSpecifyCtx };
  }

  // 3. Specify：Domain / Tech 探测与默认派发
  if (phase === 'Specify') {
    // 如果没有未闭合的澄清，检查是否刚刚完成了 CQ-Domain-Init 的闭合，且用户选择了需要扫描代码库。
    // 这需要从当前的 specifyContent 中找出 CQ-Domain-Init 的回答。
    const specifyContent = safeReadFile(
      gates.pathSpecify || path.join(gates.dir, 'specify.md'),
    );
    if (specifyContent) {
      // 检查领域提取
      const cqDomainInitMatch = specifyContent.match(
        /###\s+\[\?\]\s*(CQ-Domain-Init[^\n:]*):\s*(.*?)\n([\s\S]*?)(?=\n###\s+\[\?\]|$)/,
      );
      if (cqDomainInitMatch) {
        const cqBody = cqDomainInitMatch[3];
        const userReplyMatch = cqBody.match(/\*\*\[User\]\*\*:\s*(\S+.*)/);
        if (userReplyMatch) {
          const userReply = userReplyMatch[1].trim().toLowerCase();
          if (
            userReply.includes('option a') ||
            userReply.includes('option_a') ||
            userReply.includes('需要') ||
            userReply === 'a'
          ) {
            const domainMatch = cqDomainInitMatch[2].match(
              /缺少\s*\[(.*?)\]\s*(?:领域知识库|业务知识库)/,
            );
            const targetDomain = domainMatch ? domainMatch[1] : 'unknown';
            const domainFilePath = path.join(
              gates.dir,
              'business-domains',
              `${targetDomain}.md`,
            );
            if (!fs.existsSync(domainFilePath)) {
              return {
                type: 'dispatch',
                agent: 'specflow-domain-explorer',
                context: `目标领域: ${targetDomain}。请扫描代码库逆向提取存量业务规则并初始化活文档。`,
              };
            }
          }
        }
      }
    }

    let specifyCtx = '根据用户输入梳理业务并生成或更新规格';
    const autoRef =
      (Array.isArray(gates.domainInitRefs) && gates.domainInitRefs[0]) ||
      '';
    const autoStem = domainRefToFileStem(autoRef);
    if (!gates.hasSpecify) {
      const domainKbPath = path.join(
        gates.dir,
        'business-domains',
        `${autoStem}.md`,
      );
      if (autoStem && fs.existsSync(domainKbPath)) {
        specifyCtx += ` 【业务知识库】已按需求内流程自动初始化，目标领域身份「${autoRef}」，业务知识库文件已就绪。编写需求说明前**必须先阅读**该文件并作为强约束基线。`;
      } else {
        specifyCtx += ` 【业务知识库】目标领域身份仍缺失：请等待上一轮 domain-explorer 完成或重试。`;
      }
    }
    if (gates.hasPlan && gates.specifyComplete === false) {
      specifyCtx +=
        ' 【强制】已检测到 plan.md 存在但规格未达标（常见于架构师反向打回：在 specify 增加 CQ，含接口文档补全）。必须先闭合澄清/补齐规格；与 plan 契约不一致时应在变更流程中用 sync-document 对齐或重跑 Plan。编排不得跳过 CQ 闭环。';
    }
    return { type: 'dispatch', agent: 'specflow-specify', context: specifyCtx };
  }

  if (phase === 'PlanReadiness') {
    if (!gates.canProceedToPlan)
      return {
        type: 'block',
        reason:
          '规格阶段未完成（存在 Blocker 或未闭合澄清）。**未闭合 [?] 时不得进入 Plan**（含架构师打回后需先补全接口/对接信息）。',
      };
    if (!gates.hasPlan && gates.technicalClarificationDebtCount > 0) {
      const ws = gates.workspaceRoot || '';
      const debt = Array.isArray(gates.technicalClarificationDebtItems)
        ? gates.technicalClarificationDebtItems.slice(0, 3).join('；')
        : '';
      return {
        type: 'dispatch',
        agent: 'specflow-specify-review',
        context:
          `引擎检测到澄清区的非阻塞/备注区存在技术澄清债务（${debt || '接口/字段/对接/Mock 边界待确认'}）。` +
          `这些项不得作为 Notes、Plan 内待办或非阻塞项降级处理；必须升格为技术澄清，使用「需要你决定 / 为什么关键 / SpecFlow 建议」格式，并执行 \`PLUGIN_ROOT=/path/to/specflow node "$PLUGIN_ROOT/tools/manage-state.cjs" mark-specify-review-blocked ${ws || '[workspaceRoot]'} ${id} "<阻塞原因>"\`。` +
          `禁止执行 ack-specify-review，禁止生成 plan.md，直到用户闭合技术澄清。`,
      };
    }
    if (
      !gates.hasPlan &&
      ((gates.specifyReviewStatus === 'blocked' &&
        gates.specifyReviewMtime === gates.specifyMtimeNow) ||
        gates.planReadinessGateBlocked === true)
    ) {
      return {
        type: 'block',
        reason:
          `技术方案前置评审仍为阻塞状态：${gates.planReadinessGateReason || gates.specifyReviewBlockReason || '存在技术方案制定阻塞'}。` +
          '请先在需求说明中生成并闭合对应的技术澄清问题；若已补齐，请重新执行架构评审。',
      };
    }

    // 尚无 plan.md：必须先完成架构师对 specify 的评审（与当前 specify 快照一致）；通过 manage-state ack-specify-review 落盘技术就绪状态
    if (!gates.hasPlan && !gates.specifyReviewValid) {
      const ws = gates.workspaceRoot || '';
      return {
        type: 'dispatch',
        agent: 'specflow-specify-review',
        context:
          `在首次生成 plan.md 之前，对 specify.md 做架构师评审：识别会阻塞技术方案制定的缺失（接口/字段/持久化/对外枚举、第三方对接依据等）。` +
          `若有阻塞：生成技术澄清状态（优先 .temp/clarifications.json 或最小澄清草稿），且必须使用「需要你决定 / 为什么关键 / SpecFlow 建议」的决策题格式；随后执行 \`PLUGIN_ROOT=/path/to/specflow node "$PLUGIN_ROOT/tools/manage-state.cjs" mark-specify-review-blocked ${ws || '[workspaceRoot]'} ${id} "<阻塞原因>"\`，**禁止**写入 plan.md、**禁止**执行 ack-specify-review。` +
          `若无阻塞：执行 \`PLUGIN_ROOT=/path/to/specflow node "$PLUGIN_ROOT/tools/manage-state.cjs" ack-specify-review ${ws || '[workspaceRoot]'} ${id} <confirmed|mock_allowed|not_required>\` 记录评审通过与技术就绪状态。` +
          `【强制】不得臆造契约；打回后先闭合澄清，再进入 Plan。`,
      };
    }
    // 尚无 plan.md：进入 Plan 子代理前，让用户确认开始技术方案。
    if (!gates.hasPlan) {
      const specifyPath =
        gates.pathSpecify || path.join(gates.dir, 'specify.md');
      const specifyMtime = getFileMtimeMs(specifyPath);
      const ackAt = gates.specifyAckMtime || 0;
      const needAck =
        !gates.ackSpecifyBeforePlan ||
        (!gates.planUserConfirmGateValid && specifyMtime > ackAt);
      if (needAck) {
        return {
          type: 'interaction_required',
          reason: '规格已就绪，进入技术方案前需你确认。',
          questions: [
            {
              id: 'confirm_start_plan',
              prompt:
                '需求说明已就绪，技术前置问题也已处理完。\n\n是否开始生成**技术方案**？',
              allow_multiple: false,
              options: [
                { id: 'confirm', label: '确认，开始写技术方案' },
                { id: 'cancel', label: '稍后再说，我先改业务说明' },
              ],
            },
          ],
        };
      }
    }
  }

  if (phase === 'Plan') {
    return {
      type: 'dispatch',
      agent: 'specflow-plan',
      context:
        '根据规格生成/更新技术方案（引擎已对当前 specify 快照做过 Plan Readiness 门禁）。【强制】若仍发现接口/对接文档缺失或业务未闭合，必须按 agents/specflow-plan.md 生成技术澄清并阻塞，禁止臆造契约；未闭合澄清前不得输出 plan。',
    };
  }

  if (phase === 'Implement') {
    if (!gates.specifyComplete || gates.clarificationOpen) {
      return {
        type: 'block',
        reason:
          '规格存在未闭合澄清或规格未达标（含架构师反向打回/接口文档补全）。必须先闭合 specify 中的 [?]，再运行引擎；禁止在主流程跳过 CQ。',
      };
    }
    if (gates.blockerCountInPlan > 0)
      return { type: 'block', reason: '方案存在 Blocker，无法实施。' };
    if (gates.hasBlockedTask)
      return {
        type: 'block',
        reason: 'Roadmap 中存在 Blocked 任务，请先解决。',
      };

    // 并行派发（仅自动托管时生效）：每个 Group 独立闭环，不互相等待。
    // autoProceedGroups 一旦由用户在 confirm_start_group 选择"自动托管"写入，就持续有效，
    // 直到 Roadmap 全部完成或用户通过 `set-active-group <id>`（不带 --auto）显式退出托管。
    if (
      gates.parallelEnabled === true &&
      Array.isArray(gates.parallelGroupActions)
    ) {
      if (gates.parallelGroupActions.length > 1) {
        return {
          type: 'dispatch_array',
          // 明确声明调度语义：任一 Group 完成即可触发该 Group 的下一步推进，不需要批量等齐。
          waitPolicy: 'any_done',
          groupIsolation: true,
          agents: gates.parallelGroupActions.map((action) => ({
            agent: action.agent,
            context: action.context,
            groupId: action.groupId,
            dependsOn: Array.isArray(action.dependsOn) ? action.dependsOn : [],
            ...(action.finalQa === true ? { finalQa: true } : {}),
          })),
        };
      }
      if (gates.parallelGroupActions.length === 1) {
        const action = gates.parallelGroupActions[0];
        if (
          gates.autoProceedGroups &&
          gates.activeGroupId !== action.groupId &&
          gates.dir
        ) {
          const { mergeState } = require('./specflow-state.cjs');
          mergeState(gates.dir, {
            activeGroup: action.groupId,
            groupRetryCount: 0,
          });
          gates.activeGroupId = action.groupId;
        }
        return {
          type: 'dispatch',
          agent: action.agent,
          context: action.context,
          groupId: action.groupId,
          ...(action.finalQa === true ? { finalQa: true } : {}),
        };
      }
    }

    // Group 级顺序控制：
    // 1. 找到第一个未完成的 Group (nextPendingGroup)
    // 2. 检查 state.activeGroup 是否与该 Group ID 一致
    // 3. 若不一致（说明之前的 Group 刚做完，或者刚开始），则 Block 并请求确认
    const targetGroup = gates.nextPendingGroup;

    // 如果没有待处理 Group，说明全部完成了，留给 Archive 阶段处理（由 detectPhase 转入 Archive）
    if (!targetGroup) {
      return {
        type: 'block',
        reason:
          '所有 Group 已完成，当前阶段应为 Archive（请重新运行引擎确认 phase）。',
      };
    }

    if (gates.activeGroupId !== targetGroup.id) {
      // autoProceedGroups=true：由用户在 confirm_start_group 中选「自动托管」写入；后续 Group 静默对齐 activeGroup，不再弹窗，直至全部完成或用户用 manage-state 取消托管。
      if (gates.autoProceedGroups) {
        const { mergeState } = require('./specflow-state.cjs');
        mergeState(gates.dir, {
          activeGroup: targetGroup.id,
          groupRetryCount: 0,
        });
        gates.activeGroupId = targetGroup.id;
      } else {
        const prevGroupDone = gates.activeGroupId
          ? `前序 Group (${gates.activeGroupId}) 已完成。\n\n`
          : '准备开始首个 Group。\n\n';

        return {
          type: 'interaction_required',
          reason:
            '需要确认是否开始新的 Group 实现（未开启自动托管时，每个新 Group 需确认；若已选自动托管则后续 Group 直至完成不再询问）。',
          questions: [
            {
              id: 'confirm_start_group',
              prompt: `${prevGroupDone}请确认是否开始 **${targetGroup.id}** 的实现流程？`,
              allow_multiple: false,
              options: [
                { id: 'confirm', label: `确认，开始执行 ${targetGroup.id}` },
                {
                  id: 'auto_proceed',
                  label: '自动托管：静默执行后续所有 Group 直至完成',
                },
                { id: 'cancel', label: '暂不开始' },
              ],
            },
          ],
          next_group_id: targetGroup.id,
        };
      }
    }

    const targetCounts =
      targetGroup && targetGroup.counts
        ? targetGroup.counts
        : { pending: 0, readyForQA: 0, failed: 0, completed: 0 };
    const pendingInGroup = Number(targetCounts.pending || 0);
    const readyForQAInGroup = Number(targetCounts.readyForQA || 0);
    const failedInGroup = Number(targetCounts.failed || 0);

    // Group 级闭环优先级：
    // 1) 当前 Group 仍有待开发任务 -> 继续开发
    // 2) 当前 Group 开发完成且有失败 -> Bug Fix
    // 3) 当前 Group 开发完成且待验收 -> QA
    if (pendingInGroup > 0) {
      return {
        type: 'dispatch',
        agent: 'specflow-implement',
        context: `按 Roadmap 执行编码 (当前: ${targetGroup.id}，待开发任务 ${pendingInGroup} 个)`,
      };
    }
    if (failedInGroup > 0) {
      if (gates.groupRetryCount > 3) {
        return {
          type: 'interaction_required',
          reason:
            '自动化修复重试次数过多（>3次），可能存在死循环。任务修复受阻。',
          questions: [
            {
              id: 'retry_limit_exceeded',
              prompt: `QA 连续 ${gates.groupRetryCount} 次验证失败，似乎陷入了死循环。请人工介入或选择后续策略：`,
              allow_multiple: false,
              options: [
                {
                  id: 'reset_retry',
                  label: '我已经人工干预修复了代码，请重置计数并继续 QA',
                },
                { id: 'show_logs', label: '暂停，请展示最新的错误日志' },
                {
                  id: 'force_pass',
                  label: '忽略报错，由我手动使用脚本强制标记任务完成',
                },
              ],
            },
          ],
        };
      }
      return {
        type: 'dispatch',
        agent: 'specflow-implement',
        context: `Bug Fix 模式：当前 Group (${targetGroup.id}) 存在 ${failedInGroup} 个 QA 验证失败任务（[!]），请根据 plan.md Log 区的 Failure Report 进行修复`,
      };
    }
    if (readyForQAInGroup > 0) {
      // isFinalQA：全局 pending/failed 为 0，且全局 ready-for-qa 全在当前 Group。
      // 为真时 QA 需要执行"阶段 B 收口"（一次 tsc --noEmit + plan 里 Final Gate 白名单）。
      // 并行模式下多 Group 同时到 [?] 时每个 Group 都不挂 FinalQA，等缩减到单个 Group 再触发，避免重复 tsc。
      const isFinalQA =
        gates.pendingTaskCount === 0 &&
        gates.failedTaskCount === 0 &&
        gates.readyForQACount === readyForQAInGroup;
      const baseContext = `当前 Group (${targetGroup.id}) 存在 ${readyForQAInGroup} 个待验收任务（[?]），请执行 QA 验证`;
      const finalHint =
        '\n\n[FinalQA=true] 本批验收通过后 Roadmap 将全绿。请在"阶段 A 最小验证"的基础上追加一次"阶段 B 收口"：' +
        'tsc --noEmit + plan.md 中 Final Gate 标注的回归 spec 白名单（若 plan 未给出则省略，并在 QA Log 注明）。' +
        '两段只执行一次，禁止回跑项目级或模块级 vitest。';
      return {
        type: 'dispatch',
        agent: 'specflow-qa',
        context: isFinalQA ? baseContext + finalHint : baseContext,
        finalQa: isFinalQA === true,
      };
    }
    return {
      type: 'block',
      reason: `当前 Group (${targetGroup.id}) 无可推进任务，请检查任务状态。`,
    };
  }

  if (phase === 'Archive') {
    if (gates.pendingTaskCount > 0)
      return { type: 'block', reason: '仍有未完成任务，无法归档。' };

    // 归档前置锚点：
    // - Roadmap 全绿并不代表"需求冻结"，测试期间仍可能产生变更；
    // - 因此在用户主动触发归档前，**不做任何领域/规范/资产合并**，只给出一条文字提示；
    // - 触发方式：用户在对话中表达"开始归档"等意图 → 编排层调
    //   `manage-state.cjs set-archive-anchor [workspace] <需求号>` → 下轮引擎再进入合并链。
    // history 路径（inHistory=true）跳过此锚点（已归档材料复审场景，不引入人机确认）。
    if (!inHistory && archiveAnchorRequired) {
      return {
        type: 'anchor',
        headline: '开发与验收已全部完成',
        message:
          '所有 Group 的实现与 QA 验收已完成，项目已具备归档条件。\n\n' +
          '为避免测试期间仍可能发生的需求变更被过早合并进知识库与代码规范，**不会主动开始归档**。\n\n' +
          '当您确认测试已通过、需求不再变更，需要归档时，请直接告知（例如"开始归档"），我将按序执行：领域知识合并 → 代码规范与知识补丁语义评审 → 全局资产合并 → 物理归档。',
        next: { action: 'set-archive-anchor' },
      };
    }

    // 以下所有步骤只在用户已触发 set-archive-anchor（archiveAnchorDone=true）后执行。
    // Step 1: 确保领域知识已被提取和合并（正向归档）
    if (!gates.domainMerged && !inHistory) {
      return {
        type: 'dispatch',
        agent: 'specflow-domain-explorer',
        mode: 'Merge',
        context:
          '归档准备：请评估本次需求所属的业务领域，并执行领域知识演进与合并 (Merge Mode)。',
      };
    }

    // Step 2: 语义评审（仅需求内补丁收敛；全局资产合并由 specflow-archive 统一执行）
    if (!inHistory && gates.domainMerged && gates.knowledgeReviewed !== true) {
      return {
        type: 'dispatch',
        agent: 'specflow-knowledge-reviewer',
        context:
          '归档进化：请完成本次需求知识与规范补丁的语义评审与去重；全局资产合并将在物理归档中统一执行。',
      };
    }

    // Step 3: 物理归档
    return {
      type: 'dispatch',
      agent: 'specflow-archive',
      context: '所有任务已完成，请执行物理归档',
    };
  }

  return { type: 'block', reason: '未知状态' };
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

function countBlockers(content) {
  const m = content.match(/\[BLOCKER\]/g);
  return m ? m.length : 0;
}

/** 归档前人工确认：由 manage-state set-archive-anchor 写入 archiveAnchorDone */
function isArchiveAnchorAllowed(dir) {
  const s = readState(dir);
  return s.archiveAnchorDone === true;
}

// parseClarification / isSpecifyComplete 已迁移至 plan-parser.cjs（AST + 锚点解析）

function detectPhase(
  hasSpecify,
  specifyComplete,
  hasPlan,
  planReadinessComplete,
  pendingTaskCount,
  readyForQACount,
  failedTaskCount,
  completedTaskCount,
) {
  if (!hasSpecify) return 'Init';
  // specify.md 存在但未完整生成（仅 Draft，缺少功能切片/验收要点）→ 仍停留在 Specify
  if (!specifyComplete) return 'Specify';
  if (!hasPlan && !planReadinessComplete) return 'PlanReadiness';
  if (!hasPlan) return 'Plan';
  // 任何非完成状态的任务存在 → 仍在 Implement 阶段（含 QA 验收子阶段）
  if (
    pendingTaskCount > 0 ||
    readyForQACount > 0 ||
    failedTaskCount > 0 ||
    completedTaskCount === 0
  )
    return 'Implement';
  return 'Archive';
}

const EXCLUDED_AI_DOCS_DIRS = new Set(['history', 'knowledge-base']);

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

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, UTF8));
  } catch {
    return fallback;
  }
}

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

/**
 * 自动托管（autoProceedGroups=true）下的 per-group 快照派发：
 * - 按每个 Group 当前状态派发 `specflow-implement`（含 Bug Fix 模式）或 `specflow-qa`，
 *   不同 Group 可以**同时**出现不同 agent（例如 A 已经到 [?] 派 QA，B 仍在 [ ] 派 implement）。
 * - per-group 的"implement→QA→fix→QA"闭环**由编排技能在 parent 层**按引擎下一轮的快照推进，
 *   而不是再引入一层中间子代理。
 */
/**
 * 从 Group 标题中解析"依赖 Group X"声明。
 * 支持格式（不区分大小写）：
 *   "（依赖 Group A）" / "（依赖: Group A、Group B）" / "（depends on Group A）"
 * 返回 string[]（被依赖的 groupId 列表，已 trim）。
 */
function parseGroupDependsOn(title) {
  if (!title) return [];
  // 匹配括号内的依赖声明，支持中英文括号
  const match = title.match(
    /[（(](?:依赖[：:]?\s*|depends\s+on\s+)(Group\s+\w+(?:[、,]\s*Group\s+\w+)*)[）)]/i,
  );
  if (!match) return [];
  return match[1]
    .split(/[、,]/)
    .map((s) => {
      const m = s.match(/(Group\s+\w+)/i);
      return m ? m[1].trim() : '';
    })
    .filter(Boolean);
}

function analyzeParallelGroupActions(planTree, globalCounts) {
  if (!planTree) return [];
  const roadmapSection = findByKey(planTree, 'roadmap');
  if (!roadmapSection) return [];

  const g =
    globalCounts && typeof globalCounts === 'object'
      ? {
          pending: Number(globalCounts.pendingTaskCount) || 0,
          failed: Number(globalCounts.failedTaskCount) || 0,
          readyForQA: Number(globalCounts.readyForQACount) || 0,
        }
      : { pending: 0, failed: 0, readyForQA: 0 };

  // 第一遍：收集所有 Group 的完成状态（无 pending/failed/readyForQA 任务视为已完成）
  const groupDoneSet = new Set();
  for (const node of roadmapSection.children) {
    const gid = (node.title.match(/(Group\s+\w+)/i) || [])[1];
    if (!gid) continue;
    const text = renderNode(node);
    const hasRemaining =
      (text.match(/^\s*-\s+\[\s\]\s+/gm) || []).length > 0 ||
      (text.match(/^\s*-\s+\[\?\]\s+/gm) || []).length > 0 ||
      (text.match(/^\s*-\s+\[!\]\s+/gm) || []).length > 0;
    if (!hasRemaining) groupDoneSet.add(gid.trim());
  }

  const actions = [];
  for (const node of roadmapSection.children) {
    const gid = (node.title.match(/(Group\s+\w+)/i) || [])[1];
    if (!gid) continue;
    const text = renderNode(node);
    const pending = (text.match(/^\s*-\s+\[\s\]\s+/gm) || []).length;
    const readyForQA = (text.match(/^\s*-\s+\[\?\]\s+/gm) || []).length;
    const failed = (text.match(/^\s*-\s+\[!\]\s+/gm) || []).length;
    const id = gid.trim();
    // 解析 Group 标题中声明的依赖（"（依赖 Group A）"格式）
    const dependsOn = parseGroupDependsOn(node.title);

    // 依赖门禁：若任一 dependsOn Group 尚未完成，跳过本 Group（等待依赖闭环后的下一轮快照）
    if (dependsOn.length > 0 && dependsOn.some((dep) => !groupDoneSet.has(dep)))
      continue;

    // 派发优先级：pending（编码）> failed（Bug Fix）> ready-for-qa（验收）
    // 同一 Group 只产出一个 action；不同 Group 可以同时出现 implement / qa / fix。
    if (pending > 0) {
      actions.push({
        groupId: id,
        agent: 'specflow-implement',
        context: `按 Roadmap 执行编码 (当前: ${id}，待开发任务 ${pending} 个)`,
        dependsOn,
      });
      continue;
    }
    if (failed > 0) {
      actions.push({
        groupId: id,
        agent: 'specflow-implement',
        mode: 'Bug Fix',
        context: `Bug Fix 模式：当前 Group (${id}) 存在 ${failed} 个 QA 验证失败任务（[!]），请根据 plan.md Log 区的 Failure Report 进行修复`,
        dependsOn,
      });
      continue;
    }
    if (readyForQA > 0) {
      // isFinalQA：全局 pending/failed 为 0 且全局 ready-for-qa 全在当前 Group。
      // 并行快照下多 Group 同时处于 [?] 时每个 Group 都不挂 FinalQA，等缩减到单个 Group 再触发。
      const isFinalQA =
        g.pending === 0 && g.failed === 0 && g.readyForQA === readyForQA;
      const baseContext = `当前 Group (${id}) 存在 ${readyForQA} 个待验收任务（[?]），请执行 QA 验证`;
      const finalHint =
        '\n\n[FinalQA=true] 本批验收通过后 Roadmap 将全绿。请在"阶段 A 最小验证"的基础上追加一次"阶段 B 收口"：' +
        'tsc --noEmit + plan.md 中 Final Gate 标注的回归 spec 白名单（若 plan 未给出则省略，并在 QA Log 注明）。' +
        '两段只执行一次，禁止回跑项目级或模块级 vitest。';
      actions.push({
        groupId: id,
        agent: 'specflow-qa',
        context: isFinalQA ? baseContext + finalHint : baseContext,
        finalQa: isFinalQA === true,
        dependsOn,
      });
    }
  }
  actions.sort((a, b) => a.groupId.localeCompare(b.groupId));
  return actions.slice(0, 4);
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
  const relevantDomains = selectRelevantDomains(
    workspaceRoot,
    hintText,
    2,
    domainAllowlist,
  );

  // 1) 需求级 business-domains（本期法典：Explorer 产出的活文档）
  const reqDomainDocs = readRequirementDomainDocs(
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
    extractTaskFilePaths,
    matchRulesForPaths,
    renderRuleLine,
  } = require('./code-style.cjs');

  const filePaths = extractTaskFilePaths(hintText || '');
  // 没有可抽取的路径时直接返回空（不应把全部规则兜底注入，避免噪声）
  if (filePaths.length === 0) return '';

  // 合并全局规则 + 需求级 code-style.md（若存在）；再按路径过滤
  const { globalRules } = readGlobalCodeStyleRules(workspaceRoot);
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
  if (hitRules.length === 0) return '';

  const lines = [
    '## 代码规范（按本次任务文件路径命中）',
    '',
    `> 本次 Active Group 涉及 ${filePaths.length} 个路径，命中 ${hitRules.length} 条规则；`,
    '> 未列出的规则默认与本次任务无关，若确有必要需在决策卡中显式引用。',
    '',
  ];
  for (const r of hitRules) {
    lines.push(renderRuleLine(r));
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
  // plan 生成阶段直接参考全局 code-style / architecture-layers；
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
  const tempClarification = parseTempClarifications(
    path.join(dir, '.temp', 'clarifications.json'),
  );
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
  const { isArchitectureLayersCalibrated } = require('./code-style.cjs');
  const architectureLayersReady =
    gatePassed(gateRegistry, 'init.architecture_layers') &&
    isArchitectureLayersCalibrated(workspaceRoot);
  const specifySnapshot = fileSnapshot(
    workspaceRoot,
    path.join('ai-docs', id, 'specify.md'),
  );
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
  const effectiveSpecifyReviewValid =
    specifyReviewValid || planReadinessGateValid;
  const effectiveAckSpecifyBeforePlan =
    (state.ackSpecifyBeforePlan === true &&
      specifyMtimeNow > 0 &&
      typeof state.specifyAckMtime === 'number' &&
      state.specifyAckMtime >= specifyMtimeNow) ||
    planUserConfirmGateValid;
  const planReadinessComplete =
    canProceedToPlan &&
    effectiveSpecifyReviewValid &&
    effectiveAckSpecifyBeforePlan &&
    !planReadinessGateBlocked &&
    technicalClarificationDebt.count === 0;
  const phase = detectPhase(
    hasSpecify,
    specifyComplete,
    hasPlan,
    planReadinessComplete,
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
    specifySnapshot,
    planReadinessGateValid,
    planReadinessGateBlocked,
    planReadinessGateReason:
      planReadinessGate && typeof planReadinessGate.reason === 'string'
        ? planReadinessGate.reason
        : '',
    planUserConfirmGateValid,
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
    domainMerged: state.domainMerged || false,
    knowledgeReviewed: state.knowledgeReviewed || false,
    codeStyleExplored: state.codeStyleExplored === true,
    codeStyleExploredMtime:
      typeof state.codeStyleExploredMtime === 'number'
        ? state.codeStyleExploredMtime
        : 0,
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
    !isArchiveAnchorAllowed(dir);

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
  if (
    suggestedAction.type === 'dispatch_array' &&
    Array.isArray(suggestedAction.agents)
  ) {
    // 先为每个 action 预计算 focusPlan（后续既作为 action.focusPlan，也作为 knowledgeContext 的 hint）
    const focusPlansByAction = new Map();
    for (const action of suggestedAction.agents) {
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
    const hintForKnowledge = suggestedAction.agents
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
    for (const action of suggestedAction.agents) {
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

    // 相关性提示优先使用 focusPlan，其次已有上下文；据此排序全局知识片段
    const knowledgeHint = computedFocusPlan || suggestedAction.context || '';
    const knowledgeContext = buildKnowledgeContext(
      workspaceRoot,
      id,
      knowledgeHint,
      { domainAllowlist: getKnowledgeDomainAllowlist(gates, id) },
    );
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
        knowledgePolicy: knowledgeContext
          ? {
              required: true,
              decisionCardFormat: '任务意图 | 采用规则(<=3) | 忽略规则及理由',
              logRequirement:
                'Ready-for-QA 或 QA Evidence 中必须回填 Knowledge Rules Used',
            }
          : null,
        mode: suggestedAction.mode,
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

module.exports = {
  runEngine,
  runEngineInner,
  buildKnowledgeContext,
  readDomainStatus,
  readRequirementDomainDocs,
  collectGlobalDomainKeys,
  renderLocalPatchSection,
  STATUS_RANK,
  STATUS_BANNER,
  DRAFT_CHUNK_CHAR_BUDGET,
};
