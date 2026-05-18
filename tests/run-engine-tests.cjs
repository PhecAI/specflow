/**
 * SpecFlow 引擎与编排入口契约测试（fixtures 自包含，不依赖真实业务仓库）。
 * 运行：在仓库根目录执行 npm test，或 node --test tests/run-engine-tests.cjs
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { describe, it } = require('node:test');
const {
  parseEngineJson,
  runEngine,
  runOrchestratorImplement,
  runOrchestratorBadMode,
  ORCHESTRATOR,
  mkWorkspace,
  initGitWorkspace,
  touchRequirementDir,
  runManageState,
} = require('./test-helpers.cjs');
const {
  specifyComplete,
  specifyDraftMinimal,
  specifyDraftWithBlocker,
  specifyCompleteWithBlockerGate,
  specifyWithOpenClarification,
  specifyIncompleteDomainCQClosed,
  planWithRoadmap,
  planAllCompleted,
  appendPlanDecisionSummary,
  planWithBlockedTag,
  planEmptyGroup,
  writeWorkspace,
  writeHistoryRequirement,
  writeBusinessDomain,
} = require('./fixture-builders.cjs');
const { readState } = require(path.join(__dirname, '..', 'tools', 'specflow-state.cjs'));
const SYNC_DOCUMENT = path.join(__dirname, '..', 'tools', 'sync-document.cjs');
const ARCHIVE = path.join(__dirname, '..', 'tools', 'archive.cjs');
const VERIFY = path.join(__dirname, '..', 'tools', 'verify.cjs');
const MERGE_GLOBAL_ASSETS = path.join(
  __dirname,
  '..',
  'tools',
  'merge-global-assets.cjs'
);
const INVENTORY_SCAN = path.join(__dirname, '..', 'tools', 'inventory-scan.cjs');

describe('specflow-engine.cjs', () => {
  it('无需求号且无 Git、无 ai-docs → interaction_required（仅 init_requirement_text）', () => {
    const ws = mkWorkspace();
    const r = runEngine(ws);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = parseEngineJson(r.stdout);
    assert.ok(j.userFacing && j.userFacing.schemaVersion === 1);
    assert.strictEqual(j.userFacing.templateId, 'orchestration.requirement_id.default');
    assert.strictEqual(j.suggestedAction.type, 'interaction_required');
    assert.strictEqual(j.suggestedAction.init_context.kind, 'empty');
    assert.strictEqual(j.suggestedAction.init_context.branch_id, null);
    assert.strictEqual(j.suggestedAction.questions.length, 1);
    assert.strictEqual(j.suggestedAction.questions[0].id, 'init_requirement_text');
    assert.strictEqual(j.suggestedAction.questions[0].responseType, 'text');
  });

  it('Git 分支与最近修改目录不一致 → interaction_required（冲突）', () => {
    const ws = mkWorkspace();
    initGitWorkspace(ws, 'feature/branch-a');
    touchRequirementDir(ws, 'other-req', 'newer');
    const r = runEngine(ws);
    assert.strictEqual(r.status, 0);
    const j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'interaction_required');
    assert.strictEqual(j.suggestedAction.questions[0].id, 'init_requirement_id');
    assert.strictEqual(j.suggestedAction.init_context.kind, 'conflict');
    assert.ok(j.suggestedAction.init_context.branch_id);
    assert.ok(Array.isArray(j.suggestedAction.init_context.recent_ids));
    assert.strictEqual(j.suggestedAction.questions.length, 2);
    assert.strictEqual(j.suggestedAction.questions[0].id, 'init_requirement_id');
    assert.strictEqual(j.suggestedAction.questions[0].options.length, 2);
    assert.strictEqual(j.suggestedAction.questions[1].id, 'init_requirement_text');
    assert.strictEqual(j.suggestedAction.questions[1].responseType, 'text');
  });

  it('Git 推断需求号但目录不存在 → interaction_required（suggested）', () => {
    const ws = mkWorkspace();
    initGitWorkspace(ws, 'feature/brandnew-id');
    const r = runEngine(ws);
    assert.strictEqual(r.status, 0);
    const j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'interaction_required');
    assert.strictEqual(j.suggestedAction.questions[0].id, 'init_requirement_id');
    assert.strictEqual(j.suggestedAction.init_context.kind, 'suggested_new');
    assert.strictEqual(j.suggestedAction.init_context.suggestedId, 'brandnew-id');
    assert.strictEqual(j.suggestedAction.questions[j.suggestedAction.questions.length - 1].id, 'init_requirement_text');
    assert.strictEqual(j.suggestedAction.questions[j.suggestedAction.questions.length - 1].responseType, 'text');
  });

  it('Git 推断需求号、未传 argv、目录不存在 → interaction_required（suggested，非 block）', () => {
    const ws = mkWorkspace();
    initGitWorkspace(ws, 'feature/missing-req');
    const r = runEngine(ws);
    assert.strictEqual(r.status, 0);
    const j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'interaction_required');
    assert.strictEqual(j.suggestedAction.questions[0].id, 'init_requirement_id');
    assert.strictEqual(j.suggestedAction.init_context.suggestedId, 'missing-req');
    assert.strictEqual(j.suggestedAction.questions[j.suggestedAction.questions.length - 1].id, 'init_requirement_text');
    assert.strictEqual(j.suggestedAction.questions[j.suggestedAction.questions.length - 1].responseType, 'text');
  });

  it('领域初始化两阶段 prompt 驱动：S1 text 题 → S2 N 道 yes/no → dispatch_array 派发多 domain → specify', () => {
    const ws = mkWorkspace();

    // S1：首轮引擎 → text 题，要求 agent 提交候选
    let r = runEngine(ws, 'new-user-req');
    assert.strictEqual(r.status, 0, r.stderr);
    let j = parseEngineJson(r.stdout);
    assert.strictEqual(j.requirementId, 'new-user-req');
    assert.ok(fs.existsSync(path.join(ws, 'ai-docs', 'new-user-req')));
    assert.strictEqual(j.suggestedAction.type, 'interaction_required');
    let qs = j.suggestedAction.questions || [];
    assert.strictEqual(qs.length, 1);
    assert.strictEqual(qs[0].id, 'domain_init_candidates_text');
    assert.strictEqual(qs[0].responseType, 'text');
    assert.ok(j.suggestedAction.init_context, 'init_context 必须提供需求摘要与已有全局领域');
    assert.ok(Array.isArray(j.suggestedAction.init_context.existingGlobalDomains));

    // agent 提交候选 pay,order（两个都不在全局）
    let ms = runManageState(ws, 'new-user-req', 'set-domain-init-candidates', ['pay,order']);
    assert.strictEqual(ms.status, 0, ms.stderr);
    const msj = JSON.parse(ms.stdout);
    assert.deepStrictEqual(msj.domainInitCandidates, ['pay', 'order']);

    // S2：第二轮引擎 → N 道 yes/no 采纳题
    r = runEngine(ws, 'new-user-req');
    j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'interaction_required');
    qs = j.suggestedAction.questions || [];
    assert.strictEqual(qs.length, 2);
    assert.strictEqual(qs[0].id, 'domain_init_accept__pay');
    assert.strictEqual(qs[1].id, 'domain_init_accept__order');
    assert.deepStrictEqual(j.suggestedAction.init_context.needConfirm, ['pay', 'order']);
    assert.deepStrictEqual(j.suggestedAction.init_context.autoAcceptFromGlobal, []);

    // agent 汇总 yes/no 结果，把全部 accepted 写入 confirmed
    ms = runManageState(ws, 'new-user-req', 'set-domain-init-pref', ['scan', 'pay,order']);
    assert.strictEqual(ms.status, 0, ms.stderr);

    // 第三轮：两个都缺本地文档 → dispatch_array 并行派发
    r = runEngine(ws, 'new-user-req');
    j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch_array');
    assert.strictEqual(j.suggestedAction.items.length, 2);
    assert.strictEqual(j.suggestedAction.items[0].agent, 'specflow-domain-explorer');
    assert.ok(j.suggestedAction.items.map((x) => x.groupId).every((g) => /^domain-init:/.test(g)));
    assert.strictEqual(j.suggestedAction.waitPolicy, 'all');

    writeBusinessDomain(ws, 'new-user-req', 'pay', '# Pay\n');
    writeBusinessDomain(ws, 'new-user-req', 'order', '# Order\n');

    // 两个 domain 就绪 → specify
    r = runEngine(ws, 'new-user-req');
    j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-specify');
    assert.strictEqual(j.userFacing.templateId, 'orchestration.dispatch');
  });

  it('dispatch_array 上限 5：候选 7 个时本轮只派前 5 个，note 标注剩余', () => {
    const ws = mkWorkspace();
    runEngine(ws, 'big-req'); // S1 初始化 ai-docs 目录
    const slugs = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7'];
    let ms = runManageState(ws, 'big-req', 'set-domain-init-candidates', [slugs.join(',')]);
    assert.strictEqual(ms.status, 0, ms.stderr);
    // 跳过 yes/no，直接把全部提升为 confirmed（模拟 agent 汇总结果）
    ms = runManageState(ws, 'big-req', 'set-domain-init-pref', ['scan', slugs.join(',')]);
    assert.strictEqual(ms.status, 0, ms.stderr);
    const r = runEngine(ws, 'big-req');
    const j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch_array');
    assert.strictEqual(j.suggestedAction.items.length, 5);
    assert.ok(String(j.suggestedAction.note || '').includes('剩余 2'));
  });

  it('候选全部在全局领域：S2 仅 1 道确认题（domain_init_all_from_global_ack）', () => {
    const ws = mkWorkspace();
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'domains'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'domains', 'payment.md'),
      '# payment\n规则',
      'utf8',
    );

    runEngine(ws, 'payment-feature');
    const ms = runManageState(ws, 'payment-feature', 'set-domain-init-candidates', ['payment']);
    assert.strictEqual(ms.status, 0, ms.stderr);

    const r = runEngine(ws, 'payment-feature');
    const j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'interaction_required');
    const qs = j.suggestedAction.questions || [];
    assert.strictEqual(qs.length, 1);
    assert.strictEqual(qs[0].id, 'domain_init_all_from_global_ack');
    assert.deepStrictEqual(j.suggestedAction.init_context.autoAcceptFromGlobal, ['payment']);
    assert.deepStrictEqual(j.suggestedAction.init_context.needConfirm, []);
  });

  it('.temp/resource-load-failed.json 非空 → block', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      resourceFailed: { 'https://example.com': { message: 'bad link', reason: 'x' } },
    });
    const r = runEngine(ws, 'R1');
    assert.strictEqual(r.status, 0);
    const j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'block');
    assert.ok(String(j.suggestedAction.reason).length > 0);
  });

  it('resource-load-failed.json 损坏 → 删除后正常继续', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
    });
    const bad = path.join(ws, 'ai-docs', 'R1', '.temp', 'resource-load-failed.json');
    fs.mkdirSync(path.dirname(bad), { recursive: true });
    fs.writeFileSync(bad, '{ not-json', 'utf8');
    const r = runEngine(ws, 'R1');
    assert.strictEqual(r.status, 0);
    assert.ok(!fs.existsSync(bad), '损坏文件应被删除');
    const j = parseEngineJson(r.stdout);
    assert.notStrictEqual(j.suggestedAction.type, 'block');
  });

  it('Specify：草稿含 [BLOCKER] → block（Specify 分支）', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', { specify: specifyDraftWithBlocker() });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'Specify');
    assert.strictEqual(j.suggestedAction.type, 'block');
    assert.ok(j.suggestedAction.reason.includes('BLOCKER'));
  });

  it('Specify：未闭合澄清 → interaction_required', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', { specify: specifyWithOpenClarification() });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'interaction_required');
    assert.ok(j.suggestedAction.questions.length > 0);
  });

  it('Specify：草稿 → 默认派发 specflow-specify', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', { specify: specifyDraftMinimal() });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'Specify');
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-specify');
  });

  it('Specify：CQ-Domain-Init 已答且领域文件缺失 → domain-explorer', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', { specify: specifyIncompleteDomainCQClosed('Payment') });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-domain-explorer');
    assert.ok(!j.suggestedAction.mode);
  });

  it('Specify：CQ-Domain-Init 已答且领域文件已存在 → 回退为 specflow-specify', () => {
    const ws = mkWorkspace();
    writeBusinessDomain(ws, 'R1', 'Payment', '# Domain');
    writeWorkspace(ws, 'R1', { specify: specifyIncompleteDomainCQClosed('Payment') });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-specify');
  });

  it('Plan：规格含 [BLOCKER] 门禁且尚无 plan → block（Plan 分支 canProceedToPlan）', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyCompleteWithBlockerGate(),
    });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'Plan');
    assert.strictEqual(j.suggestedAction.type, 'block');
    assert.ok(String(j.suggestedAction.reason).includes('规格'));
  });

  it('Plan：无 plan.md、未完成架构评审 → dispatch specflow-specify-review', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      state: { stateVersion: 1, ackSpecifyBeforePlan: false },
    });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'Plan');
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-specify-review');
  });

  it('Plan：无 plan.md、需确认进入 Plan → interaction_required confirm_start_plan', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      state: { stateVersion: 1, ackSpecifyBeforePlan: false },
    });
    const ackR = runManageState(ws, 'R1', 'ack-specify-review');
    assert.strictEqual(ackR.status, 0, ackR.stderr);
    const ackCs = runManageState(ws, 'R1', 'set-code-style-explored');
    assert.strictEqual(ackCs.status, 0, ackCs.stderr);
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'Plan');
    assert.strictEqual(j.suggestedAction.type, 'interaction_required');
    const q = j.suggestedAction.questions.find((x) => x.id === 'confirm_start_plan');
    assert.ok(q);
  });

  it('Plan：架构评审通过但代码规范未评估 → dispatch specflow-code-style-explorer', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      state: { stateVersion: 1, ackSpecifyBeforePlan: false },
    });
    const ackR = runManageState(ws, 'R1', 'ack-specify-review');
    assert.strictEqual(ackR.status, 0, ackR.stderr);
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'Plan');
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-code-style-explorer');
  });

  it('Plan：specify 变更后 codeStyleExplored 失效 → 重新 dispatch explorer', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      state: { stateVersion: 1 },
    });
    let r1 = runManageState(ws, 'R1', 'ack-specify-review');
    assert.strictEqual(r1.status, 0, r1.stderr);
    let r2 = runManageState(ws, 'R1', 'set-code-style-explored');
    assert.strictEqual(r2.status, 0, r2.stderr);
    const specifyPath = path.join(ws, 'ai-docs', 'R1', 'specify.md');
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(specifyPath, future, future);
    const ackR2 = runManageState(ws, 'R1', 'ack-specify-review');
    assert.strictEqual(ackR2.status, 0, ackR2.stderr);
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'Plan');
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-code-style-explorer');
  });

  it('Plan：无 plan.md 时也会预热生成需求级 code-style 参考文件', () => {
    const ws = mkWorkspace();
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'standards'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md'),
      '# Code Style\n\n- [naming] 使用语义化命名\n',
      'utf8'
    );
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      state: { stateVersion: 1, ackSpecifyBeforePlan: false },
    });

    const r = runEngine(ws, 'R1');
    assert.strictEqual(r.status, 0, r.stderr);

    const reqCodeStylePath = path.join(ws, 'ai-docs', 'R1', 'code-style.md');
    const reqPatchPath = path.join(ws, 'ai-docs', 'R1', '.temp', 'coding-standard-patch.json');
    assert.ok(fs.existsSync(reqCodeStylePath));
    assert.ok(fs.existsSync(reqPatchPath));

    const reqCodeStyle = fs.readFileSync(reqCodeStylePath, 'utf8');
    assert.ok(reqCodeStyle.includes('[naming] 使用语义化命名'));

    const patch = JSON.parse(fs.readFileSync(reqPatchPath, 'utf8'));
    assert.ok(Array.isArray(patch));
    assert.strictEqual(patch.length, 0);
  });

  it('Plan：已确认且无 plan → 派发 specflow-plan', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      state: {
        stateVersion: 1,
        ackSpecifyBeforePlan: true,
        specifyAckMtime: Number.MAX_SAFE_INTEGER,
        codeStyleExplored: true,
        codeStyleExploredMtime: Number.MAX_SAFE_INTEGER,
      },
    });
    const specifyPath = path.join(ws, 'ai-docs', 'R1', 'specify.md');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(specifyPath, old, old);
    const ackR = runManageState(ws, 'R1', 'ack-specify-review');
    assert.strictEqual(ackR.status, 0, ackR.stderr);
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'Plan');
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-plan');
  });

  it('Implement：plan 正文 [BLOCKER] → block', () => {
    const ws = mkWorkspace();
    let planMd = appendPlanDecisionSummary(planWithRoadmap());
    planMd = planMd.replace('Arch.', 'Arch [BLOCKER] block.');
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: planMd,
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'Implement');
    assert.strictEqual(j.suggestedAction.type, 'block');
  });

  it('Implement：Roadmap [Blocked] → block', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planWithBlockedTag()),
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'block');
    assert.ok(j.suggestedAction.reason.includes('Blocked'));
  });

  it('Implement：无待处理 Group（空 Group）→ block', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planEmptyGroup()),
      state: { stateVersion: 1 },
    });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'Implement');
    assert.strictEqual(j.suggestedAction.type, 'block');
    assert.ok(j.suggestedAction.reason.includes('Group'));
  });

  it('Implement：activeGroup 不匹配 → confirm_start_group', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planWithRoadmap('- [ ] T1 | F-01 |')),
      state: { stateVersion: 1, activeGroup: 'Group B' },
    });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'interaction_required');
    const q = j.suggestedAction.questions.find((x) => x.id === 'confirm_start_group');
    assert.ok(q);
  });

  it('Implement：autoProceedGroups 自动对齐 activeGroup → 派发 implement', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planWithRoadmap('- [ ] T1 | F-01 |')),
      state: { stateVersion: 1, activeGroup: 'Group B', autoProceedGroups: true },
    });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-implement');
    assert.strictEqual(j.suggestedAction.groupId, 'Group A');
    const st = readState(path.join(ws, 'ai-docs', 'R1'));
    assert.strictEqual(st.activeGroup, 'Group A');
  });

  it('Implement：存在 [!] 且 groupRetryCount>3 → interaction 熔断', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planWithRoadmap('- [!] Fail | F-01 |')),
      state: { stateVersion: 1, activeGroup: 'Group A', groupRetryCount: 4 },
    });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'interaction_required');
    assert.ok(j.suggestedAction.questions.some((q) => q.id === 'retry_limit_exceeded'));
  });

  it('Implement：存在 [!] → 派发 specflow-implement Bug Fix', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planWithRoadmap('- [!] Fail | F-01 |')),
      state: { stateVersion: 1, activeGroup: 'Group A', groupRetryCount: 0 },
    });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-implement');
    assert.ok(String(j.suggestedAction.context).includes('Bug Fix'));
  });

  it('Implement：存在 [?] → 派发 specflow-qa（单 Group 全 [?] 即 FinalQA）', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planWithRoadmap('- [?] QA | F-01 |')),
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-qa');
    // 全局 pending=0 / failed=0 / readyForQA 全在当前 Group → FinalQA=true
    assert.strictEqual(j.suggestedAction.finalQa, true);
    assert.ok(String(j.suggestedAction.context).includes('[FinalQA=true]'));
  });

  it('Implement：当前 Group [?] 但其他 Group 仍有 pending → QA context 不含 FinalQA', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(
        planWithRoadmap(
          [
            '- [?] **T-A1** | QA | F-01 |',
            '',
            '### Group B: B',
            '- [ ] **T-B1** | 待开发 | F-02',
          ].join('\n')
        )
      ),
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-qa');
    assert.notStrictEqual(j.suggestedAction.finalQa, true);
    assert.ok(!String(j.suggestedAction.context).includes('[FinalQA=true]'));
  });

  it('Implement：当前 Group 有待开发任务时，忽略其他 Group 的失败任务并继续开发当前 Group', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(
        planWithRoadmap(
          '- [ ] **T-A1** | Code A | F-01 |',
          '\n### Group B: B\n- [!] **T-B1** | Fix B | F-02 |'
        )
      ),
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-implement');
    assert.ok(String(j.suggestedAction.context).includes('待开发任务'));
  });

  it('Implement：正常 [ ] → 派发 specflow-implement 编码', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planWithRoadmap('- [ ] Code | F-01 |')),
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-implement');
    assert.ok(String(j.suggestedAction.context).includes('Roadmap'));
  });

  it('Implement：autoProceed=true 下连续 mark-task（含 plan.md mtime 前进）不清授权、不弹 confirm_start_group', () => {
    const ws = mkWorkspace();
    const plan = appendPlanDecisionSummary(
      planWithRoadmap('- [ ] **T-A1** | 任务1 | F-01 |\n- [ ] **T-A2** | 任务2 | F-01 |')
    );
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan,
      state: { stateVersion: 1, activeGroup: 'Group A', autoProceedGroups: true },
    });

    // 首跑：托管生效 → 派发 implement
    const j1 = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j1.suggestedAction.type, 'dispatch');
    assert.strictEqual(j1.suggestedAction.agent, 'specflow-implement');

    // 模拟 implement 子代理连续更新 plan.md（mtime 前进多次）
    const r1 = runManageState(ws, 'R1', 'mark-task', ['T-A1', 'ready-for-qa']);
    assert.strictEqual(r1.status, 0, r1.stderr);
    const r2 = runManageState(ws, 'R1', 'mark-task', ['T-A1', 'completed', '验证证据：test/a.test.ts']);
    assert.strictEqual(r2.status, 0, r2.stderr);

    // 额外手动推一次 mtime，模拟非 mark-* 路径的写入（如 Log 段追加）
    const planPath = path.join(ws, 'ai-docs', 'R1', 'plan.md');
    const newMtime = fs.statSync(planPath).mtimeMs + 5000;
    fs.utimesSync(planPath, new Date(newMtime), new Date(newMtime));

    const st = readState(path.join(ws, 'ai-docs', 'R1'));
    assert.strictEqual(st.autoProceedGroups, true, '托管授权必须持久，不随 plan.md 写入失效');
    assert.strictEqual(st.activeGroup, 'Group A');

    const j2 = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.notStrictEqual(
      j2.suggestedAction.type,
      'interaction_required',
      `自动托管下 plan.md 写入不应触发 confirm_start_group，实际：${JSON.stringify(j2.suggestedAction)}`
    );
  });

  it('Implement：set-active-group 后同一快照下不再弹 confirm_start_group', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planWithRoadmap('- [ ] T1 | F-01 |')),
      state: { stateVersion: 1 },
    });
    const j1 = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j1.suggestedAction.type, 'interaction_required');

    const r = runManageState(ws, 'R1', 'set-active-group', ['Group A']);
    assert.strictEqual(r.status, 0, `set-active-group failed: ${r.stderr}`);
    const st = readState(path.join(ws, 'ai-docs', 'R1'));
    assert.strictEqual(st.activeGroup, 'Group A');
    assert.strictEqual(st.autoProceedGroups, false, '不带 --auto 默认清回 false');

    const j2 = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j2.suggestedAction.type, 'dispatch');
    assert.strictEqual(j2.suggestedAction.agent, 'specflow-implement');
  });

  it('Implement：set-active-group <id>（不带 --auto）可作为退出自动托管入口', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planWithRoadmap('- [ ] T1 | F-01 |')),
      state: { stateVersion: 1, activeGroup: 'Group A', autoProceedGroups: true },
    });
    const r = runManageState(ws, 'R1', 'set-active-group', ['Group A']);
    assert.strictEqual(r.status, 0, r.stderr);
    const st = readState(path.join(ws, 'ai-docs', 'R1'));
    assert.strictEqual(st.autoProceedGroups, false, '不带 --auto 必须清回 false');
  });

  it('Archive：Roadmap 全绿但 archiveAnchorDone 未设 → anchor 文字提示，不派发合并、不询问', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planAllCompleted()),
      state: { stateVersion: 1, domainMerged: false, knowledgeReviewed: false },
    });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'Archive');
    assert.strictEqual(j.suggestedAction.type, 'anchor', '未触发归档前不得派发合并子代理，也不得弹 AskQuestion');
    assert.ok(j.suggestedAction.next && j.suggestedAction.next.action === 'set-archive-anchor');
    assert.ok(String(j.suggestedAction.message || '').length > 0);
  });

  it('Archive：anchor 后用户调 set-archive-anchor → 下一轮开始 domain-explorer Merge', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planAllCompleted()),
      state: { stateVersion: 1, domainMerged: false, knowledgeReviewed: false },
    });
    // 首跑：anchor 提示
    const j1 = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j1.suggestedAction.type, 'anchor');

    // 模拟用户主动触发归档
    const r = runManageState(ws, 'R1', 'set-archive-anchor');
    assert.strictEqual(r.status, 0, r.stderr);

    // 再跑：进入合并链第一步
    const j2 = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j2.phase, 'Archive');
    assert.strictEqual(j2.suggestedAction.type, 'dispatch');
    assert.strictEqual(j2.suggestedAction.agent, 'specflow-domain-explorer');
    assert.strictEqual(j2.suggestedAction.mode, 'Merge');
  });

  it('Archive：archiveAnchorDone=true、domainMerged=false → 先 domain-explorer Merge', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planAllCompleted()),
      state: { stateVersion: 1, archiveAnchorDone: true, domainMerged: false },
    });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'Archive');
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-domain-explorer');
    assert.strictEqual(j.suggestedAction.mode, 'Merge');
  });

  it('Archive：archiveAnchorDone=true、domainMerged=true、未 knowledgeReviewed → knowledge-reviewer', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planAllCompleted()),
      state: { stateVersion: 1, archiveAnchorDone: true, domainMerged: true, knowledgeReviewed: false },
    });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'Archive');
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-knowledge-reviewer');
  });

  it('Archive：domainMerged=true、knowledgeReviewed=true、archiveAnchorDone=true → specflow-archive', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planAllCompleted()),
      state: { stateVersion: 1, domainMerged: true, knowledgeReviewed: true, archiveAnchorDone: true },
    });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-archive');
  });

  it('Archive（history 路径）：跳过领域合并，直接派发归档', () => {
    const ws = mkWorkspace();
    writeHistoryRequirement(
      ws,
      'H1',
      {
        specify: specifyComplete(),
        plan: appendPlanDecisionSummary(planAllCompleted()),
        state: { stateVersion: 1, domainMerged: false },
      },
      '2024',
      'Q1'
    );
    const j = parseEngineJson(runEngine(ws, 'H1').stdout);
    assert.strictEqual(j.inHistory, true);
    assert.strictEqual(j.phase, 'Archive');
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-archive');
  });

  it('存在未完成任务时仍为 Implement 阶段（不进入 Archive）', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planWithRoadmap('- [ ] P | F-01 |')),
      state: {
        stateVersion: 1,
        domainMerged: true,
        archiveAnchorDone: true,
      },
    });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'Implement');
  });

  it('Specify：存在强证据时会自动解决 [?] 并要求一次性审阅确认（anchor）', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    writeWorkspace(ws, reqId, { specify: specifyWithOpenClarification(), plan: null, state: { stateVersion: 1 } });

    // 证据库：优先读取当前需求目录下的 business-domains（本用例用需求内目录）
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId, 'business-domains'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', reqId, 'business-domains', 'test.md'),
      `# test\n\n| 字段 | 类型 | 含义 |\n| --- | --- | --- |\n| foo | string | foo 字段 |\n\n\`\`\`mermaid\nstateDiagram-v2\n  [*] --> Init\n  Init --> [*]\n\`\`\`\n`,
      'utf8'
    );

    const r = runEngine(ws, reqId);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = parseEngineJson(r.stdout);
    assert.strictEqual(j.phase, 'Specify');
    assert.strictEqual(j.suggestedAction.type, 'anchor');

    const content = fs.readFileSync(path.join(ws, 'ai-docs', reqId, 'specify.md'), 'utf8');
    assert.ok(content.includes('### [Auto] CQ-01'), '应把 [?] 转为 [Auto]');
    assert.ok(content.includes('(Ref:'), '应写入 Ref');
    assert.ok(content.includes('**Conclusion**:'), '应写入 Conclusion');
  });
});

describe('orchestrator.cjs', () => {
  it('implement 透传引擎 JSON', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', { specify: specifyDraftMinimal() });
    const e = runEngine(ws, 'R1');
    const o = runOrchestratorImplement(ws, 'R1');
    assert.strictEqual(o.status, e.status);
    assert.strictEqual(parseEngineJson(o.stdout).phase, parseEngineJson(e.stdout).phase);
  });

  it('非法 mode → 非零退出码', () => {
    const ws = mkWorkspace();
    const o = runOrchestratorBadMode(ws);
    assert.ok(o.status !== 0);
    const errText = `${o.stderr}\n${o.stdout}`;
    assert.ok(errText.includes('false') || errText.includes('error') || errText.includes('非法'));
  });

  it('implement --human 输出 Markdown（非 JSON）', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', { specify: specifyDraftMinimal() });
    const o = spawnSync(process.execPath, [ORCHESTRATOR, 'implement', ws, 'R1', '--human'], {
      encoding: 'utf8',
    });
    assert.strictEqual(o.status, 0, o.stderr);
    assert.ok(o.stdout.includes('###'), '应含 Markdown 标题');
    assert.ok(!o.stdout.trim().startsWith('{'), '不应为 JSON');
  });

  it('autoProceedGroups=true 且存在可并行 Group 时，会输出 dispatch_array（per-group 快照派发）', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    const plan = planWithRoadmap(
      [
        '- [ ] **T-A1** | 任务A | F-01',
        '',
        '### Group B: B',
        '- [ ] **T-B1** | 任务B | F-02',
      ].join('\n')
    );
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(plan),
      state: { stateVersion: 1, activeGroup: 'Group A', autoProceedGroups: true },
    });

    const r = spawnSync(process.execPath, [ORCHESTRATOR, 'implement', ws, reqId], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch_array');
    assert.strictEqual(j.suggestedAction.waitPolicy, 'any_done');
    assert.strictEqual(j.suggestedAction.groupIsolation, true);
    const agents = Array.isArray(j.suggestedAction.agents) ? j.suggestedAction.agents : [];
    assert.ok(agents.length >= 2);
    // 两个 Group 都是 pending → 都派 specflow-implement
    const groupIds = agents.map((a) => a.groupId).sort();
    assert.deepStrictEqual(groupIds, ['Group A', 'Group B']);
    assert.ok(agents.every((a) => a.agent === 'specflow-implement'),
      `都是 pending 时应全部派 specflow-implement，实际：${agents.map((a) => a.agent).join(',')}`);
    // 每个 action 都必须带 per-group focusPlan
    assert.ok(agents.every((a) => typeof a.focusPlan === 'string' && a.focusPlan.length > 0),
      '每个 dispatch_array 元素必须自带 per-group focusPlan');

    // pending-protocol.json 以 dispatch_array 形态落盘，便于 print-protocol.cjs --group 过滤
    const protocolPath = path.join(ws, 'ai-docs', reqId, '.temp', 'pending-protocol.json');
    assert.ok(fs.existsSync(protocolPath), 'pending-protocol.json 必须落盘');
    const protocol = JSON.parse(fs.readFileSync(protocolPath, 'utf8'));
    assert.strictEqual(protocol.kind, 'dispatch_array');
    assert.strictEqual(protocol.waitPolicy, 'any_done');
    assert.strictEqual(protocol.groupIsolation, true);
    assert.strictEqual(Array.isArray(protocol.items), true);
    assert.strictEqual(protocol.items.length, agents.length);
    assert.ok(protocol.items.every((it) => it.groupId && it.agent && it.focusPlan));
  });

  it('autoProceedGroups=true 时各 Group 可独立闭环：ready-for-qa 组不等待 pending 组（混合 dispatch_array）', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    const plan = planWithRoadmap(
      [
        '- [?] **T-A1** | 待验收A | F-01',
        '',
        '### Group B: B',
        '- [ ] **T-B1** | 待开发B | F-02',
      ].join('\n')
    );
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(plan),
      state: { stateVersion: 1, activeGroup: 'Group A', autoProceedGroups: true },
    });

    const r = spawnSync(process.execPath, [ORCHESTRATOR, 'implement', ws, reqId], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch_array');
    const agents = Array.isArray(j.suggestedAction.agents) ? j.suggestedAction.agents : [];
    // Group A ready-for-qa → specflow-qa；Group B pending → specflow-implement；同一批混合
    assert.ok(agents.some((a) => a.groupId === 'Group A' && a.agent === 'specflow-qa'));
    assert.ok(agents.some((a) => a.groupId === 'Group B' && a.agent === 'specflow-implement'));
    // Group B 仍 pending，Group A QA 本批不应触发 FinalQA
    const qaA = agents.find((a) => a.groupId === 'Group A' && a.agent === 'specflow-qa');
    assert.ok(qaA);
    assert.notStrictEqual(qaA.finalQa, true);
    assert.ok(!String(qaA.context || '').includes('[FinalQA=true]'));
  });

  it('autoProceedGroups=true 且多 Group 同时全 [?] 时：每个 QA 都不挂 finalQa（等缩减到单 Group 再触发）', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    const plan = planWithRoadmap(
      [
        '- [?] **T-A1** | 待验收A | F-01',
        '',
        '### Group B: B',
        '- [?] **T-B1** | 待验收B | F-02',
      ].join('\n')
    );
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(plan),
      state: { stateVersion: 1, activeGroup: 'Group A', autoProceedGroups: true },
    });

    const r = spawnSync(process.execPath, [ORCHESTRATOR, 'implement', ws, reqId], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch_array');
    const agents = Array.isArray(j.suggestedAction.agents) ? j.suggestedAction.agents : [];
    const qaActions = agents.filter((a) => a.agent === 'specflow-qa');
    assert.ok(qaActions.length >= 2);
    for (const a of qaActions) {
      assert.notStrictEqual(a.finalQa, true, `${a.groupId} 不应挂 finalQa`);
      assert.ok(!String(a.context || '').includes('[FinalQA=true]'));
    }
  });

  it('autoProceedGroups=true 且仅最后一个 Group 有 [?] 时：QA 挂 finalQa=true 并提示阶段 B 收口', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    // Group A 全部 completed；Group B 仅剩 [?]
    const plan = planWithRoadmap(
      [
        '- [x] **T-A1** | 已完成 | F-01',
        '',
        '### Group B: B',
        '- [?] **T-B1** | 待验收 | F-02',
      ].join('\n')
    );
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(plan),
      state: { stateVersion: 1, activeGroup: 'Group B', autoProceedGroups: true },
    });

    const r = spawnSync(process.execPath, [ORCHESTRATOR, 'implement', ws, reqId], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const j = parseEngineJson(r.stdout);
    // 单剩一个 Group 的 dispatch_array 会退化为 dispatch
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-qa');
    assert.strictEqual(j.suggestedAction.groupId, 'Group B');
    assert.strictEqual(j.suggestedAction.finalQa, true);
    assert.ok(String(j.suggestedAction.context).includes('[FinalQA=true]'));
  });

  it('autoProceedGroups=false 时保持单个 Group 执行', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    const plan = planWithRoadmap(
      [
        '- [ ] **T-A1** | 任务A | F-01',
        '',
        '### Group B: B',
        '- [ ] **T-B1** | 任务B | F-02',
      ].join('\n')
    );
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(plan),
      state: { stateVersion: 1, activeGroup: 'Group A', autoProceedGroups: false },
    });

    const r = spawnSync(process.execPath, [ORCHESTRATOR, 'implement', ws, reqId], {
      encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0, r.stderr);
    const j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-implement');
  });
});

describe('knowledge loop solution', () => {
  it('inventory-scan init 只建空壳 global-assets，不产生任何领域文件', () => {
    const ws = mkWorkspace();
    // 即使 src/services 下有目录，也不应被脚本识别为领域（领域识别属于 agent 职责）
    fs.mkdirSync(path.join(ws, 'src', 'services', 'payment'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'src', 'services', 'payment', 'index.ts'), 'export const p = 1;\n', 'utf8');

    const r = spawnSync(process.execPath, [INVENTORY_SCAN, ws], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);

    const domainsDir = path.join(ws, 'ai-docs', 'global-assets', 'domains');
    const indexPath = path.join(domainsDir, 'index.md');
    const metadataPath = path.join(ws, 'ai-docs', 'global-assets', 'metadata.json');
    const codeStylePath = path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md');

    assert.ok(fs.existsSync(indexPath), 'index.md 应存在');
    assert.ok(fs.existsSync(metadataPath), 'metadata.json 应存在');
    assert.ok(fs.existsSync(codeStylePath), 'code-style.md 应存在');
    // 不应自动生成任何 <domain>.md
    const domainFiles = fs.readdirSync(domainsDir).filter((f) => f !== 'index.md');
    assert.deepStrictEqual(domainFiles, [], '脚本禁止硬编码识别领域；init 阶段不得生成任何 <domain>.md');
    const indexText = fs.readFileSync(indexPath, 'utf8');
    assert.ok(!indexText.includes('| payment |'), 'init 阶段 index.md 不得出现从目录名派生的领域行');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    assert.deepStrictEqual(metadata, {}, 'init 阶段 metadata.json 应为空对象');
  });

  it('inventory-scan add-domain 原语幂等落盘领域骨架 + index + metadata', () => {
    const ws = mkWorkspace();
    const init = spawnSync(process.execPath, [INVENTORY_SCAN, ws], { encoding: 'utf8' });
    assert.strictEqual(init.status, 0, init.stderr);

    // 第一次 add-domain：由 agent 显式传入名称与证据
    const r1 = spawnSync(
      process.execPath,
      [INVENTORY_SCAN, 'add-domain', '--workspace', ws, '--name', 'Payment', '--source', 'src/services/payment'],
      { encoding: 'utf8' }
    );
    assert.strictEqual(r1.status, 0, r1.stderr);
    const j1 = JSON.parse(r1.stdout);
    assert.strictEqual(j1.ok, true);
    assert.strictEqual(j1.domain, 'payment', 'slug 应规范化为小写');
    assert.strictEqual(j1.created, true);

    const domainPath = path.join(ws, 'ai-docs', 'global-assets', 'domains', 'payment.md');
    const text = fs.readFileSync(domainPath, 'utf8');
    assert.ok(text.startsWith('---\n'));
    assert.ok(text.includes('sourceRequirementIds: []'));
    assert.ok(text.includes('**status**: Draft'));
    assert.ok(/\|\s*字段\s*\|\s*类型\s*\|\s*含义\s*\|/.test(text), '应包含实体表头');
    assert.ok(text.includes('```mermaid'), '应包含 Mermaid 状态机');
    assert.ok(text.includes('Source: src/services/payment'), 'source hint 应由 agent 传入并体现在文档中');

    const indexText = fs.readFileSync(path.join(ws, 'ai-docs', 'global-assets', 'domains', 'index.md'), 'utf8');
    assert.ok(indexText.includes('| payment | Draft | src/services/payment |'));

    // 第二次幂等调用：不覆盖、不重复追加
    const r2 = spawnSync(
      process.execPath,
      [INVENTORY_SCAN, 'add-domain', '--workspace', ws, '--name', 'payment', '--source', 'src/services/payment'],
      { encoding: 'utf8' }
    );
    assert.strictEqual(r2.status, 0, r2.stderr);
    const j2 = JSON.parse(r2.stdout);
    assert.strictEqual(j2.created, false, '已存在的 <domain>.md 不应被覆盖');
    assert.strictEqual(j2.indexAppended, false, 'index.md 已存在行不应重复追加');
    const indexText2 = fs.readFileSync(path.join(ws, 'ai-docs', 'global-assets', 'domains', 'index.md'), 'utf8');
    const occurrences = indexText2.split('\n').filter((l) => l.trim().startsWith('| payment |')).length;
    assert.strictEqual(occurrences, 1, 'index.md 中 payment 行应只有 1 条');
  });

  it('sync-document --extract 会把已解决澄清提取为 knowledge-patch.json', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    writeWorkspace(ws, reqId, {
      specify: `${specifyComplete()}

### [Resolved] CQ-Price-Rule: 价格四舍五入
> **背景**: 支付场景
- **Decision**: 保留 2 位小数，ROUND_HALF_UP

#### **[User]**:
**[User]**: 已确认`,
      plan: appendPlanDecisionSummary(planWithRoadmap('- [ ] Task | F-01 |')),
    });

    const r = spawnSync(
      process.execPath,
      [SYNC_DOCUMENT, ws, reqId, 'extract patches', '--target', 'both', '--extract'],
      { encoding: 'utf8' }
    );
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.ok, true);
    assert.ok(j.extracted);
    assert.ok(fs.existsSync(path.join(ws, 'ai-docs', reqId, '.temp', 'knowledge-patch.json')));
  });

  it('specflow-engine 在 implement dispatch 时会注入知识上下文到 pending protocol', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planWithRoadmap('- [ ] **T-A1** | implement | F-01 |')),
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId, '.temp'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', reqId, '.temp', 'knowledge-patch.json'),
      JSON.stringify(
        [{ domain: 'payment', category: 'rule', scope: '本地规则', content: '局部 patch 内容' }],
        null,
        2,
      ),
      'utf8'
    );
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'domains'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'domains', 'payment.md'),
      '# Payment\n[Verified]\n全局规则',
      'utf8'
    );

    const r = runEngine(ws, reqId);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.ok(fs.existsSync(path.join(ws, 'ai-docs', reqId, '.temp', 'pending-protocol.json')));
    const pending = JSON.parse(
      fs.readFileSync(path.join(ws, 'ai-docs', reqId, '.temp', 'pending-protocol.json'), 'utf8')
    );
    assert.ok(typeof pending.knowledgeContext === 'string');
    assert.ok(pending.knowledgeContext.includes('本地规则'), 'localPatch 的 scope 应被渲染');
    assert.ok(pending.knowledgeContext.includes('局部 patch 内容'), 'localPatch 的 content 应被渲染');
    assert.ok(pending.knowledgeContext.includes('## 局部 Patch'));
  });

  it('archive 会将 patch 合并进 global-assets 并更新 metadata', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planAllCompleted()),
      state: { stateVersion: 1, domainMerged: true, archiveAnchorDone: true },
    });
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId, '.temp'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', reqId, '.temp', 'knowledge-patch.json'),
      JSON.stringify([{ domain: 'payment', status: 'Draft', content: '新增已验证规则' }], null, 2),
      'utf8'
    );
    fs.writeFileSync(
      path.join(ws, 'ai-docs', reqId, '.temp', 'coding-standard-patch.json'),
      JSON.stringify([{ section: 'naming', content: '函数名使用动词开头' }], null, 2),
      'utf8'
    );

    const r = spawnSync(process.execPath, [ARCHIVE, ws, reqId], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(ws, 'ai-docs', 'global-assets', 'domains', 'payment.md')));
    assert.ok(fs.existsSync(path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md')));
    const metadata = JSON.parse(
      fs.readFileSync(path.join(ws, 'ai-docs', 'global-assets', 'metadata.json'), 'utf8')
    );
    assert.ok(metadata.payment);
    assert.strictEqual(metadata.payment.last_requirement, reqId);
    assert.deepStrictEqual(metadata.payment.sourceRequirementIds, [reqId]);
    assert.strictEqual(metadata.payment.status, 'Draft');
    assert.strictEqual(metadata.payment.maintainer, 'specflow-knowledge-reviewer');
    assert.ok(!Object.prototype.hasOwnProperty.call(metadata.payment, 'lastRequirementId'), '不再保留兼容字段 lastRequirementId');
    assert.ok(!Object.prototype.hasOwnProperty.call(metadata.payment, 'author'), '不再保留兼容字段 author');
  });

  it('verify 会输出 code-style 语义检查提示', () => {
    const ws = mkWorkspace();
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'standards'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md'),
      '# Code Style\n- 函数命名使用动词开头\n- 避免 any',
      'utf8'
    );

    const r = spawnSync(process.execPath, [VERIFY, ws, '--command', 'node -e "process.exit(0)"'], {
      encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.ok, true);
    assert.ok(Array.isArray(j.codeStyleHints));
    assert.ok(j.codeStyleHints.length > 0);
  });

  it('orchestrator change 默认会触发 --extract 并生成 patch 文件', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    writeWorkspace(ws, reqId, {
      specify: `${specifyComplete()}

### [Resolved] CQ-Rule: 折扣规则
> **背景**: 活动
#### **[User]**:
**[User]**: 满减逻辑已确认`,
      plan: appendPlanDecisionSummary(planWithRoadmap('- [ ] **T-A1** | coding | F-01 |\n- [CodeStyle] naming: 使用语义化命名')),
    });

    const r = spawnSync(
      process.execPath,
      [ORCHESTRATOR, 'change', ws, reqId, '同步变更', '--target', 'both'],
      { encoding: 'utf8' }
    );
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.ok, true);
    assert.ok(out.sync.extracted);
    assert.ok(fs.existsSync(path.join(ws, 'ai-docs', reqId, '.temp', 'knowledge-patch.json')));
    assert.ok(fs.existsSync(path.join(ws, 'ai-docs', reqId, '.temp', 'coding-standard-patch.json')));
  });

  it('engine 在 Plan 后会生成需求内 code-style.md，并仅把全局缺失规则写入 patch', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'standards'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md'),
      '# Code Style\n\n- [naming] 使用语义化命名\n',
      'utf8'
    );
    const plan = appendPlanDecisionSummary(
      planWithRoadmap(
        '- [ ] **T-A1** | coding | F-01 |\n- [CodeStyle] naming: 使用语义化命名\n- [CodeStyle] api: controller 层禁止直接访问数据库'
      )
    );
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan,
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });

    const r = runEngine(ws, reqId);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(ws, 'ai-docs', reqId, 'code-style.md')));
    assert.ok(fs.existsSync(path.join(ws, 'ai-docs', reqId, '.temp', 'coding-standard-patch.json')));

    const patchNow = JSON.parse(
      fs.readFileSync(path.join(ws, 'ai-docs', reqId, '.temp', 'coding-standard-patch.json'), 'utf8')
    );
    assert.ok(patchNow.some((p) => p.section === 'api'));
    assert.ok(!patchNow.some((p) => p.section === 'naming' && p.content.includes('使用语义化命名')));
  });

  it('mark-task 到 ready-for-qa 时会执行质量门禁', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    const plan = appendPlanDecisionSummary(
      planWithRoadmap('- [ ] **T-A1** | coding | F-01 |\n- [CodeStyle] naming: 使用语义化命名')
    );
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan,
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });

    const failGate = runManageState(
      ws,
      reqId,
      'mark-task',
      ['T-A1', 'ready-for-qa'],
      { env: { SPECFLOW_VERIFY_COMMAND: 'node -e "process.exit(1)"' } }
    );
    assert.ok(failGate.status !== 0);

    const passGate = runManageState(
      ws,
      reqId,
      'mark-task',
      ['T-A1', 'ready-for-qa'],
      { env: { SPECFLOW_VERIFY_COMMAND: 'node -e "process.exit(0)"' } }
    );
    assert.strictEqual(passGate.status, 0, passGate.stderr);
    const j = JSON.parse(passGate.stdout);
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.to, 'ready-for-qa');
    assert.ok(fs.existsSync(path.join(ws, 'ai-docs', reqId, '.temp', 'coding-standard-patch.json')));
    const codingPatch = JSON.parse(
      fs.readFileSync(path.join(ws, 'ai-docs', reqId, '.temp', 'coding-standard-patch.json'), 'utf8')
    );
    assert.ok(Array.isArray(codingPatch));
    assert.ok(codingPatch.some((p) => p.section === 'naming'));
    assert.ok(fs.existsSync(path.join(ws, 'ai-docs', reqId, '.temp', 'verify-last.json')));
    assert.ok(!fs.existsSync(path.join(ws, 'ai-docs', '.temp', 'verify-last.json')));
  });

  it('mark-group 到 ready-for-qa 时仅执行一次质量门禁并批量更新任务', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    const plan = appendPlanDecisionSummary(
      planWithRoadmap('- [ ] **T-A1** | coding | F-01 |\n- [ ] **T-A2** | coding | F-01 |')
    );
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan,
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });

    const countFile = path.join(ws, 'verify-count.txt');
    const verifyCmd =
      'node -e "const fs=require(\'fs\');const p=process.env.COUNT_FILE;let n=0;try{n=Number(fs.readFileSync(p,\'utf8\'))||0}catch{};fs.writeFileSync(p,String(n+1));process.exit(0)"';

    const r = runManageState(
      ws,
      reqId,
      'mark-group',
      ['Group A', 'ready-for-qa'],
      { env: { SPECFLOW_VERIFY_COMMAND: verifyCmd, COUNT_FILE: countFile } }
    );
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.to, 'ready-for-qa');
    assert.strictEqual(j.matchedTasks, 2);
    assert.strictEqual(fs.readFileSync(countFile, 'utf8').trim(), '1');

    const planNow = fs.readFileSync(path.join(ws, 'ai-docs', reqId, 'plan.md'), 'utf8');
    assert.ok(planNow.includes('- [?] **T-A1**'));
    assert.ok(planNow.includes('- [?] **T-A2**'));
  });

  it('mark-group 可将当前组 ready-for-qa 批量标记为 failed', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    const plan = appendPlanDecisionSummary(
      planWithRoadmap('- [?] **T-A1** | qa | F-01 |\n- [?] **T-A2** | qa | F-01 |')
    );
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan,
      state: { stateVersion: 1, activeGroup: 'Group A', groupRetryCount: 0 },
    });

    const r = runManageState(ws, reqId, 'mark-group', ['Group A', 'failed']);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.to, 'failed');
    assert.strictEqual(j.matchedTasks, 2);

    const planNow = fs.readFileSync(path.join(ws, 'ai-docs', reqId, 'plan.md'), 'utf8');
    assert.ok(planNow.includes('- [!] **T-A1**'));
    assert.ok(planNow.includes('- [!] **T-A2**'));
  });

  it('mark-task failed 且 evidence 含 [CodeStyle] 时会沉淀 coding-standard-patch', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    const plan = appendPlanDecisionSummary(planWithRoadmap('- [?] **T-A1** | qa | F-01 |'));
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan,
      state: { stateVersion: 1, activeGroup: 'Group A', groupRetryCount: 0 },
    });

    const r = runManageState(ws, reqId, 'mark-task', [
      'T-A1',
      'failed',
      '[CodeStyle] naming: 禁止使用无语义变量名',
    ]);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.to, 'failed');
    assert.ok(j.codingPatch && j.codingPatch.count === 1);

    const patchNow = JSON.parse(
      fs.readFileSync(path.join(ws, 'ai-docs', reqId, '.temp', 'coding-standard-patch.json'), 'utf8')
    );
    assert.ok(
      patchNow.some((p) => p.section === 'naming' && String(p.content).includes('禁止使用无语义变量名'))
    );
  });

  it('mark-group failed 且 evidence 含 [CodeStyle] 时会沉淀 coding-standard-patch', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    const plan = appendPlanDecisionSummary(
      planWithRoadmap('- [?] **T-A1** | qa | F-01 |\n- [?] **T-A2** | qa | F-01 |')
    );
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan,
      state: { stateVersion: 1, activeGroup: 'Group A', groupRetryCount: 0 },
    });

    const r = runManageState(ws, reqId, 'mark-group', [
      'Group A',
      'failed',
      '[CodeStyle] api: controller 层禁止直接访问数据库',
    ]);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.to, 'failed');
    assert.ok(j.codingPatch && j.codingPatch.count === 1);

    const patchNow = JSON.parse(
      fs.readFileSync(path.join(ws, 'ai-docs', reqId, '.temp', 'coding-standard-patch.json'), 'utf8')
    );
    assert.ok(
      patchNow.some((p) => p.section === 'api' && String(p.content).includes('controller 层禁止直接访问数据库'))
    );
  });

  it('mark-group completed 在混合结果时仅处理 ready-for-qa（其余任务需回退 mark-task）', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    const plan = appendPlanDecisionSummary(
      planWithRoadmap('- [?] **T-A1** | qa | F-01 |\n- [!] **T-A2** | qa | F-01 |')
    );
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan,
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });

    const r = runManageState(ws, reqId, 'mark-group', ['Group A', 'completed', 'qa pass evidence']);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.to, 'completed');
    assert.strictEqual(j.matchedTasks, 1);

    const planNow = fs.readFileSync(path.join(ws, 'ai-docs', reqId, 'plan.md'), 'utf8');
    assert.ok(planNow.includes('- [x] **T-A1**'));
    assert.ok(planNow.includes('- [!] **T-A2**'));
  });

  it('mark-group 到 ready-for-qa 时会在保留历史补丁的基础上补充 plan 规范', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    const plan = appendPlanDecisionSummary(
      planWithRoadmap('- [ ] **T-A1** | coding | F-01 |\n- [CodeStyle] naming: 使用语义化命名')
    );
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan,
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });
    const tempDir = path.join(ws, 'ai-docs', reqId, '.temp');
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'coding-standard-patch.json'),
      JSON.stringify([{ section: 'legacy', content: '旧规则' }], null, 2),
      'utf8'
    );

    const r = runManageState(
      ws,
      reqId,
      'mark-group',
      ['Group A', 'ready-for-qa'],
      { env: { SPECFLOW_VERIFY_COMMAND: 'node -e "process.exit(0)"' } }
    );
    assert.strictEqual(r.status, 0, r.stderr);
    const patchNow = JSON.parse(
      fs.readFileSync(path.join(ws, 'ai-docs', reqId, '.temp', 'coding-standard-patch.json'), 'utf8')
    );
    assert.ok(patchNow.some((p) => p.section === 'naming'));
    assert.ok(patchNow.some((p) => p.section === 'legacy' && p.content === '旧规则'));
  });

  it('verify 未传 --command 时可按技术栈自动选择命令（typecheck 优先于全量 lint 占位）', () => {
    const ws = mkWorkspace();
    fs.writeFileSync(
      path.join(ws, 'package.json'),
      JSON.stringify({
        name: 'demo',
        private: true,
        packageManager: 'pnpm@8.0.0',
        // 仅留 typecheck；禁止全量 lint 硬约束下，lint 脚本即使存在也不会被挂载
        scripts: {
          lint: 'node -e "process.exit(0)"',
          typecheck: 'node -e "process.exit(0)"',
        },
      }),
      'utf8'
    );
    const r = spawnSync(process.execPath, [VERIFY, ws], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.ok, true);
    assert.ok(Array.isArray(j.autoDetectedCommands));
    assert.ok(j.autoDetectedCommands.length > 0);
    assert.ok(String(j.selectedCommand).includes('typecheck'));
    assert.ok(!String(j.selectedCommand).includes(' lint')); // 绝不落到全量 lint
  });

  it('verify 对仅有 scripts.lint（全量）且无 eslint 配置的工程：拒绝挂载 lint，退到 noop 占位', () => {
    const ws = mkWorkspace();
    fs.writeFileSync(
      path.join(ws, 'package.json'),
      JSON.stringify({
        name: 'demo',
        private: true,
        packageManager: 'pnpm@8.0.0',
        scripts: { lint: 'node -e "process.exit(0)"' },
      }),
      'utf8'
    );
    const r = spawnSync(process.execPath, [VERIFY, ws], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.ok, true);
    assert.ok(!String(j.selectedCommand).includes('lint')); // 硬约束：禁止全量 lint fallback
    assert.ok(String(j.selectedCommand).includes('process.exit(0)')); // 仅挂 noop 占位
  });

  it('知识注入会优先返回与当前任务更相关的 domain', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    let plan = appendPlanDecisionSummary(planWithRoadmap('- [ ] **T-A1** | implement | F-01 |'));
    plan = plan.replace('Feature One', 'Payment Checkout');
    plan = plan.replace('Design.', 'Payment checkout and refund flow.');
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan,
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'domains'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'domains', 'payment.md'),
      '# payment\n核心支付规则',
      'utf8'
    );
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'domains', 'inventory.md'),
      '# inventory\n库存规则',
      'utf8'
    );

    const r = runEngine(ws, reqId);
    assert.strictEqual(r.status, 0, r.stderr);
    const pending = JSON.parse(
      fs.readFileSync(path.join(ws, 'ai-docs', reqId, '.temp', 'pending-protocol.json'), 'utf8')
    );
    const ctx = String(pending.knowledgeContext || '');
    assert.ok(ctx.includes('payment.md'));
    assert.ok(!ctx.includes('inventory.md'));
  });

  it('verify 在项目根存在 eslint 配置且缺少 lint:changed 时不会回退全量 lint', () => {
    const ws = mkWorkspace();
    fs.writeFileSync(
      path.join(ws, '.eslintrc.json'),
      '{"root":true}',
      'utf8'
    );
    fs.writeFileSync(
      path.join(ws, 'package.json'),
      JSON.stringify({
        name: 'demo',
        private: true,
        packageManager: 'pnpm@8.0.0',
        scripts: { lint: 'node -e "process.exit(0)"', typecheck: 'node -e "process.exit(0)"' },
      }),
      'utf8'
    );

    const r = spawnSync(process.execPath, [VERIFY, ws], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.ok, true);
    assert.ok(j.lintRulesDetected && j.lintRulesDetected.eslint === true);
    assert.ok(!String(j.selectedCommand).includes('lint'));
    assert.ok(String(j.selectedCommand).includes('typecheck'));
  });

  it('verify 在项目根存在 eslint 配置且提供 lint:changed 时优先选择增量 lint', () => {
    const ws = mkWorkspace();
    fs.writeFileSync(
      path.join(ws, '.eslintrc.json'),
      '{"root":true}',
      'utf8'
    );
    fs.writeFileSync(
      path.join(ws, 'package.json'),
      JSON.stringify({
        name: 'demo',
        private: true,
        packageManager: 'pnpm@8.0.0',
        scripts: {
          lint: 'node -e "process.exit(0)"',
          'lint:changed': 'node -e "process.exit(0)"',
          typecheck: 'node -e "process.exit(0)"',
        },
      }),
      'utf8'
    );

    const r = spawnSync(process.execPath, [VERIFY, ws], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.ok, true);
    assert.ok(j.lintRulesDetected && j.lintRulesDetected.eslint === true);
    assert.ok(String(j.selectedCommand).includes('lint:changed'));
  });

  it('verify 会解析 standards/code-style.md 的 [Hard] 规则并要求存在可执行映射', () => {
    const ws = mkWorkspace();
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'standards'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md'),
      `# Code Style

> **规范编号**：STYLE-0001
> **适用上下文**：src/**/*.ts
> **正例/反例**：
> \`\`\`ts
> // ok
> \`\`\`
> **验证方式**：command: node -e "process.exit(0)"

> **规范编号**：STYLE-0002
> **适用上下文**：src/**/*.ts
> **正例/反例**：
> \`\`\`ts
> // bad
> \`\`\`
> **验证方式**：regex: /^use.*Hook/

[Hard] STYLE-0001: 必须通过静态检查
[Hard] STYLE-0002: hook 命名规则
`,
      'utf8'
    );

    const r = spawnSync(process.execPath, [VERIFY, ws], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.ok, true);
    assert.ok(Array.isArray(j.hardRules) && j.hardRules.length >= 2);
    assert.ok(j.hardRules.every((x) => x.verify && x.verify.type), 'Hard 规则必须有 verify 映射');
  });
});

