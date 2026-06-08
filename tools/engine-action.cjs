const fs = require("fs");
const path = require("path");
const { getFileMtimeMs, safeReadFile } = require("./engine-io.cjs");
const { appendClosedClarificationContext, extractDomainInitRefsFromAnswer, isDomainInitScanAnswer } = require("./engine-clarify.cjs");
const { inferInitDomainSlugs, listDomainDocs, readRequirementHintText } = require("./engine-knowledge.cjs");
const { normalizeDomainInitRef, domainRefToFileStem, domainRefSlug } = require("./specflow-state.cjs");

function getClosedDomainInitRefs(gates, id) {
  const closed = Array.isArray(gates.closedClarificationAnswers)
    ? gates.closedClarificationAnswers
    : [];
  const matched = closed.filter((item) => {
    const cqId = String(item && item.id ? item.id : "");
    return (
      item &&
      item.sourceKind === "temp" &&
      cqId.startsWith("CQ-Domain-Init") &&
      isDomainInitScanAnswer(item.answer)
    );
  });
  if (matched.length === 0) return [];
  const refs = matched.flatMap((item) => extractDomainInitRefsFromAnswer(item));
  if (refs.length > 0) return Array.from(new Set(refs));
  const inferred = inferInitDomainSlugs(gates, id);
  return inferred.length > 0 ? inferred : ["general"];
}

function handleGlobalGuards(gates, phase) {
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

  return null;
}

function handleInitOrSpecifyWithoutSpec(gates, id) {
  if (gates.architectureLayersReady !== true) {
    return {
      type: 'dispatch',
      agent: 'specflow-architecture-layers',
      context:
        '初始化项目分层画像：基于仓库目录、配置、路由/模块入口、典型文件与既有规范，写入 ai-docs/global-assets/standards/architecture-layers.md 的 ## Layers 章节。必须产出项目专属抽象 layer；禁止硬编码前端/后端固定分层，禁止写具体业务模块名。',
    };
  }

  // architecture layers 已就绪但全局 code-style 仍为空 → 初始化编码规则与 SOP 基线
  if (gates.codeStyleReady !== true) {
    const ws = gates.workspaceRoot || '';
    return {
      type: 'dispatch',
      agent: 'specflow-code-style-explorer',
      context:
        `全局 code-style.md 尚无编码规则或 SOP，需初始化项目代码规范基线。` +
        `读取 ai-docs/global-assets/standards/architecture-layers.md 获取分层定义，` +
        `扫描各 layer 的代表文件提取当前实际编码模式，` +
        `同时分析跨层 import/调用链路，识别项目内可复用的操作流程。` +
        `写入 ai-docs/global-assets/standards/code-style.md 的 ## Rules by Layer 与 ## SOPs 章节；` +
        `若扫描后没有足够证据形成 SOP，可保留 SOPs 为空，但必须说明已检查的链路与未生成原因。` +
        `只写可机械验证的通用编码规则（命名、目录、依赖方向、错误处理等）；` +
        `SOP 只写跨层、跨需求可复用的流程；禁止写业务字段、枚举、接口参数或具体业务模块名。`,
    };
  }

  // 2.5 Init：领域初始化——交互确认驱动，不做任何启发式扫描。
  //   两阶段协议：
  //     S1) 尚无 confirmed 且尚无 candidates：发 1 道 text 题，
  //         由 agent 结合项目（前端路由 / 后端 domain·service）与需求摘要，
  //         输出 1 或多个 domain ref（<scope>::<slug>），落盘至 state.domainInitCandidateRefs。
  //     S2) 有 candidate refs 但尚未产生 confirmed：对「全局缺失」的候选逐一发 yes/no 题，
  //         用户/agent 逐条采纳；全局已有的直接复用到 domainInitRefs。
  //   采纳结果统一落到 domainInitRefs（写法：set-domain-init-pref --pref scan --ref a::b,c::d）。
  //   之后若 business-domains/<slug>.md 缺失，按 dispatch_array（上限 5）并行派发。
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
          reason: '请确认本次需求应关联的业务知识库，用于后续需求澄清、规格生成和知识沉淀。',
          init_context: {
            requirementExcerpt,
            existingGlobalDomains: globalDomains,
          },
          questions: [
            {
              id: 'domain_init_candidates_text',
              prompt:
                [
                  '请确认本次需求的业务领域，用于需求澄清、规格生成和后续知识库沉淀。',
                  requirementExcerpt ? `本次需求摘要：${requirementExcerpt}` : '',
                  globalDomains.length > 0
                    ? `可复用的已有知识库文件：${globalDomains.map((d) => `${d}.md`).join('、')}`
                    : '当前还没有可复用的全局业务知识库文件。',
                  '',
                  '请给出一个或多个业务知识库文件名（不含 .md 也可以），优先复用已有文件；如果没有合适的，请给出本次应新建的文件名。',
                  '为了让系统同时定位代码边界，内部写入仍使用 <scope>::<slug>；其中 slug 会生成知识库文件名，scope 取本需求主要代码归属。',
                  '示例：短剧投流素材管理可写 packages/mini-program::short-drama-adserving；支付订单可写 services/order::payment。',
                  '允许多值，上限 8；多个用逗号分隔。',
                  '',
                  '写入命令示例：',
                  '  node $PLUGIN_ROOT/tools/manage-state.cjs set-domain-init-candidates <workspace> <requirementId> --ref packages/mini-program::short-drama-adserving,services/order::payment',
                ].filter(Boolean).join('\n'),
              allow_multiple: false,
              responseType: 'text',
              placeholder: 'packages/mini-program::short-drama-adserving',
              progressKey: 'interaction.domain_init_candidates',
              options: [],
            },
          ],
        };
      }

      // --- S2: 已有候选 → 对「全局缺失」的逐条 yes/no；全局已有的自动列入 accept ---
      const autoAccept = candidates.filter((ref) => globalSet.has(domainRefToFileStem(ref)));
      const needConfirm = candidates.filter((ref) => !globalSet.has(domainRefToFileStem(ref)));
      const questions = needConfirm.map((ref, idx) => {
        const stem = domainRefToFileStem(ref) || String(idx);
        const fileName = `${stem}.md`;
        const slug = domainRefSlug(ref) || ref;
        return {
          id: `domain_init_accept__${stem}`,
          progressKey: 'interaction.domain_init_accept',
          progressVariables: {
            domainRef: ref,
            fileName,
            domainFile: `business-domains/${fileName}`,
          },
          prompt: [
            `请确认是否为本次需求使用业务知识库「${fileName}」。`,
            requirementExcerpt ? `本次需求摘要：${requirementExcerpt}` : '',
            `系统识别的代码边界：${ref}`,
          ].filter(Boolean).join('\n'),
          allow_multiple: false,
          options: [
            { id: 'yes', label: '使用 / 创建' },
            { id: 'no', label: '跳过' },
          ],
        };
      });

      return {
        type: 'interaction_required',
        reason:
          autoAccept.length > 0
            ? `候选中已有 ${autoAccept.length} 个与全局领域重名，默认采纳；其余 ${needConfirm.length} 个请逐一确认。`
            : '请确认这些业务知识库是否用于本次需求。',
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
                    '这些候选均能复用已有业务知识库。确认后，我会把它们用于本次需求澄清与知识沉淀。',
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

    if (gates.specifyPreviewGateValid !== true) {
      const ws = gates.workspaceRoot || '';
      const blockedNote = gates.specifyPreviewGateBlocked
        ? `上次产品预审阻塞：${gates.specifyPreviewGateReason || '存在产品口径或验收阻塞'}。若用户已闭合澄清，请重新审查并决定是否通过。`
        : '首次生成 specify.md 前，先做产品口径预审。';
      return {
        type: 'dispatch',
        agent: 'specflow-specify-preview',
        context:
          `${blockedNote}` +
          `判断当前输入、已确认业务领域与业务知识库是否足以生成产品规格：重点检查范围边界、目标用户、业务对象/状态、权限可操作性、主流程门禁、验收口径和高风险动作。` +
          `若有高影响不确定点：只写入产品澄清到 .temp/clarifications.json，并执行 \`PLUGIN_ROOT=/path/to/specflow node "$PLUGIN_ROOT/tools/manage-state.cjs" mark-specify-preview-blocked ${ws || '[workspaceRoot]'} ${id} "<阻塞原因>"\`，禁止写 specify.md。` +
          `若无阻塞：执行 \`PLUGIN_ROOT=/path/to/specflow node "$PLUGIN_ROOT/tools/manage-state.cjs" ack-specify-preview ${ws || '[workspaceRoot]'} ${id}\`，禁止写 specify.md；下一轮再由 specflow-specify 成文。`,
      };
    }

    let initSpecifyCtx = '初始化已完成，请基于用户输入、已确认业务领域与全局资产骨架生成正式规格';
    const autoRef =
      (Array.isArray(gates.domainInitRefs) && gates.domainInitRefs[0]) ||
      '';
    if (autoRef) {
      initSpecifyCtx += `。已确认领域身份「${autoRef}」，编写需求说明前必须先阅读需求内 business-domains。`;
    }
    return {
      type: 'dispatch',
      agent: 'specflow-specify',
      context: appendClosedClarificationContext(initSpecifyCtx, gates),
    };
}