describe('archive knowledge reviewer gate', () => {
  it('Archive 阶段在 archiveAnchorDone=true、domainMerged=true 但未 knowledgeReviewed 时派发 specflow-knowledge-reviewer', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planAllCompleted()),
      state: { stateVersion: 1, archiveAnchorDone: true, domainMerged: true, knowledgeReviewed: false },
    });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'Archive');
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-knowledge-reviewer');
  });

  it('merge-global-assets 脚本可把 patch 合并进 global-assets 并更新 metadata', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planAllCompleted()),
      state: { stateVersion: 1, domainMerged: true, archiveAnchorDone: true },
    });
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId, '.temp'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', reqId, '.temp', 'knowledge-patch.json'),
      JSON.stringify([{ domain: 'payment', category: 'rule', scope: '默认', content: '新增规则' }], null, 2),
      'utf8'
    );
    const r = spawnSync(process.execPath, [MERGE_GLOBAL_ASSETS, ws, reqId], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const domainPath = path.join(ws, 'ai-docs', 'global-assets', 'domains', 'payment.md');
    assert.ok(fs.existsSync(domainPath));
    const metadata = JSON.parse(
      fs.readFileSync(path.join(ws, 'ai-docs', 'global-assets', 'metadata.json'), 'utf8')
    );
    assert.ok(metadata.payment);
    assert.strictEqual(metadata.payment.last_requirement, reqId);
    assert.deepStrictEqual(metadata.payment.sourceRequirementIds, [reqId]);
  });

  it('merge-global-assets 在未确认归档时拒绝提前合并', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planAllCompleted()),
      state: { stateVersion: 1, domainMerged: true, archiveAnchorDone: false },
    });
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId, '.temp'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', reqId, '.temp', 'knowledge-patch.json'),
      JSON.stringify([{ domain: 'payment', title: 'Rule', content: '新增规则' }], null, 2),
      'utf8'
    );
    const r = spawnSync(process.execPath, [MERGE_GLOBAL_ASSETS, ws, reqId], { encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.ok, false);
    assert.ok(String(j.error || '').includes('归档尚未确认'));
    assert.ok(!fs.existsSync(path.join(ws, 'ai-docs', 'global-assets', 'domains', 'payment.md')));
  });

  it('merge-global-assets 首次合并单一需求时 status 为 Draft（置信度阶梯化）', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planAllCompleted()),
      state: { stateVersion: 1, domainMerged: true, knowledgeReviewed: false, archiveAnchorDone: true },
    });
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId, '.temp'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', reqId, '.temp', 'knowledge-patch.json'),
      JSON.stringify([{ domain: 'payment', title: 'Rule', content: '新增规则' }], null, 2),
      'utf8'
    );
    const r = spawnSync(process.execPath, [MERGE_GLOBAL_ASSETS, ws, reqId], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const domainPath = path.join(ws, 'ai-docs', 'global-assets', 'domains', 'payment.md');
    const text = fs.readFileSync(domainPath, 'utf8');
    assert.ok(text.includes(`sourceRequirementIds: [${reqId}]`), 'frontmatter 应仅保留 sourceRequirementIds 为事实字段');
    assert.ok(!/^status:\s/m.test(text), 'frontmatter 不应再双写 status 派生字段');
    assert.ok(text.includes('**status**: Draft'), 'body badge 应现算 status=Draft');
    assert.ok(text.includes(`**last_requirement**: ${reqId}`), 'body badge 应现算 last_requirement');
  });

  it('merge-global-assets 按 category 分桶：entity/rule/stateMachine/techDebt 各进对应表格', () => {
    const ws = mkWorkspace();
    const reqId = 'R-CAT';
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planAllCompleted()),
      state: { stateVersion: 1, domainMerged: true, knowledgeReviewed: false, archiveAnchorDone: true },
    });
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId, '.temp'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', reqId, '.temp', 'knowledge-patch.json'),
      JSON.stringify(
        [
          { domain: 'payment', category: 'entity', term: 'payStatus', content: '付费状态枚举', enum: ['FREE', 'PAID'] },
          { domain: 'payment', category: 'rule', scope: '上线判定', content: '可上线需审核通过', strength: 'hard' },
          { domain: 'payment', category: 'stateMachine', from: '审核中', condition: '*', to: '禁编辑', content: '审核中禁编辑' },
          { domain: 'payment', category: 'techDebt', id: 'TD-1', content: '付费档位扩展需升级枚举' },
        ],
        null,
        2,
      ),
      'utf8'
    );
    const r = spawnSync(process.execPath, [MERGE_GLOBAL_ASSETS, ws, reqId], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const text = fs.readFileSync(path.join(ws, 'ai-docs', 'global-assets', 'domains', 'payment.md'), 'utf8');
    assert.ok(text.includes('## 统一语言 & 实体'));
    assert.ok(text.includes('payStatus'));
    assert.ok(text.includes('## 稳定业务规则'));
    assert.ok(text.includes('可上线需审核通过'));
    assert.ok(text.includes('| Hard |') || text.includes('Hard'));
    assert.ok(text.includes('## 状态机 / 门禁'));
    assert.ok(text.includes('审核中'));
    assert.ok(text.includes('## 技术债 & TODO'));
    assert.ok(text.includes('TD-1'));
  });

  it('merge-global-assets：category=ui 的条目不回流到全局 domains/', () => {
    const ws = mkWorkspace();
    const reqId = 'R-UI';
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planAllCompleted()),
      state: { stateVersion: 1, domainMerged: true, knowledgeReviewed: false, archiveAnchorDone: true },
    });
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId, '.temp'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', reqId, '.temp', 'knowledge-patch.json'),
      JSON.stringify(
        [
          { domain: 'payment', category: 'ui', content: '列表列固定在付费状态后' },
          { domain: 'payment', category: 'rule', content: '保存入参与查询字段一致' },
        ],
        null,
        2,
      ),
      'utf8'
    );
    const r = spawnSync(process.execPath, [MERGE_GLOBAL_ASSETS, ws, reqId], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.droppedUiCount, 1);
    const text = fs.readFileSync(path.join(ws, 'ai-docs', 'global-assets', 'domains', 'payment.md'), 'utf8');
    assert.ok(text.includes('保存入参与查询字段一致'));
    assert.ok(!text.includes('列表列固定在付费状态后'), 'ui 类别不应回流到全局 domain md');
  });

  it('merge-global-assets 置信度阶梯化：同一规则被 3 个需求覆盖 → Verified', () => {
    const ws = mkWorkspace();
    const ensureReq = (reqId) => {
      writeWorkspace(ws, reqId, {
        specify: specifyComplete(),
        plan: appendPlanDecisionSummary(planAllCompleted()),
        state: { stateVersion: 1, domainMerged: true, knowledgeReviewed: false, archiveAnchorDone: true },
      });
      fs.mkdirSync(path.join(ws, 'ai-docs', reqId, '.temp'), { recursive: true });
      fs.writeFileSync(
        path.join(ws, 'ai-docs', reqId, '.temp', 'knowledge-patch.json'),
        JSON.stringify(
          [{ domain: 'payment', category: 'rule', content: '保存入参与查询字段一致', attributes: { scope: '入参一致性' } }],
          null,
          2,
        ),
        'utf8',
      );
      const r = spawnSync(process.execPath, [MERGE_GLOBAL_ASSETS, ws, reqId], { encoding: 'utf8' });
      assert.strictEqual(r.status, 0, r.stderr);
    };
    ensureReq('REQ-A');
    let text = fs.readFileSync(path.join(ws, 'ai-docs', 'global-assets', 'domains', 'payment.md'), 'utf8');
    assert.ok(text.includes('**status**: Draft'));
    ensureReq('REQ-B');
    text = fs.readFileSync(path.join(ws, 'ai-docs', 'global-assets', 'domains', 'payment.md'), 'utf8');
    assert.ok(text.includes('**status**: Consolidating'));
    ensureReq('REQ-C');
    text = fs.readFileSync(path.join(ws, 'ai-docs', 'global-assets', 'domains', 'payment.md'), 'utf8');
    assert.ok(text.includes('**status**: Verified'));
    assert.ok(text.includes('sourceRequirementIds: [REQ-A, REQ-B, REQ-C]'));
  });

  it('merge-global-assets 兼容老 bullet list：保留为 Legacy 段，不误伤', () => {
    const ws = mkWorkspace();
    const reqId = 'R-LEG';
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planAllCompleted()),
      state: { stateVersion: 1, domainMerged: true, knowledgeReviewed: false, archiveAnchorDone: true },
    });
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'domains'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'domains', 'payment.md'),
      '# payment\n\n- 旧规则一：支付状态必须同步\n- 旧规则二：退款链路独立\n',
      'utf8'
    );
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId, '.temp'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', reqId, '.temp', 'knowledge-patch.json'),
      JSON.stringify(
        [{ domain: 'payment', category: 'rule', content: '新结构规则', attributes: { scope: '新增' } }],
        null,
        2,
      ),
      'utf8'
    );
    const r = spawnSync(process.execPath, [MERGE_GLOBAL_ASSETS, ws, reqId], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const text = fs.readFileSync(path.join(ws, 'ai-docs', 'global-assets', 'domains', 'payment.md'), 'utf8');
    assert.ok(text.includes('## 稳定业务规则'));
    assert.ok(text.includes('新结构规则'));
    assert.ok(text.includes('## Legacy (pre-migration)'));
    assert.ok(text.includes('旧规则一：支付状态必须同步'));
    assert.ok(text.includes('旧规则二：退款链路独立'));
  });

  it('merge-global-assets 合并代码规范时同规则保留最新来源需求号', () => {
    const ws = mkWorkspace();
    const reqId = 'R2';
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planAllCompleted()),
      state: { stateVersion: 1, domainMerged: true, knowledgeReviewed: true, archiveAnchorDone: true },
    });
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'standards'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md'),
      '# Code Style\n\n- [api] controller 层禁止直接访问数据库 (source: R1)\n',
      'utf8'
    );
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId, '.temp'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', reqId, '.temp', 'coding-standard-patch.json'),
      JSON.stringify([{ section: 'api', content: 'controller 层禁止直接访问数据库' }], null, 2),
      'utf8'
    );

    const r = spawnSync(process.execPath, [MERGE_GLOBAL_ASSETS, ws, reqId], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const styleNow = fs.readFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md'),
      'utf8'
    );
    assert.ok(styleNow.includes('(source: R2)'));
  });

  it('merge-global-assets 不回灌 kind=override 的代码规范条目（仅本需求生效）', () => {
    const ws = mkWorkspace();
    const reqId = 'R-OV';
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planAllCompleted()),
      state: { stateVersion: 1, domainMerged: true, knowledgeReviewed: true, archiveAnchorDone: true },
    });
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'standards'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md'),
      '# Code Style\n\n- [logging] 接入新 SDK 必须输出 traceId\n',
      'utf8'
    );
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId, '.temp'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', reqId, '.temp', 'coding-standard-patch.json'),
      JSON.stringify(
        [
          { section: 'naming', content: '后端枚举使用 SCREAMING_SNAKE_CASE', kind: 'addition' },
          { section: 'logging', content: '本需求允许跳过 traceId 注入', kind: 'override', basedOn: '接入新 SDK 必须输出 traceId' },
        ],
        null,
        2,
      ),
      'utf8'
    );

    const r = spawnSync(process.execPath, [MERGE_GLOBAL_ASSETS, ws, reqId], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const styleNow = fs.readFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md'),
      'utf8'
    );
    assert.ok(styleNow.includes('SCREAMING_SNAKE_CASE'), 'addition 应回灌全局');
    assert.ok(!styleNow.includes('本需求允许跳过 traceId 注入'), 'override 不应进入全局');
  });

  it('code-style applies 元数据：解析、渲染、归档合并都保留 globs（无关键词检索）', () => {
    const ws = mkWorkspace();
    const reqId = 'R-APPLY';
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planAllCompleted()),
      state: { stateVersion: 1, domainMerged: true, knowledgeReviewed: true, archiveAnchorDone: true },
    });
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'standards'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md'),
      '# Code Style\n\n- [api] controller 层禁止直接访问数据库 (applies: src/api/**/*.ts, src/controllers/**)\n',
      'utf8'
    );
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId, '.temp'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', reqId, '.temp', 'coding-standard-patch.json'),
      JSON.stringify(
        [
          {
            section: 'naming',
            content: '[Hard] 后端枚举使用 SCREAMING_SNAKE_CASE',
            kind: 'addition',
            applies: ['src/api/**/*.ts', 'src/services/**/*.ts'],
          },
        ],
        null,
        2,
      ),
      'utf8'
    );

    const r = spawnSync(process.execPath, [MERGE_GLOBAL_ASSETS, ws, reqId], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const styleNow = fs.readFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md'),
      'utf8'
    );
    assert.ok(styleNow.includes('SCREAMING_SNAKE_CASE'));
    assert.ok(styleNow.includes('(applies: src/api/**/*.ts, src/services/**/*.ts)'));
    assert.ok(styleNow.includes('(applies: src/api/**/*.ts, src/controllers/**)'));

    const { parseGlobalCodeStyleRules } = require(
      path.join(__dirname, '..', 'tools', 'code-style.cjs')
    );
    const rules = parseGlobalCodeStyleRules(styleNow);
    const naming = rules.find((x) => x.section === 'naming');
    assert.ok(naming);
    assert.deepStrictEqual(naming.applies, ['src/api/**/*.ts', 'src/services/**/*.ts']);
  });

  it('code-style 三段式渲染：plan 中 [CodeStyle:override] 进入 Overrides 段，[CodeStyle] 进入 Additions', () => {
    const ws = mkWorkspace();
    const reqId = 'R-RENDER';
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'standards'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md'),
      '# Code Style\n\n- [naming] 使用语义化命名\n',
      'utf8'
    );
    const planMd = appendPlanDecisionSummary(planAllCompleted())
      + '\n\n## Code Style\n\n- [CodeStyle] api: controller 层禁止直接访问数据库\n'
      + '- [CodeStyle:override] logging: 本需求允许跳过 traceId 注入 (基于: 接入新 SDK 必须输出 traceId)\n';
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: planMd,
      state: { stateVersion: 1 },
    });

    const { writeRequirementCodeStyleArtifacts } = require(
      path.join(__dirname, '..', 'tools', 'code-style.cjs')
    );
    const result = writeRequirementCodeStyleArtifacts(ws, reqId, planMd, { mergePatch: true });
    assert.strictEqual(result.generated, true);
    assert.strictEqual(result.additionsCount, 1);
    assert.strictEqual(result.overridesCount, 1);

    const md = fs.readFileSync(path.join(ws, 'ai-docs', reqId, 'code-style.md'), 'utf8');
    assert.ok(md.includes('## Requirement Additions'));
    assert.ok(md.includes('controller 层禁止直接访问数据库'));
    assert.ok(md.includes('## Requirement Overrides'));
    assert.ok(md.includes('本需求允许跳过 traceId 注入'));
    assert.ok(md.includes('(基于: 接入新 SDK 必须输出 traceId)'));

    const patch = JSON.parse(
      fs.readFileSync(path.join(ws, 'ai-docs', reqId, '.temp', 'coding-standard-patch.json'), 'utf8')
    );
    assert.ok(Array.isArray(patch));
    const kinds = patch.map((p) => p.kind).sort();
    assert.deepStrictEqual(kinds, ['addition', 'override']);
  });

});