function handleSpecify(gates, id) {

    // CQ-Domain-Init 的单一真相源是 .temp/clarifications.json。
    // 用户选择扫描后，必须先补齐业务知识库，再继续生成正式 specify.md。
    const domainInitRefs = getClosedDomainInitRefs(gates, id);
    const pendingDomainRefs = Array.from(new Set(domainInitRefs)).filter((ref) => {
      const stem = domainRefToFileStem(ref) || String(ref || '').trim();
      if (!stem) return false;
      return !fs.existsSync(path.join(gates.dir, 'business-domains', `${stem}.md`));
    });
    if (pendingDomainRefs.length === 1) {
      return {
        type: 'dispatch',
        agent: 'specflow-domain-explorer',
        context: `目标领域身份: ${pendingDomainRefs[0]}。请扫描代码库逆向提取存量业务规则并初始化业务知识库。`,
      };
    }
    if (pendingDomainRefs.length > 1) {
      return {
        type: 'dispatch_array',
        items: pendingDomainRefs.slice(0, 5).map((ref) => ({
          agent: 'specflow-domain-explorer',
          groupId: `domain-init:${domainRefToFileStem(ref) || ref}`,
          context: `目标领域身份: ${ref}。请扫描代码库逆向提取存量业务规则并初始化业务知识库。`,
        })),
        waitPolicy: 'all',
      };
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
    return {
      type: 'dispatch',
      agent: 'specflow-specify',
      context: appendClosedClarificationContext(specifyCtx, gates),
    };
}

function handlePlanReadiness(gates, id) {

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
        agent: 'specflow-plan-preview',
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
        agent: 'specflow-plan-preview',
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
              progressKey: 'interaction.plan_confirm',
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

function handlePlan() {

    return {
      type: 'dispatch',
      agent: 'specflow-plan',
      context:
        '根据规格生成/更新技术方案（引擎已对当前 specify 快照做过 Plan Readiness 门禁）。【强制】若仍发现接口/对接文档缺失或业务未闭合，必须按 agents/specflow-plan.md 生成技术澄清并阻塞，禁止臆造契约；未闭合澄清前不得输出 plan。',
    };
}

function handleImplement(gates, id) {

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

    if (
      !gates.implementApprovalValid
    ) {
      const targetGroup = gates.nextPendingGroup;
      // 当 parseGroupsFromTree 因格式偏差返回空时，从 plan.md 原文兜底提取第一个 Group 名
      let targetGroupId = targetGroup && targetGroup.id ? targetGroup.id : '';
      if (!targetGroupId && gates.planContent) {
        const m = gates.planContent.match(/###[^\n]*\b(Group\s+\w+)/im);
        if (m) targetGroupId = m[1].trim();
      }
      const options = targetGroupId
        ? [
            { id: 'confirm', label: `只开始 ${targetGroupId}` },
            { id: 'auto_proceed', label: '自动托管，连续实现全部 Group' },
            { id: 'cancel', label: '稍后再说，我先调整技术方案' },
          ]
        : [
            { id: 'confirm', label: '确认，开始实现' },
            { id: 'cancel', label: '稍后再说，我先调整技术方案' },
          ];
      return {
        type: 'interaction_required',
        reason: targetGroupId
          ? '技术方案已生成，进入实现前需你审阅并选择执行策略。'
          : '技术方案已生成，进入实现前需你审阅并确认。',
        questions: [
          {
            id: 'confirm_start_implement',
            progressKey: 'interaction.implement_confirm',
            progressVariables: targetGroupId ? { nextGroup: targetGroupId } : {},
            prompt: targetGroupId
              ? `技术方案已经生成。\n\n请选择实现策略：只开始 **${targetGroupId}**，还是开启自动托管连续实现全部 Group？`
              : '技术方案已经生成。\n\n是否确认按当前方案进入**实现阶段**？',
            allow_multiple: false,
            options,
          },
        ],
      };
    }

    if (!gates.codeStyleSynced) {
      const ws = gates.workspaceRoot || '';
      return {
        type: 'dispatch',
        agent: 'specflow-code-style-explorer',
        context:
          `基于 plan.md 提炼本需求的代码规范增量（Additions / Overrides）。` +
          `读取 ai-docs/global-assets/standards/architecture-layers.md 做分层绑定，并读取 ai-docs/global-assets/standards/code-style.md 做去重；` +
          `只写需求新发现的规范，禁止复制全局已有规则。` +
          `完成后执行：\`PLUGIN_ROOT=/path/to/specflow node "$PLUGIN_ROOT/tools/manage-state.cjs" ack-code-style-sync ${ws || '[workspaceRoot]'} ${id}\`。`,
      };
    }

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
          items: gates.parallelGroupActions.map((action) => ({
            agent: action.agent,
            context: action.context,
            groupId: action.groupId,
            dependsOn: Array.isArray(action.dependsOn) ? action.dependsOn : [],
            ...(action.mode ? { mode: action.mode } : {}),
            ...(action.qaMode ? { qaMode: action.qaMode } : {}),
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
          ...(action.qaMode ? { qaMode: action.qaMode } : {}),
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
              progressKey: 'interaction.group_confirm',
              progressVariables: {
                nextGroup: targetGroup.id,
              },
              prompt: [
                prevGroupDone.trim(),
                '',
                `接下来要进入 **${targetGroup.id}**。技术方案已把工作拆成任务组，这一步是确认是否开始当前组的开发与验收。`,
                '',
                '你可以只开始当前组，也可以选择自动托管，让后续任务组在完成一个后继续推进。',
              ].join('\n'),
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
              progressKey: 'interaction.retry_limit_exceeded',
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
      // 为真时 QA 需要执行"阶段 B 收口"（仅执行本项目已证明安全的 Final Gate 验证）。
      // 并行模式下多 Group 同时到 [?] 时每个 Group 都不挂 FinalQA，等缩减到单个 Group 再触发，避免重复收口。
      const isFinalQA =
        gates.pendingTaskCount === 0 &&
        gates.failedTaskCount === 0 &&
        gates.readyForQACount === readyForQAInGroup;
      const baseContext = `当前 Group (${targetGroup.id}) 存在 ${readyForQAInGroup} 个待验收任务（[?]），请执行 QA 验证`;
      const finalHint =
        '\n\n[FinalQA=true] 本批验收通过后 Roadmap 将全绿。请在"阶段 A QA Lite"的基础上追加一次"阶段 B 收口"：' +
        '仅执行 Final Gate / Verification Contract 中已证明安全的局部收口验证；无法安全本地执行的全量回归写明 CI/manual 承接。' +
        '两段只执行一次，禁止回跑范围不明的项目级或模块级验证。';
      return {
        type: 'dispatch',
        agent: 'specflow-qa',
        context: isFinalQA ? baseContext + finalHint : baseContext,
        finalQa: isFinalQA === true,
        qaMode: 'lite',
      };
    }
    return {
      type: 'block',
      reason: `当前 Group (${targetGroup.id}) 无可推进任务，请检查任务状态。`,
    };
}

function handleArchive(gates, archiveAnchorRequired, inHistory) {

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

    // 以下所有步骤只在用户已触发 set-archive-anchor（archive.user_anchor=passed）后执行。
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

function determineAction(gates, phase, archiveAnchorRequired, id, inHistory) {
  const globalAction = handleGlobalGuards(gates, phase);
  if (globalAction) return globalAction;

  if ((phase === 'Init' || phase === 'Specify') && !gates.hasSpecify) {
    return handleInitOrSpecifyWithoutSpec(gates, id);
  }

  if (phase === 'Specify') return handleSpecify(gates, id);
  if (phase === 'PlanReadiness') return handlePlanReadiness(gates, id);
  if (phase === 'Plan') return handlePlan();
  if (phase === 'Implement') return handleImplement(gates, id);
  if (phase === 'Archive') return handleArchive(gates, archiveAnchorRequired, inHistory);

  return { type: 'block', reason: '未知状态' };
}


module.exports = { determineAction };