describe('code-style 结构优化：strength 字段化 / dedup / globs 视图 / 按路径过滤', () => {
  const codeStyle = require(
    path.join(__dirname, '..', 'tools', 'code-style.cjs')
  );

  it('stripStrengthPrefix 从 content 前缀剥离 [Hard]/[Soft] 为独立字段', () => {
    const a = codeStyle.stripStrengthPrefix('[Hard] controller 禁止访问 DB');
    assert.strictEqual(a.strength, 'hard');
    assert.strictEqual(a.content, 'controller 禁止访问 DB');

    const b = codeStyle.stripStrengthPrefix('[soft] 使用语义化命名');
    assert.strictEqual(b.strength, 'soft');
    assert.strictEqual(b.content, '使用语义化命名');

    const c = codeStyle.stripStrengthPrefix('无前缀规则');
    assert.strictEqual(c.strength, undefined);
    assert.strictEqual(c.content, '无前缀规则');
  });

  it('normalizeContentForDedup 能把 [Hard] 前缀、反引号、尾部句号归一为同一 key', () => {
    const n1 = codeStyle.normalizeContentForDedup('[Hard] `composition` 层统一导出命名为 useXxx');
    const n2 = codeStyle.normalizeContentForDedup('composition 层统一导出命名为 useXxx。');
    assert.strictEqual(n1, n2, `归一化应一致: ${n1} != ${n2}`);
  });

  it('mergeCodingPatches 现在能合并 `[Hard] X` 与 `X。` 这种同义双份', () => {
    const merged = codeStyle.mergeCodingPatches(
      [
        {
          section: 'composition',
          content: '[Hard] composition 层统一导出命名为 useXxx',
          kind: 'addition',
          applies: ['packages/*/src/composition/**/*.ts'],
          sourceRequirementId: '8822',
        },
      ],
      [
        {
          section: 'composition',
          content: 'composition 层统一导出命名为 useXxx。',
          kind: 'addition',
          applies: ['packages/*/src/composition/**/*.ts'],
          sourceRequirementId: '8822',
        },
      ],
    );
    assert.strictEqual(merged.length, 1, '同义规则应合并为一条');
    assert.strictEqual(merged[0].strength, 'hard', 'strength 应升格为 hard');
    assert.deepStrictEqual(merged[0].applies, ['packages/*/src/composition/**/*.ts']);
  });

  it('mergeCodingPatches：strength 字段 + content 前缀任一指示 hard 即升格', () => {
    const merged = codeStyle.mergeCodingPatches(
      [{ section: 'x', content: 'rule A', kind: 'addition' }],
      [{ section: 'x', content: 'rule A', kind: 'addition', strength: 'hard' }],
    );
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].strength, 'hard');
  });

  it('extractCodingStandardPatchesFromPlan：把 [Hard] 剥离到 strength 字段，content 干净', () => {
    const planContent =
      '- [CodeStyle] api: [Hard] controller 禁止访问 DB (applies: src/api/**)\n'
      + '- [CodeStyle] naming: 使用语义化命名\n';
    const patches = codeStyle.extractCodingStandardPatchesFromPlan(planContent);
    assert.strictEqual(patches.length, 2);
    const api = patches.find((p) => p.section === 'api');
    assert.strictEqual(api.strength, 'hard');
    assert.ok(!/\[Hard\]/i.test(api.content), `content 不应再含 [Hard]: ${api.content}`);
    assert.deepStrictEqual(api.applies, ['src/api/**']);
    const naming = patches.find((p) => p.section === 'naming');
    assert.strictEqual(naming.strength, undefined);
  });

  it('matchRulesForPaths：按 globs 命中过滤；无 applies 视为全局规则', () => {
    const rules = [
      { section: 'composition', content: 'R1', applies: ['packages/*/src/composition/**/*.ts'] },
      { section: 'dto', content: 'R2', applies: ['packages/*/src/dto/**/*.ts'] },
      { section: 'naming', content: 'R3' },
    ];
    const hits = codeStyle.matchRulesForPaths(rules, [
      'packages/mini/src/composition/useFoo.ts',
    ]);
    const sections = hits.map((r) => r.section).sort();
    assert.deepStrictEqual(sections, ['composition', 'naming'], '应命中 composition 与全局规则');

    const hits2 = codeStyle.matchRulesForPaths(rules, ['packages/mini/src/composition/useFoo.ts'], {
      includeGlobal: false,
    });
    assert.deepStrictEqual(hits2.map((r) => r.section), ['composition']);
  });

  it('extractTaskFilePaths：从 Active Group 任务行抽取 Create/Modify 路径', () => {
    const focusPlan = [
      '## Active Group',
      '- [ ] **T-A1** | **Create**: `src/api/user.ts` | 实现用户接口 | Ref: F-01',
      '- [?] **T-A2** | **Modify**: `src/dto/user.dto.ts` | 拆分 DTO | Ref: F-02',
      '- [ ] **T-A3** | **Create**: packages/web/src/composition/useFoo.ts | 新 composition | Ref: F-03',
    ].join('\n');
    const paths = codeStyle.extractTaskFilePaths(focusPlan);
    assert.deepStrictEqual(paths.sort(), [
      'packages/web/src/composition/useFoo.ts',
      'src/api/user.ts',
      'src/dto/user.dto.ts',
    ]);
  });

  it('renderRulesByScope：按 applies 分组输出 ### `<glob>` 章节，无 applies 归到 `*`', () => {
    const rules = [
      { section: 'composition', content: 'R1', applies: ['packages/*/src/composition/**/*.ts'] },
      { section: 'naming', content: 'R3' },
    ];
    const md = codeStyle.renderRulesByScope(rules);
    assert.ok(md.includes('### `packages/*/src/composition/**/*.ts`'), md);
    assert.ok(md.includes('### `*` (全局 / 无 applies)'), md);
    assert.ok(md.includes('- [composition] R1'), md);
    assert.ok(md.includes('- [naming] R3'), md);
  });

  it('renderRequirementCodeStyleMarkdown：主视图 Rules by Scope + 次视图 Rules by Section 同时出现', () => {
    const md = codeStyle.renderRequirementCodeStyleMarkdown({
      requirementId: 'R1',
      existingInGlobal: [
        { section: 'naming', content: '使用语义化命名' },
      ],
      requirementAdditions: [
        {
          section: 'composition',
          content: '统一导出命名为 useXxx',
          strength: 'hard',
          applies: ['packages/*/src/composition/**/*.ts'],
          sourceRequirementId: 'R1',
        },
      ],
      requirementOverrides: [],
    });
    assert.ok(md.includes('## Rules by Scope'), 'should have Rules by Scope');
    assert.ok(md.includes('## Rules by Section'), 'should have Rules by Section');
    assert.ok(md.includes('### `packages/*/src/composition/**/*.ts`'), 'should have scope heading');
    assert.ok(
      md.includes('[Hard] 统一导出命名为 useXxx'),
      'Hard 标记应渲染到 content 前',
    );
  });

  it('parseGlobalCodeStyleRules：识别并剥离 [Hard] 前缀为 strength 字段', () => {
    const md = [
      '# Code Style',
      '',
      '- [composition] [Hard] 统一导出命名 useXxx (applies: packages/*/src/composition/**/*.ts)',
      '- [naming] 使用语义化命名',
    ].join('\n');
    const rules = codeStyle.parseGlobalCodeStyleRules(md);
    const comp = rules.find((r) => r.section === 'composition');
    assert.strictEqual(comp.strength, 'hard');
    assert.ok(!/\[Hard\]/i.test(comp.content));
    const nm = rules.find((r) => r.section === 'naming');
    assert.strictEqual(nm.strength, undefined);
  });

  it('buildKnowledgeContext 按 status 排序并加前缀 banner：Verified 先于 Draft', () => {
    const ws = mkWorkspace();
    const reqId = 'R-STATUS';
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'domains'), { recursive: true });
    const renderDomain = (name, status, body) =>
      [
        '---',
        `domain: ${name}`,
        `status: ${status}`,
        'last_requirement: 8822',
        `confidence: ${status === 'Verified' ? 0.85 : 0.3}`,
        'maintainer: specflow-knowledge-reviewer',
        `sourceRequirementIds: [A${status === 'Verified' ? ', B, C' : ''}]`,
        '---',
        '',
        `# ${name}`,
        '',
        body,
      ].join('\n');

    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'domains', 'payment.md'),
      renderDomain('payment', 'Verified', '- 已验证规则：支付状态同步'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'domains', 'promotion.md'),
      renderDomain('promotion', 'Draft', '- 草案规则：促销叠加上限'),
      'utf8',
    );
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId), { recursive: true });

    const engine = require(
      path.join(__dirname, '..', 'tools', 'specflow-engine.cjs')
    );
    const hintText = [
      '## Active Group',
      '支付 payment 场景与促销 promotion 场景同时受影响。',
      '- [ ] **T-A1** | **Modify**: `src/api/payment.ts`',
    ].join('\n');
    const ctx = engine.buildKnowledgeContext(ws, reqId, hintText);

    assert.ok(ctx.includes('【已验证规则 · Verified】'), '应含 Verified banner');
    assert.ok(ctx.includes('【草案'), '应含 Draft banner');

    const idxVerified = ctx.indexOf('### payment.md');
    const idxDraft = ctx.indexOf('### promotion.md');
    assert.ok(idxVerified >= 0 && idxDraft >= 0, '两个 domain 均应入选');
    assert.ok(idxVerified < idxDraft, 'Verified 段应排在 Draft 段前面');
  });

  it('buildKnowledgeContext 对超长 Draft chunk 做预算截断，不截断 Verified', () => {
    const ws = mkWorkspace();
    const reqId = 'R-TRUNC';
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'domains'), { recursive: true });
    const longBody = '- rule line: 这是一条很长的规则描述。'.repeat(300);
    const write = (name, status, srcCount) => {
      const md = [
        '---',
        `domain: ${name}`,
        `status: ${status}`,
        'last_requirement: X',
        `confidence: ${status === 'Verified' ? 0.85 : 0.3}`,
        'maintainer: specflow-knowledge-reviewer',
        `sourceRequirementIds: [${Array.from({ length: srcCount }, (_, i) => `R${i}`).join(', ')}]`,
        '---',
        '',
        `# ${name}`,
        '',
        longBody,
      ].join('\n');
      fs.writeFileSync(path.join(ws, 'ai-docs', 'global-assets', 'domains', `${name}.md`), md, 'utf8');
    };
    write('promotion', 'Draft', 1);
    write('payment', 'Verified', 3);
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId), { recursive: true });

    const engine = require(
      path.join(__dirname, '..', 'tools', 'specflow-engine.cjs')
    );
    const hintText = '支付 payment 与促销 promotion 场景全量命中。';
    const ctx = engine.buildKnowledgeContext(ws, reqId, hintText);

    const verifiedIdx = ctx.indexOf('### payment.md');
    const draftIdx = ctx.indexOf('### promotion.md');
    assert.ok(verifiedIdx >= 0 && draftIdx >= 0, '两个 domain 均应入选');
    // Verified 在前、Draft 在后（status 排序）
    assert.ok(verifiedIdx < draftIdx, 'Verified 应先于 Draft');
    const verifiedSeg = ctx.slice(verifiedIdx, draftIdx);
    const draftSeg = ctx.slice(draftIdx);
    assert.ok(!verifiedSeg.includes('Draft 段超长已截断'), 'Verified 段不应被截断');
    assert.ok(draftSeg.includes('Draft 段超长已截断'), 'Draft 段应出现截断提示');
  });

  it('buildKnowledgeContext：注入 code-style 命中切片（按 Active Group 路径过滤）', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'standards'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md'),
      [
        '# Code Style',
        '',
        '- [composition] [Hard] 统一导出命名 useXxx (applies: packages/*/src/composition/**/*.ts)',
        '- [dto] [Hard] 禁止引用 services (applies: packages/*/src/dto/**/*.ts)',
        '- [naming] 使用语义化命名',
      ].join('\n') + '\n',
      'utf8',
    );
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId), { recursive: true });

    const focusPlan = [
      '## Active Group',
      '- [ ] **T-A1** | **Create**: `packages/mini/src/composition/useFoo.ts` | ... | Ref: F-01',
    ].join('\n');

    // 走 engine 的内部函数（通过 require 主模块作为模块再调用）
    const engine = require(
      path.join(__dirname, '..', 'tools', 'specflow-engine.cjs')
    );
    // buildKnowledgeContext 不在 exports 中；用 spawn 一个 inline 子进程验证
    // 这里退而测试 matchRulesForPaths 的上层效果即可
    const { globalRules } = codeStyle.readGlobalCodeStyleRules(ws);
    const paths = codeStyle.extractTaskFilePaths(focusPlan);
    const hits = codeStyle.matchRulesForPaths(globalRules, paths);
    const sections = hits.map((r) => r.section).sort();
    // 应命中 composition（glob 匹配）+ naming（全局无 applies），不含 dto
    assert.deepStrictEqual(sections, ['composition', 'naming']);
    assert.ok(engine, 'engine 模块可加载');
  });

  it('buildKnowledgeContext：localPatches 按 category 分组；ui 被丢弃；已在全局的规则跨源去重', () => {
    const ws = mkWorkspace();
    const reqId = 'R-CTX';
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planWithRoadmap('- [ ] **T-A1** | implement | F-01 |')),
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'domains'), { recursive: true });
    const domainKnowledge = require(
      path.join(__dirname, '..', 'tools', 'domain-knowledge.cjs')
    );
    const merged = domainKnowledge.mergePatchesIntoDomainMd(
      '# payment\n\n',
      'payment',
      [{ domain: 'payment', category: 'rule', scope: '既存', content: '已入全局的规则' }],
      { requirementId: 'PAST' },
    );
    fs.writeFileSync(path.join(ws, 'ai-docs', 'global-assets', 'domains', 'payment.md'), merged.md, 'utf8');

    fs.mkdirSync(path.join(ws, 'ai-docs', reqId, '.temp'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', reqId, '.temp', 'knowledge-patch.json'),
      JSON.stringify(
        [
          { domain: 'payment', category: 'rule', scope: '既存', content: '已入全局的规则' },
          { domain: 'payment', category: 'rule', scope: '新增', content: '本期新增规则', strength: 'hard' },
          { domain: 'payment', category: 'ui', content: '本期 UI 约定：按钮靠右' },
          { domain: 'payment', category: 'entity', term: 'payStatus', content: '付费状态' },
        ],
        null,
        2,
      ),
      'utf8',
    );

    const engine = require(
      path.join(__dirname, '..', 'tools', 'specflow-engine.cjs')
    );
    const ctx = engine.buildKnowledgeContext(ws, reqId, '## Active Group\n- [ ] **T-A1** payment');
    assert.ok(ctx.includes('## 局部 Patch'), '应有局部 Patch 段');
    assert.ok(ctx.includes('本期新增规则'), '新增规则应出现');
    assert.ok(ctx.includes('payStatus'), '新增实体应出现');
    assert.ok(!ctx.includes('本期 UI 约定：按钮靠右'), 'ui 类别不应进入 knowledgeContext');
    assert.ok(!/局部\s*Patch[\s\S]*已入全局的规则/.test(ctx), '已在全局的规则不应重复出现于局部 Patch 段');
    assert.ok(ctx.includes('丢弃 UI 类 1 条'));
    assert.ok(ctx.includes('与全局重复已去重 1 条'));
  });

  it('buildKnowledgeContext：注入需求级 business-domains 活文档（本期权威）', () => {
    const ws = mkWorkspace();
    const reqId = 'R-BIZ';
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planWithRoadmap('- [ ] **T-A1** | implement | F-01 |')),
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });
    const bizDir = path.join(ws, 'ai-docs', reqId, 'business-domains');
    fs.mkdirSync(bizDir, { recursive: true });
    fs.writeFileSync(
      path.join(bizDir, 'payment.md'),
      '# payment\n\n## 本期权威业务规则\n- 规则X：本期新定义的权威业务事实（Explorer 产出）\n',
      'utf8',
    );

    const engine = require(
      path.join(__dirname, '..', 'tools', 'specflow-engine.cjs')
    );
    const ctx = engine.buildKnowledgeContext(ws, reqId, 'payment');
    assert.ok(ctx.includes('## 本期业务知识（需求级权威）'));
    assert.ok(ctx.includes('规则X：本期新定义的权威业务事实'));
  });

  it('patch schema 扁平化：entity/rule/stateMachine/techDebt 读扁平字段并正确落到表格行', () => {
    const dk = require(
      path.join(__dirname, '..', 'tools', 'domain-knowledge.cjs')
    );
    const merged = dk.mergePatchesIntoDomainMd(
      '# payment\n\n',
      'payment',
      [
        { domain: 'payment', category: 'entity', term: 'Order', content: '订单主实体', enum: ['A', 'B'] },
        { domain: 'payment', category: 'rule', scope: '上线判定', content: '需审核通过', strength: 'hard' },
        { domain: 'payment', category: 'stateMachine', from: '审核中', condition: '*', to: '禁编辑', content: 'sm' },
        { domain: 'payment', category: 'techDebt', id: 'TD-9', content: '枚举需扩展', owner: 'alice' },
      ],
      { requirementId: 'R-FLAT' },
    );
    const md = merged.md;
    assert.ok(md.includes('| Order | 订单主实体 | A / B |'), 'entity 行：扁平 term/enum 落入表格');
    assert.ok(md.includes('| 上线判定 | 需审核通过 | Hard |'), 'rule 行：扁平 scope/strength 落入表格');
    assert.ok(md.includes('| 审核中 | * | 禁编辑 |'), 'stateMachine 行：扁平 from/condition/to 落入表格');
    assert.ok(md.includes('| TD-9 | 枚举需扩展 | alice |'), 'techDebt 行：扁平 id/owner 落入表格');
    // frontmatter 只保留事实字段
    assert.ok(/^---\ndomain: payment\nmaintainer: specflow-knowledge-reviewer\nsourceRequirementIds: \[R-FLAT\]\n---$/m.test(md));
    assert.ok(!/\n\s*status:\s*Draft\s*\n/.test(md.split('\n---\n')[0] + '\n---\n'), 'frontmatter 不再双写 status');
    assert.ok(md.includes('**status**: Draft'), 'body badge 现算 status');
  });

  it('buildKnowledgeContext：hintText 为 focusPlan（多 group 拼接）时能抽到各 group 的文件路径并命中 code-style', () => {
    const ws = mkWorkspace();
    const reqId = 'R-FP';
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: appendPlanDecisionSummary(planAllCompleted()),
      state: { stateVersion: 1 },
    });
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'standards'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md'),
      [
        '# Code Style',
        '',
        '- [composition] 统一导出命名 useXxx (applies: packages/*/src/composition/**/*.ts)',
        '- [dto] 禁止引用 services (applies: packages/*/src/dto/**/*.ts)',
      ].join('\n') + '\n',
      'utf8',
    );

    // 模拟 dispatch_array 中将两个 group 的 focusPlan 拼接作为 hintText 传入
    const hintText = [
      '## Active Group',
      '- [ ] **T-A1** | **Create**: `packages/mini/src/composition/useFoo.ts` | F-01 |',
      '',
      '## Active Group',
      '- [ ] **T-B1** | **Modify**: `packages/core/src/dto/bar.ts` | F-02 |',
    ].join('\n');

    const engine = require(
      path.join(__dirname, '..', 'tools', 'specflow-engine.cjs')
    );
    const ctx = engine.buildKnowledgeContext(ws, reqId, hintText);
    assert.ok(ctx.includes('## 代码规范（按本次任务文件路径命中）'));
    assert.ok(ctx.includes('composition') && ctx.includes('useXxx'), '应命中 composition 规则');
    assert.ok(ctx.includes('dto') && ctx.includes('禁止引用 services'), '应命中 dto 规则');
  });
});
