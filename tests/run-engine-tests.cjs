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
  planWithBlockedTag,
  planEmptyGroup,
  writeWorkspace,
  writeHistoryRequirement,
  writeBusinessDomain,
} = require('./fixture-builders.cjs');
const { readState, mergeState } = require(path.join(__dirname, '..', 'tools', 'specflow-state.cjs'));
const SYNC_DOCUMENT = path.join(__dirname, '..', 'tools', 'sync-document.cjs');
const ARCHIVE = path.join(__dirname, '..', 'tools', 'archive.cjs');
const MERGE_GLOBAL_ASSETS = path.join(
  __dirname,
  '..',
  'tools',
  'merge-global-assets.cjs'
);
const INVENTORY_SCAN = path.join(__dirname, '..', 'tools', 'inventory-scan.cjs');
const {
  parseMarkdownTree,
  buildFocusPlanFromTree,
} = require(path.join(__dirname, '..', 'tools', 'plan-parser.cjs'));
const {
  passGate,
  blockGate,
  readGates,
  validateGate,
  GATE_DEFINITIONS,
} = require(path.join(__dirname, '..', 'tools', 'gates.cjs'));
const engineKnowledge = require(path.join(__dirname, '..', 'tools', 'engine-knowledge.cjs'));

function writeCalibratedArchitectureLayers(ws, requirementId) {
  const reqDir = path.join(ws, 'ai-docs', requirementId);
  const standardsDir = path.join(ws, 'ai-docs', 'global-assets', 'standards');
  fs.mkdirSync(reqDir, { recursive: true });
  fs.mkdirSync(standardsDir, { recursive: true });
  fs.writeFileSync(
    path.join(standardsDir, 'architecture-layers.md'),
    [
      '# Architecture Layers',
      '',
      '> 项目架构分层画像。`code-style.md` 中的规则只能引用本文件 `## Layers` 下已存在的 layer id。',
      '',
      '## Layers',
      '',
      '### `ui-page`',
      '',
      '- globs:',
      '  - `src/pages/**/*.vue`',
      '- role: 页面层',
      '- should:',
      '  - 编排页面状态',
      '- should_not:',
      '  - 不承载跨页面复用逻辑',
      '- evidence:',
      '  - `src/pages/example.vue`',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(standardsDir, 'code-style.md'),
    [
      '# Code Style',
      '',
      '> 编码规范与跨层 SOP 的全局事实源。',
      '> layer id 必须来自 `architecture-layers.md` 的 `## Layers` 章节。',
      '',
      '## Rules by Layer',
      '',
      '### `ui-page`',
      '- should:',
      '  - naming: 页面文件 kebab-case (applies: src/pages/**/*.vue)',
      '',
      '## SOPs',
      '',
      '_（暂无全局 SOP，由需求归档逐步填充）_',
      '',
    ].join('\n'),
    'utf8',
  );
  passGate(reqDir, 'init.architecture_layers', {
    evidence: 'test calibrated architecture layers',
  });
  passGate(reqDir, 'init.code_style', {
    evidence: 'test code-style baseline',
  });
}

function completionPacketFor(groupId = 'Group A') {
  return [
    '',
    `#### Completion Packet — ${groupId}`,
    '- **Changed Files**:',
    '  - `src/a.ts`: implemented symbol',
    '- **AC Mapping**:',
    '  - AC main -> `src/a.ts:doThing` -> implemented',
    '- **Local Contract Mapping**:',
    '  - API field -> `src/a.ts:doThing` -> aligned',
    '- **Test Strategy Execution**:',
    '  - TDD Units: none',
    '  - Unit/Component Checks: Implement executed targeted unit checks',
    '  - Mock Smoke: none',
    '  - Static Diagnostics: changed files checked by project-scoped evidence',
    '- **Verification Matrix**:',
    '  - Static Diagnostics: changed files -> evidence recorded -> pass',
    '  - Targeted Test: not applicable -> deferred to QA/CI',
    '  - Contract Check: Local Contract mapping -> evidence recorded -> pass',
    '  - Smoke Evidence: not applicable -> deferred to manual/CI',
    '- **Not Run / Deferred**:',
    '  - none -> not applicable -> QA',
    '- **Knowledge Rules Used**:',
    '  - none -> not applicable',
  ].join('\n');
}

function planWithCompletionPacket(roadmapText, groupId = 'Group A', extraGroups = '') {
  return `${planWithRoadmap(roadmapText, extraGroups)}\n${completionPacketFor(groupId)}\n`;
}

function withoutVerificationMatrix(text) {
  return text.replace(
    /\n- \*\*Verification Matrix\*\*:[\s\S]*?(?=\n- \*\*Not Run \/ Deferred\*\*:)/,
    ''
  );
}

function qaLiteEvidence(groupId = 'Group A') {
  return [
    `${groupId}`,
    'Mode: QA Lite',
    'Completion Packet checked',
    'AC Mapping checked',
    'Local Contract checked',
    'Test Strategy checked',
    'Verification Matrix checked',
  ].join(' | ');
}

function ackPlanBeforeImplement(ws, requirementId = 'R1', options = {}) {
  const args = [];
  if (options.activeGroup) {
    args.push(options.activeGroup);
    if (options.auto) args.push('--auto');
  }
  const r = runManageState(ws, requirementId, 'ack-plan-before-implement', args);
  assert.strictEqual(r.status, 0, r.stderr);
  if (Number.isFinite(options.groupRetryCount)) {
    mergeState(path.join(ws, 'ai-docs', requirementId), {
      groupRetryCount: options.groupRetryCount,
    });
  }
  return r;
}

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

  it('领域初始化两阶段交互确认：S1 text 题 → S2 N 道 yes/no → dispatch_array 派发多 domain → specify preview → specify', () => {
    const ws = mkWorkspace();
    writeCalibratedArchitectureLayers(ws, 'new-user-req');

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
    assert.match(qs[0].prompt, /请确认本次需求的业务领域/);
    assert.match(qs[0].prompt, /业务知识库文件名/);
    assert.ok(j.suggestedAction.init_context, 'init_context 必须提供需求摘要与已有全局领域');
    assert.ok(Array.isArray(j.suggestedAction.init_context.existingGlobalDomains));

    // agent 提交候选 services/pay::payment,services/order::order（两个都不在全局）
    let ms = runManageState(ws, 'new-user-req', 'set-domain-init-candidates', ['services/pay::payment,services/order::order']);
    assert.strictEqual(ms.status, 0, ms.stderr);
    const msj = JSON.parse(ms.stdout);
    assert.deepStrictEqual(msj.domainInitCandidateRefs, ['services/pay::payment', 'services/order::order']);

    // S2：第二轮引擎 → N 道 yes/no 采纳题
    r = runEngine(ws, 'new-user-req');
    j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'interaction_required');
    qs = j.suggestedAction.questions || [];
    assert.strictEqual(qs.length, 2);
    assert.strictEqual(qs[0].id, 'domain_init_accept__services__pay__payment');
    assert.strictEqual(qs[1].id, 'domain_init_accept__services__order__order');
    assert.strictEqual(qs[0].progressKey, 'interaction.domain_init_accept');
    assert.strictEqual(qs[0].progressVariables.domainFile, 'business-domains/services__pay__payment.md');
    assert.match(qs[0].prompt, /请确认是否为本次需求使用业务知识库「services__pay__payment\.md」/);
    assert.match(qs[0].prompt, /系统识别的代码边界：services\/pay::payment/);
    assert.strictEqual(j.userFacing.progress.progressKey, 'interaction.domain_init_accept');
    assert.strictEqual(j.userFacing.progress.goal, '确认是否创建候选业务知识库');
    assert.strictEqual(j.userFacing.progress.llm.mode, 'compose_guidance_from_progress_model');
    assert.match(j.userFacing.fallbackMessage, /这一步会做/);
    assert.deepStrictEqual(j.suggestedAction.init_context.needConfirm, ['services/pay::payment', 'services/order::order']);
    assert.deepStrictEqual(j.suggestedAction.init_context.autoAcceptFromGlobal, []);

    // agent 汇总 yes/no 结果，把全部 accepted 写入 confirmed
    ms = runManageState(ws, 'new-user-req', 'set-domain-init-pref', ['scan', 'services/pay::payment,services/order::order']);
    assert.strictEqual(ms.status, 0, ms.stderr);

    // 第三轮：两个都缺本地文档 → dispatch_array 并行派发
    r = runEngine(ws, 'new-user-req');
    j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch_array');
    assert.strictEqual(j.suggestedAction.items.length, 2);
    assert.strictEqual(j.suggestedAction.items[0].agent, 'specflow-domain-explorer');
    assert.ok(j.suggestedAction.items.map((x) => x.groupId).every((g) => /^domain-init:/.test(g)));
    assert.strictEqual(j.suggestedAction.waitPolicy, 'all');

    writeBusinessDomain(ws, 'new-user-req', 'services/pay::payment', '# Pay\n');
    writeBusinessDomain(ws, 'new-user-req', 'services/order::order', '# Order\n');

    // 两个 domain 就绪 → 先做产品预审
    r = runEngine(ws, 'new-user-req');
    j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-specify-preview');
    assert.match(j.suggestedAction.context, /首次生成 specify\.md 前/);

    ms = runManageState(ws, 'new-user-req', 'ack-specify-preview');
    assert.strictEqual(ms.status, 0, ms.stderr);

    // 产品预审通过 → specify 成文
    r = runEngine(ws, 'new-user-req');
    j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-specify');
    assert.strictEqual(j.userFacing.templateId, 'orchestration.dispatch');
  });

  it('Specify：首次成文前产品预审阻塞会停在澄清门禁，ack 后才派发 specify', () => {
    const ws = mkWorkspace();
    const reqId = 'preview-req';
    writeCalibratedArchitectureLayers(ws, reqId);
    writeBusinessDomain(ws, reqId, 'services/order::preview', '# Preview\n');
    let ms = runManageState(ws, reqId, 'set-domain-init-pref', ['scan', 'services/order::preview']);
    assert.strictEqual(ms.status, 0, ms.stderr);

    let r = runEngine(ws, reqId);
    let j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-specify-preview');

    ms = runManageState(ws, reqId, 'mark-specify-preview-blocked', ['验收口径未确认']);
    assert.strictEqual(ms.status, 0, ms.stderr);

    r = runEngine(ws, reqId);
    j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-specify-preview');
    assert.match(j.suggestedAction.context, /上次产品预审阻塞/);

    ms = runManageState(ws, reqId, 'ack-specify-preview');
    assert.strictEqual(ms.status, 0, ms.stderr);

    r = runEngine(ws, reqId);
    j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-specify');
  });

  it('Init：创建需求目录时会幂等初始化全局资产与 architecture-layers 门禁', () => {
    const ws = mkWorkspace();
    const r = runEngine(ws, 'init-gates-req');
    assert.strictEqual(r.status, 0, r.stderr);
    const codeStylePath = path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md');
    const architectureLayersPath = path.join(ws, 'ai-docs', 'global-assets', 'standards', 'architecture-layers.md');
    const gatesPath = path.join(ws, 'ai-docs', 'init-gates-req', '.temp', 'gates.json');
    assert.ok(fs.existsSync(codeStylePath), 'code-style.md 应在 Init 阶段创建骨架');
    assert.ok(fs.existsSync(architectureLayersPath), 'architecture-layers.md 应在 Init 阶段创建骨架');
    const architectureLayers = fs.readFileSync(architectureLayersPath, 'utf8');
    assert.ok(architectureLayers.includes('## Layers'), 'architecture-layers.md 应包含 Layers 骨架');
    const gates = JSON.parse(fs.readFileSync(gatesPath, 'utf8'));
    assert.strictEqual(gates.gates['init.global_assets'].status, 'passed');
    assert.strictEqual(gates.gates['init.architecture_layers'].status, 'pending');
    const j = parseEngineJson(r.stdout);
    assert.strictEqual(j.phase, 'Init');
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-architecture-layers');
  });

  it('Init：architecture-layers.md 为空时会修复为骨架文件', () => {
    const ws = mkWorkspace();
    const standardsDir = path.join(ws, 'ai-docs', 'global-assets', 'standards');
    fs.mkdirSync(standardsDir, { recursive: true });
    const architectureLayersPath = path.join(standardsDir, 'architecture-layers.md');
    fs.writeFileSync(architectureLayersPath, '', 'utf8');

    const r = runEngine(ws, 'empty-layers-req');
    assert.strictEqual(r.status, 0, r.stderr);
    const architectureLayers = fs.readFileSync(architectureLayersPath, 'utf8');
    assert.ok(architectureLayers.includes('# Architecture Layers'), architectureLayers);
    assert.ok(architectureLayers.includes('## Layers'), architectureLayers);
    assert.ok(architectureLayers.includes('specflow:section Layers'), architectureLayers);
    const j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.agent, 'specflow-architecture-layers');
  });

  it('Init：architecture-layers 仅为骨架时不得借 code-style 旧分组通过门禁', () => {
    const ws = mkWorkspace();
    const reqId = 'layers-skeleton-req';
    const standardsDir = path.join(ws, 'ai-docs', 'global-assets', 'standards');
    fs.mkdirSync(standardsDir, { recursive: true });
    fs.writeFileSync(
      path.join(standardsDir, 'architecture-layers.md'),
      [
        '# Architecture Layers',
        '',
        '## Layers',
        '',
        '<!-- specflow:section Layers -->',
        '',
        '_（待 `specflow-architecture-layers` agent 基于真实仓库结构校准填充）_',
        '',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(standardsDir, 'code-style.md'),
      [
        '# Code Style & Architecture',
        '',
        '## Layers',
        '',
        '### `legacy-layer`',
        '- globs:',
        '  - `src/**/*.ts`',
        '- role: 旧版 code-style 内联分层',
        '',
      ].join('\n'),
      'utf8',
    );

    const r = runEngine(ws, reqId);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-architecture-layers');
    assert.strictEqual(j.gates.architectureLayersReady, false);
    const gates = readGates(path.join(ws, 'ai-docs', reqId));
    assert.strictEqual(gates.gates['init.architecture_layers'].status, 'pending');
  });

  it('manage-state recalibrate-layers：清空 Layers 段并重置 architecture-layers 门禁', () => {
    const ws = mkWorkspace();
    const reqId = 'recalibrate-req';
    writeCalibratedArchitectureLayers(ws, reqId);

    const ms = runManageState(ws, reqId, 'recalibrate-layers');
    assert.strictEqual(ms.status, 0, ms.stderr || ms.stdout);
    const out = JSON.parse(ms.stdout);
    assert.strictEqual(out.ok, true);

    const layersPath = path.join(ws, 'ai-docs', 'global-assets', 'standards', 'architecture-layers.md');
    const md = fs.readFileSync(layersPath, 'utf8');
    assert.ok(md.includes('# Architecture Layers'), md);
    assert.ok(md.includes('## Layers'), md);
    assert.ok(md.includes('_（待 agent 校准填充）_'), md);
    assert.ok(!md.includes('### `ui-page`'), md);

    const gates = readGates(path.join(ws, 'ai-docs', reqId));
    assert.strictEqual(gates.gates['init.architecture_layers'].status, 'pending');

    const engine = runEngine(ws, reqId);
    const j = parseEngineJson(engine.stdout);
    assert.strictEqual(j.suggestedAction.agent, 'specflow-architecture-layers');
  });

  it('Init：全局 code-style 为空时派发需同时扫描 Rules 与 SOP', () => {
    const ws = mkWorkspace();
    const reqId = 'code-style-init-sop-req';
    writeCalibratedArchitectureLayers(ws, reqId);
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md'),
      [
        '# Code Style',
        '',
        '## Rules by Layer',
        '',
        '_（暂无全局规则，由需求归档逐步填充）_',
        '',
        '## SOPs',
        '',
        '_（暂无全局 SOP，由需求归档逐步填充）_',
        '',
      ].join('\n'),
      'utf8',
    );

    const r = runEngine(ws, reqId);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-code-style-explorer');
    assert.match(j.suggestedAction.context, /## Rules by Layer 与 ## SOPs/);
    assert.match(j.suggestedAction.context, /没有足够证据形成 SOP/);
    assert.match(j.suggestedAction.context, /必须说明已检查的链路与未生成原因/);
  });

  it('dispatch_array 上限 5：候选 7 个时本轮只派前 5 个，note 标注剩余', () => {
    const ws = mkWorkspace();
    writeCalibratedArchitectureLayers(ws, 'big-req');
    runEngine(ws, 'big-req'); // S1 初始化 ai-docs 目录
    const refs = ['svc/a::a1', 'svc/b::b2', 'svc/c::c3', 'svc/d::d4', 'svc/e::e5', 'svc/f::f6', 'svc/g::g7'];
    let ms = runManageState(ws, 'big-req', 'set-domain-init-candidates', [refs.join(',')]);
    assert.strictEqual(ms.status, 0, ms.stderr);
    // 跳过 yes/no，直接把全部提升为 confirmed（模拟 agent 汇总结果）
    ms = runManageState(ws, 'big-req', 'set-domain-init-pref', ['scan', refs.join(',')]);
    assert.strictEqual(ms.status, 0, ms.stderr);
    const r = runEngine(ws, 'big-req');
    const j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch_array');
    assert.strictEqual(j.suggestedAction.items.length, 5);
    assert.ok(String(j.suggestedAction.note || '').includes('剩余 2'));
  });

  it('候选全部在全局领域：S2 仅 1 道确认题（domain_init_all_from_global_ack）', () => {
    const ws = mkWorkspace();
    writeCalibratedArchitectureLayers(ws, 'payment-feature');
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'domains'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'domains', 'services__order__payment.md'),
      '# payment\n规则',
      'utf8',
    );

    runEngine(ws, 'payment-feature');
    const ms = runManageState(ws, 'payment-feature', 'set-domain-init-candidates', ['services/order::payment']);
    assert.strictEqual(ms.status, 0, ms.stderr);

    const r = runEngine(ws, 'payment-feature');
    const j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'interaction_required');
    const qs = j.suggestedAction.questions || [];
    assert.strictEqual(qs.length, 1);
    assert.strictEqual(qs[0].id, 'domain_init_all_from_global_ack');
    assert.deepStrictEqual(j.suggestedAction.init_context.autoAcceptFromGlobal, ['services/order::payment']);
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

  it('Specify：正文散落内联 [?] → block，禁止进入 Plan', () => {
    const ws = mkWorkspace();
    const specify = specifyComplete().replace(
      '- **[AC-001]** Done.',
      '- **[AC-001]** Done. [?] 该验收口径仍需确认。'
    );
    writeWorkspace(ws, 'R1', { specify });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'Specify');
    assert.strictEqual(j.suggestedAction.type, 'block');
    assert.match(j.suggestedAction.reason, /内联 \[\?\]/);
  });

  it('Specify：.temp/clarifications.json 未闭合 → interaction_required', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', { specify: specifyDraftMinimal() });
    const tempDir = path.join(ws, 'ai-docs', 'R1', '.temp');
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'clarifications.json'),
      JSON.stringify({
        product: [
          {
            id: 'CQ-Product-01',
            question: '是否纳入历史数据？',
            whyCritical: '影响验收样本。',
            recommendation: '推荐不纳入。',
            options: ['不纳入历史数据', '纳入历史数据'],
          },
        ],
      }),
      'utf8'
    );
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'interaction_required');
    assert.strictEqual(j.suggestedAction.questions[0].id, 'CQ-Product-01');
    assert.match(j.suggestedAction.questions[0].prompt, /是否纳入历史数据/);
  });

  it('Specify：answer-clarification 闭合 json 后 → dispatch specify 并注入答案摘要', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', { specify: specifyDraftMinimal() });
    const tempDir = path.join(ws, 'ai-docs', 'R1', '.temp');
    const clarificationPath = path.join(tempDir, 'clarifications.json');
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(
      clarificationPath,
      JSON.stringify({
        items: [
          {
            id: 'CQ-Confirm-01',
            type: 'product',
            status: 'open',
            prompt: '是否仅覆盖新订单？',
            whyCritical: '影响验收样本。',
            recommendation: '推荐仅覆盖新订单。',
            options: [{ id: 'option_a', label: '仅新订单' }],
          },
        ],
      }),
      'utf8'
    );

    const answer = runManageState(ws, 'R1', 'answer-clarification', [
      'CQ-Confirm-01',
      '按建议，仅覆盖新订单',
    ]);
    assert.strictEqual(answer.status, 0, answer.stderr);
    const answerJson = parseEngineJson(answer.stdout);
    assert.strictEqual(answerJson.ok, true);
    assert.strictEqual(answerJson.allClosed, true);

    const stored = JSON.parse(fs.readFileSync(clarificationPath, 'utf8'));
    assert.strictEqual(stored.items[0].status, 'closed');
    assert.strictEqual(stored.items[0].answer, '按建议，仅覆盖新订单');

    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-specify');
    assert.match(j.suggestedAction.context, /已闭合澄清答案/);
    assert.match(j.suggestedAction.context, /按建议，仅覆盖新订单/);
  });

  it('Specify：批量 answer-clarifications 闭合多个 CQ 后 → 继续架构复审', () => {
    const ws = mkWorkspace();
    writeCalibratedArchitectureLayers(ws, 'R1');
    writeWorkspace(ws, 'R1', { specify: specifyComplete() });
    const tempDir = path.join(ws, 'ai-docs', 'R1', '.temp');
    const clarificationPath = path.join(tempDir, 'clarifications.json');
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(
      clarificationPath,
      JSON.stringify({
        items: [
          {
            id: 'CQ-Contract-01',
            type: 'technical',
            status: 'open',
            prompt: '后端接口',
            options: [{ id: 'option_b', label: 'B：在书面 Mock 边界内先推进' }],
          },
          {
            id: 'CQ-Contract-02',
            type: 'technical',
            status: 'open',
            prompt: '字节渠道校验',
            options: [{ id: 'option_b', label: 'B：本期只做最小校验集' }],
          },
          {
            id: 'CQ-Contract-03',
            type: 'technical',
            status: 'open',
            prompt: '权限与账户',
            options: [{ id: 'option_c', label: 'C：继承现有页面权限或由后端下发' }],
          },
        ],
      }),
      'utf8'
    );

    const before = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(before.suggestedAction.type, 'interaction_required');
    assert.strictEqual(before.suggestedAction.reason.match(/存在 3 条未闭合澄清/) != null, true);
    assert.strictEqual(before.suggestedAction.questions.filter((q) => /^CQ-Contract-\d+$/.test(q.id)).length, 3);

    const answer = runManageState(ws, 'R1', 'answer-clarifications', [
      JSON.stringify({
        'CQ-Contract-01': 'B：在书面 Mock 边界内先推进；素材域 API/DTO 在 plan Local Contract 中标注 Mock，联调时整体替换。',
        'CQ-Contract-02': 'B：本期只做最小校验集：mp4；单文件 <=500MB；外链必填且必须为 https。',
        'CQ-Contract-03': 'C：继承现有页面权限或由后端下发；前端不硬编码权限码、账户 ID、免审角色。',
      }),
    ]);
    assert.strictEqual(answer.status, 0, answer.stderr);
    const answerJson = parseEngineJson(answer.stdout);
    assert.strictEqual(answerJson.allClosed, true);
    assert.strictEqual(answerJson.answeredCount, 3);

    const after = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(after.suggestedAction.type, 'dispatch');
    assert.strictEqual(after.suggestedAction.agent, 'specflow-plan-preview');
  });

  it('Specify：answer-clarifications 可写回 specify.md 中的多个 Markdown CQ 并继续', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(`
### [?] CQ-Contract-01: 后端接口
> **需要你决定**: 投流素材为全新域，无列表/上传/审核/免审等 API 路径与字段。
> **为什么关键**: 影响 plan 能否生成 Local Contract。
> **SpecFlow 建议**: 若无正式接口，可在书面 Mock 边界内推进。

- **Option A**: 先补正式接口/字段文档
- **Option B**: 在书面 Mock 边界内先推进
- **Option C**: 其他（附链接/口径）

#### **[User]**:

### [?] CQ-Contract-02: 字节渠道校验
> **需要你决定**: AC-007 要求上传前校验，但规格未收录外链阈值表。
> **为什么关键**: 影响前端本地校验与联调替换点。
> **SpecFlow 建议**: 本期只做最小校验集。

- **Option A**: 补完整字节规格文档/字段表
- **Option B**: 本期只做最小校验集（需列清单）
- **Option C**: 复用仓库内已有校验模块（指明路径）

#### **[User]**:

### [?] CQ-Contract-03: 权限与账户
> **需要你决定**: 权限码、默认账户 ID、免审 xauth 角色未闭合。
> **为什么关键**: 影响权限门禁和接口参数。
> **SpecFlow 建议**: 继承现有页面权限或由后端下发。

- **Option A**: 补正式权限码表 + 账户 ID + 角色标识
- **Option B**: 本期用占位标识（需写替换规则）
- **Option C**: 继承现有页面权限或由后端下发

#### **[User]**:
`),
    });

    const before = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(before.suggestedAction.type, 'interaction_required');
    assert.strictEqual(before.suggestedAction.questions.filter((q) => /^CQ-Contract-\d+$/.test(q.id)).length, 3);
    assert.strictEqual(before.suggestedAction.questions.filter((q) => /__detail$/.test(q.id)).length, 3);

    const answer = runManageState(ws, 'R1', 'answer-clarifications', [
      JSON.stringify([
        { id: 'CQ-Contract-01', answer: 'B：在书面 Mock 边界内先推进' },
        { id: 'CQ-Contract-02', answer: 'B：本期只做最小校验集：mp4；单文件 <=500MB' },
        { id: 'CQ-Contract-03', answer: 'C：继承现有页面权限或由后端下发' },
      ]),
    ]);
    assert.strictEqual(answer.status, 0, answer.stderr);
    const answerJson = parseEngineJson(answer.stdout);
    assert.strictEqual(answerJson.allClosed, true);
    assert.strictEqual(answerJson.openCount, 0);

    const after = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(after.suggestedAction.type, 'dispatch');
    assert.strictEqual(after.suggestedAction.agent, 'specflow-plan-preview');
    const stored = fs.readFileSync(path.join(ws, 'ai-docs', 'R1', 'specify.md'), 'utf8');
    assert.match(stored, /B：在书面 Mock 边界内先推进/);
    assert.match(stored, /C：继承现有页面权限或由后端下发/);
  });

  it('Specify：完整 specify 生成后自动清空 clarifications.json', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', { specify: specifyComplete() });
    const tempDir = path.join(ws, 'ai-docs', 'R1', '.temp');
    const clarificationPath = path.join(tempDir, 'clarifications.json');
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(
      clarificationPath,
      JSON.stringify({
        items: [
          {
            id: 'CQ-Confirm-01',
            type: 'product',
            status: 'closed',
            prompt: '是否仅覆盖新订单？',
            answer: '按建议，仅覆盖新订单',
          },
        ],
      }),
      'utf8'
    );

    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.gates.specifyComplete, true);
    assert.ok(!fs.existsSync(clarificationPath), '完整 specify 后应清空临时澄清 json');
  });

  it('Specify：新格式澄清会生成业务决策题 prompt', () => {
    const ws = mkWorkspace();
    const specify = specifyComplete(`
### [?] CQ-01: 是否纳入历史数据回填
> **需要你决定**: 本次上线后，历史订单是否也要展示新的状态标签？
> **为什么关键**: 这会影响验收范围、数据处理方式和 QA 样本。
> **SpecFlow 建议**: 推荐仅覆盖新订单，以降低上线风险。

- **Option A (推荐)**: 仅新产生的订单展示新状态。
  - 适合: 快速上线，风险较低。
  - 代价: 历史订单体验不完全一致。
- **Option B**: 新旧订单全部展示新状态。
  - 适合: 强一致体验。
  - 代价: 需要确认历史数据映射规则。

#### **[User]**:
`);
    writeWorkspace(ws, 'R1', { specify });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'interaction_required');
    const q = j.suggestedAction.questions[0];
    assert.match(q.prompt, /需要你决定：本次上线后/);
    assert.match(q.prompt, /为什么关键：这会影响验收范围/);
    assert.match(q.prompt, /SpecFlow 建议：推荐仅覆盖新订单/);
    assert.ok(q.options.some((o) => String(o.label).includes('仅新产生的订单展示新状态')));
  });

  it('Specify：建议确认会生成确认式 prompt', () => {
    const ws = mkWorkspace();
    const specify = specifyComplete(`
### [?] CQ-Confirm-01: 上传后默认审核状态
> **需要你确认**: 素材上传后默认进入「待审核」，审核通过后才可被业务使用。
> **为什么关键**: 这会影响状态流转、验收样本和免审规则。
> **SpecFlow 建议**: 现有素材流程以审核后发布为主，默认待审核风险更低。

- **Option A (推荐)**: 按 SpecFlow 建议处理。
- **Option B**: 不采用，请按补充说明调整。

#### **[User]**:
`);
    writeWorkspace(ws, 'R1', { specify });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'interaction_required');
    const q = j.suggestedAction.questions[0];
    assert.match(q.prompt, /需要你确认：素材上传后默认进入/);
    assert.match(q.prompt, /为什么关键：这会影响状态流转/);
    assert.match(q.prompt, /SpecFlow 建议：现有素材流程/);
    assert.ok(q.options.some((o) => String(o.label).includes('按 SpecFlow 建议处理')));
  });

  it('Specify：超过 3 条未闭合澄清也一次性返回', () => {
    const ws = mkWorkspace();
    const cq = (n) => `
### [?] CQ-0${n}: 决策 ${n}
> **需要你决定**: 是否采用方案 ${n}？
> **为什么关键**: 影响 AC-${n} 的验收口径。
> **SpecFlow 建议**: 推荐 Option A。

- **Option A (推荐)**: 采用默认方案 ${n}。
- **Option B**: 采用备选方案 ${n}。

#### **[User]**:
`;
    writeWorkspace(ws, 'R1', { specify: specifyComplete([1, 2, 3, 4].map(cq).join('\n')) });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'interaction_required');
    assert.strictEqual(j.suggestedAction.questions.length, 4);
    assert.ok(!String(j.suggestedAction.reason).includes('每轮最多'));
  });

  it('Specify：草稿 → 默认派发 specflow-specify', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', { specify: specifyDraftMinimal() });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'Specify');
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-specify');
  });

  it('Specify：无 domainAllowlist 时注入空业务基线策略，不用全局知识冒充依据', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', { specify: specifyDraftMinimal() });
    const globalDir = path.join(ws, 'ai-docs', 'global-assets', 'domains');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, 'payment.md'),
      [
        '---',
        'status: Verified',
        '---',
        '# payment',
        '全局支付规则不应在空 allowlist 的 Specify 中冒充业务基线',
      ].join('\n'),
      'utf8',
    );

    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-specify');
    assert.match(j.suggestedAction.context, /当前没有已确认业务领域或需求级业务知识库/);
    assert.doesNotMatch(j.suggestedAction.context, /全局支付规则不应/);

    const pending = JSON.parse(
      fs.readFileSync(path.join(ws, 'ai-docs', 'R1', '.temp', 'pending-protocol.json'), 'utf8')
    );
    assert.strictEqual(pending.knowledgePolicy.baselineStatus, 'empty');
    assert.deepStrictEqual(pending.knowledgePolicy.domainAllowlist, []);
    assert.strictEqual(pending.knowledgeContext, null);
  });

  it('Specify：派发时注入结构化 knowledgeContext，优先命中当前规格相关领域', () => {
    const ws = mkWorkspace();
    writeCalibratedArchitectureLayers(ws, 'R1');
    writeWorkspace(ws, 'R1', {
      specify: specifyDraftMinimal().replace('Draft only.', 'Draft only for payment checkout.'),
      state: { stateVersion: 1, domainInitRefs: ['services/order::payment'] },
    });
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'domains'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'domains', 'services__order__payment.md'),
      '# payment\n支付结算 Verified 规则',
      'utf8'
    );
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'domains', 'inventory.md'),
      '# inventory\n库存规则',
      'utf8'
    );

    const r = runEngine(ws, 'R1');
    assert.strictEqual(r.status, 0, r.stderr);
    const j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.agent, 'specflow-specify');
    const protocol = JSON.parse(
      fs.readFileSync(path.join(ws, 'ai-docs', 'R1', '.temp', 'pending-protocol.json'), 'utf8')
    );
    const ctx = String(protocol.knowledgeContext || '');
    assert.ok(ctx.includes('services__order__payment.md'), ctx);
    assert.ok(ctx.includes('支付结算 Verified 规则'), ctx);
    assert.ok(!ctx.includes('inventory.md'), ctx);
  });

  it('Specify：旧 Markdown CQ-Domain-Init 不再触发 domain-explorer', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', { specify: specifyIncompleteDomainCQClosed('Payment') });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-specify');
  });

  it('Specify：clarifications.json 中 CQ-Domain-Init 已答扫描 → dispatch domain-explorer', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', { specify: specifyDraftMinimal() });
    const tempDir = path.join(ws, 'ai-docs', 'R1', '.temp');
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'clarifications.json'),
      JSON.stringify(
        {
          product: [
            {
              id: 'CQ-Domain-Init',
              prompt: '缺少 [Payment] 业务知识库',
              status: 'closed',
              answer: 'Option A：需要先扫代码库并逐步生成业务知识库',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'Specify');
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-domain-explorer');
    assert.match(j.suggestedAction.context, /Payment/);
  });

  it('Plan：规格含 [BLOCKER] 门禁且尚无 plan → block（Plan 分支 canProceedToPlan）', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyCompleteWithBlockerGate(),
    });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'PlanReadiness');
    assert.strictEqual(j.suggestedAction.type, 'block');
    assert.ok(String(j.suggestedAction.reason).includes('规格'));
  });

  it('Plan：无 plan.md、未完成技术方案预审 → dispatch specflow-plan-preview', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      state: { stateVersion: 1, ackSpecifyBeforePlan: false },
    });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'PlanReadiness');
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-plan-preview');
  });

  it('Plan：无 plan.md、需确认进入 Plan → interaction_required confirm_start_plan', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      state: { stateVersion: 1, ackSpecifyBeforePlan: false },
    });
    const ackR = runManageState(ws, 'R1', 'ack-specify-review');
    assert.strictEqual(ackR.status, 0, ackR.stderr);
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'PlanReadiness');
    assert.strictEqual(j.suggestedAction.type, 'interaction_required');
    const q = j.suggestedAction.questions.find((x) => x.id === 'confirm_start_plan');
    assert.ok(q);
    assert.match(q.prompt, /需求说明已就绪，技术前置问题也已处理完/);
    assert.strictEqual(
      q.prompt,
      '需求说明已就绪，技术前置问题也已处理完。\n\n是否开始生成**技术方案**？',
    );
    assert.strictEqual(q.progressKey, 'interaction.plan_confirm');
    assert.strictEqual(j.userFacing.templateId, 'orchestration.plan_confirm');
    assert.strictEqual(j.userFacing.progress.progressKey, 'interaction.plan_confirm');
    assert.strictEqual(j.userFacing.progress.goal, '确认是否开始技术方案');
    assert.strictEqual(j.userFacing.progress.llm.mode, 'compose_guidance_from_progress_model');
    assert.match(j.userFacing.fallbackMessage, /这一步会做/);
  });

  it('Plan：确认生成 plan 会清理旧 Group 授权，生成 plan 后需先确认进入 Implement', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      state: {
        stateVersion: 1,
        activeGroup: 'Group A',
        autoProceedGroups: true,
        groupRetryCount: 2,
      },
    });

    const reviewR = runManageState(ws, 'R1', 'ack-specify-review');
    assert.strictEqual(reviewR.status, 0, reviewR.stderr);
    const ackR = runManageState(ws, 'R1', 'ack-specify-before-plan');
    assert.strictEqual(ackR.status, 0, ackR.stderr);

    let st = readState(path.join(ws, 'ai-docs', 'R1'));
    assert.strictEqual(st.activeGroup, undefined);
    assert.strictEqual(st.autoProceedGroups, false);
    assert.strictEqual(st.groupRetryCount, 0);

    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'R1', 'plan.md'),
      planWithRoadmap('- [ ] T1 | F-01 |'),
      'utf8',
    );
    const ackCs = runManageState(ws, 'R1', 'ack-code-style-sync');
    assert.strictEqual(ackCs.status, 0, ackCs.stderr);

    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'Implement');
    assert.strictEqual(j.suggestedAction.type, 'interaction_required');
    const q = j.suggestedAction.questions.find((x) => x.id === 'confirm_start_implement');
    assert.ok(q);
    assert.ok(q.options.some((x) => x.id === 'confirm'));
    assert.ok(q.options.some((x) => x.id === 'auto_proceed'));

    ackPlanBeforeImplement(ws, 'R1', { activeGroup: 'Group A' });
    const j2 = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j2.suggestedAction.type, 'dispatch');
    assert.strictEqual(j2.suggestedAction.agent, 'specflow-implement');
  });

  it('Implement：残留 activeGroup 不得绕过 plan.implement_approved', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: planWithRoadmap('- [ ] T1 | F-01 |'),
      state: {
        stateVersion: 1,
        activeGroup: 'Group A',
        autoProceedGroups: true,
      },
    });

    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'Implement');
    assert.strictEqual(j.suggestedAction.type, 'interaction_required');
    assert.ok(j.suggestedAction.questions.some((x) => x.id === 'confirm_start_implement'));
  });

  it('Implement：plan.implement_approved 写入后，任务状态推进导致 plan 快照变化不反复弹确认', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: planWithRoadmap('- [ ] **T1** | F-01 |'),
      state: { stateVersion: 1 },
    });

    ackPlanBeforeImplement(ws, 'R1', { activeGroup: 'Group A', auto: true });
    const gatesAfterAck = readGates(path.join(ws, 'ai-docs', 'R1'));
    assert.strictEqual(gatesAfterAck.gates['plan.implement_approved'].status, 'passed');

    const r = runManageState(ws, 'R1', 'mark-task', ['T1', 'ready-for-qa']);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    if (j.suggestedAction.type === 'interaction_required') {
      assert.ok(
        !(j.suggestedAction.questions || []).some((x) => x.id === 'confirm_start_implement'),
        `不应因任务状态推进反复弹进入实现确认: ${JSON.stringify(j.suggestedAction)}`,
      );
    }
  });

  it('Plan：技术前置评审 blocked 且未生成澄清题 → block，不进入 Plan', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      state: { stateVersion: 1, ackSpecifyBeforePlan: false },
    });
    const r = runManageState(ws, 'R1', 'mark-specify-review-blocked', ['接口字段未确认']);
    assert.strictEqual(r.status, 0, r.stderr);
    const gates = readGates(path.join(ws, 'ai-docs', 'R1'));
    assert.strictEqual(gates.gates['plan.readiness_review'].status, 'blocked');
    assert.strictEqual(gates.gates['plan.user_confirm_start'].status, 'blocked');
    assert.ok(gates.gates['plan.user_confirm_start'].snapshot);
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'PlanReadiness');
    assert.strictEqual(j.suggestedAction.type, 'block');
    assert.match(j.suggestedAction.reason, /技术方案前置评审仍为阻塞状态/);
  });

  it('Plan：非阻塞区存在 CQ-Contract 技术债务 → 重新派发评审，不允许确认 Plan', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(`
### Notes (非阻塞说明)
- 素材域 API 前缀与各 endpoint（CQ-Contract-01）需在 plan.md 中显式标注 Mock 边界。
`),
      state: { stateVersion: 1, ackSpecifyBeforePlan: false },
    });
    const ackR = runManageState(ws, 'R1', 'ack-specify-review');
    assert.strictEqual(ackR.status, 0, ackR.stderr);
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'PlanReadiness');
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-plan-preview');
    assert.match(j.suggestedAction.context, /不得作为 Notes、Plan 内待办或非阻塞项/);
    assert.strictEqual(j.gates.technicalClarificationDebtCount, 1);
  });

  it('Plan：架构评审通过后不再等待需求级 code-style，直接进入 Plan 确认', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      state: { stateVersion: 1, ackSpecifyBeforePlan: false },
    });
    const ackR = runManageState(ws, 'R1', 'ack-specify-review');
    assert.strictEqual(ackR.status, 0, ackR.stderr);
    const gates = JSON.parse(fs.readFileSync(path.join(ws, 'ai-docs', 'R1', '.temp', 'gates.json'), 'utf8'));
    assert.strictEqual(gates.gates['plan.readiness_review'].status, 'passed');
    assert.strictEqual(gates.gates['plan.readiness_review'].evidence[0], 'confirmed');
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'PlanReadiness');
    assert.strictEqual(j.suggestedAction.type, 'interaction_required');
    assert.ok(j.suggestedAction.questions.some((x) => x.id === 'confirm_start_plan'));
  });

  it('Plan：specify 变更后只需重新确认进入 Plan，不触发 code-style explorer 门禁', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      state: { stateVersion: 1 },
    });
    let r1 = runManageState(ws, 'R1', 'ack-specify-review');
    assert.strictEqual(r1.status, 0, r1.stderr);
    const specifyPath = path.join(ws, 'ai-docs', 'R1', 'specify.md');
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(specifyPath, future, future);
    const ackR2 = runManageState(ws, 'R1', 'ack-specify-review');
    assert.strictEqual(ackR2.status, 0, ackR2.stderr);
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'PlanReadiness');
    assert.strictEqual(j.suggestedAction.type, 'interaction_required');
    assert.ok(j.suggestedAction.questions.some((x) => x.id === 'confirm_start_plan'));
  });

  it('Plan：无 plan.md 时不生成需求级 code-style，避免复制全局规范', () => {
    const ws = mkWorkspace();
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'standards'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md'),
      [
        '# Code Style & Architecture',
        '',
        '## Layers',
        '',
        '### `ui-page`',
        '- globs:',
        '  - `src/pages/**/*.vue`',
        '- role: 页面层',
        '',
        '## SOPs',
        '',
        '_（暂无全局 SOP）_',
        '',
        '## Rules by Layer',
        '',
        '### `ui-page`',
        '- [naming] 使用语义化命名 (layers: ui-page) (applies: src/pages/**/*.vue)',
        '',
      ].join('\n'),
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
    assert.ok(!fs.existsSync(reqCodeStylePath));
    assert.ok(!fs.existsSync(reqPatchPath));
  });

  it('Plan：已确认且无 plan → 派发 specflow-plan', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      state: {
        stateVersion: 1,
        ackSpecifyBeforePlan: true,
        specifyAckMtime: Number.MAX_SAFE_INTEGER,
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
    let planMd = planWithRoadmap();
    planMd = planMd.replace('Arch.', 'Arch [BLOCKER] block.');
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: planMd,
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });
    ackPlanBeforeImplement(ws);
    runManageState(ws, 'R1', 'ack-code-style-sync');
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'Implement');
    assert.strictEqual(j.suggestedAction.type, 'block');
  });

  it('Implement：Roadmap [Blocked] → block', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: planWithBlockedTag(),
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });
    ackPlanBeforeImplement(ws);
    runManageState(ws, 'R1', 'ack-code-style-sync');
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'block');
    assert.ok(j.suggestedAction.reason.includes('Blocked'));
  });

  it('Implement：无待处理 Group（空 Group）→ block', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: planEmptyGroup(),
      state: { stateVersion: 1 },
    });
    ackPlanBeforeImplement(ws);
    runManageState(ws, 'R1', 'ack-code-style-sync');
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'Implement');
    assert.strictEqual(j.suggestedAction.type, 'block');
    assert.ok(j.suggestedAction.reason.includes('Group'));
  });

  it('Implement：activeGroup 不匹配 → confirm_start_group', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: planWithRoadmap('- [ ] T1 | F-01 |'),
      state: { stateVersion: 1, activeGroup: 'Group B' },
    });
    ackPlanBeforeImplement(ws, 'R1', { activeGroup: 'Group B' });
    runManageState(ws, 'R1', 'ack-code-style-sync');
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'interaction_required');
    const q = j.suggestedAction.questions.find((x) => x.id === 'confirm_start_group');
    assert.ok(q);
  });

  it('Implement：返回 confirm_start_group 时会清理过期 pending-protocol，防止旧 Group 协议被派发', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: planWithRoadmap('- [ ] T1 | F-01 |'),
      state: { stateVersion: 1 },
    });
    ackPlanBeforeImplement(ws);
    runManageState(ws, 'R1', 'ack-code-style-sync');
    const tempDir = path.join(ws, 'ai-docs', 'R1', '.temp');
    fs.mkdirSync(tempDir, { recursive: true });
    const protocolPath = path.join(tempDir, 'pending-protocol.json');
    fs.writeFileSync(
      protocolPath,
      JSON.stringify(
        {
          requirementId: 'R1',
          phase: 'Implement',
          agent: 'specflow-implement',
          groupId: 'Group A',
        },
        null,
        2,
      ),
      'utf8',
    );

    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'Implement');
    assert.strictEqual(j.suggestedAction.type, 'interaction_required');
    assert.ok(j.suggestedAction.questions.some((x) => x.id === 'confirm_start_group'));
    assert.strictEqual(fs.existsSync(protocolPath), false);
  });

  it('Implement：autoProceedGroups 自动对齐 activeGroup → 派发 implement', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: planWithRoadmap('- [ ] T1 | F-01 |'),
      state: { stateVersion: 1, activeGroup: 'Group B', autoProceedGroups: true },
    });
    ackPlanBeforeImplement(ws, 'R1', { activeGroup: 'Group B', auto: true });
    runManageState(ws, 'R1', 'ack-code-style-sync');
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
      plan: planWithRoadmap('- [!] Fail | F-01 |'),
      state: { stateVersion: 1, activeGroup: 'Group A', groupRetryCount: 4 },
    });
    ackPlanBeforeImplement(ws, 'R1', { activeGroup: 'Group A', groupRetryCount: 4 });
    runManageState(ws, 'R1', 'ack-code-style-sync');
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'interaction_required');
    assert.ok(j.suggestedAction.questions.some((q) => q.id === 'retry_limit_exceeded'));
  });

  it('Implement：存在 [!] → 派发 specflow-implement Bug Fix', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: planWithRoadmap('- [!] Fail | F-01 |'),
      state: { stateVersion: 1, activeGroup: 'Group A', groupRetryCount: 0 },
    });
    ackPlanBeforeImplement(ws, 'R1', { activeGroup: 'Group A' });
    runManageState(ws, 'R1', 'ack-code-style-sync');
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-implement');
    assert.ok(String(j.suggestedAction.context).includes('Bug Fix'));
  });

  it('Implement：存在 [?] → 派发 specflow-qa（单 Group 全 [?] 即 FinalQA）', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: planWithRoadmap('- [?] QA | F-01 |'),
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });
    ackPlanBeforeImplement(ws, 'R1', { activeGroup: 'Group A' });
    runManageState(ws, 'R1', 'ack-code-style-sync');
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
      plan:
        planWithRoadmap(
          [
            '- [?] **T-A1** | QA | F-01 |',
            '',
            '### Group B: B',
            '- [ ] **T-B1** | 待开发 | F-02',
          ].join('\n')
        )
      ,
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });
    ackPlanBeforeImplement(ws, 'R1', { activeGroup: 'Group A' });
    runManageState(ws, 'R1', 'ack-code-style-sync');
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
      plan:
        planWithRoadmap(
          '- [ ] **T-A1** | Code A | F-01 |',
          '\n### Group B: B\n- [!] **T-B1** | Fix B | F-02 |'
        )
      ,
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });
    ackPlanBeforeImplement(ws, 'R1', { activeGroup: 'Group A' });
    runManageState(ws, 'R1', 'ack-code-style-sync');
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-implement');
    assert.ok(String(j.suggestedAction.context).includes('待开发任务'));
  });

  it('Implement：plan 已存在但 code-style 未同步 → 先派发 specflow-code-style-explorer', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: planWithRoadmap('- [ ] Code | F-01 |'),
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });
    ackPlanBeforeImplement(ws, 'R1', { activeGroup: 'Group A' });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'Implement');
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-code-style-explorer');
    assert.ok(String(j.suggestedAction.context).includes('ack-code-style-sync'));
  });

  it('Implement：ack-code-style-sync 后正常进入 implement', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: planWithRoadmap('- [ ] Code | F-01 |'),
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });
    ackPlanBeforeImplement(ws, 'R1', { activeGroup: 'Group A' });
    const ack = runManageState(ws, 'R1', 'ack-code-style-sync');
    assert.strictEqual(ack.status, 0, ack.stderr);
    const gates = JSON.parse(fs.readFileSync(path.join(ws, 'ai-docs', 'R1', '.temp', 'gates.json'), 'utf8'));
    assert.strictEqual(gates.gates['plan.code_style_synced'].status, 'passed');
    assert.ok(gates.gates['plan.code_style_synced'].snapshot);

    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-implement');
    assert.ok(String(j.suggestedAction.context).includes('Roadmap'));
  });

  it('Implement：plan.md 变更后 code-style 快照失效 → 再次派发 explorer', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: planWithRoadmap('- [ ] Code | F-01 |'),
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });
    ackPlanBeforeImplement(ws, 'R1', { activeGroup: 'Group A' });
    const ack = runManageState(ws, 'R1', 'ack-code-style-sync');
    assert.strictEqual(ack.status, 0, ack.stderr);

    const planPath = path.join(ws, 'ai-docs', 'R1', 'plan.md');
    fs.appendFileSync(planPath, '\n- [CodeStyle] naming: 使用语义化命名 (layers: ui-page)\n', 'utf8');
    ackPlanBeforeImplement(ws, 'R1', { activeGroup: 'Group A' });

    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'Implement');
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-code-style-explorer');
  });

  it('Implement：正常 [ ] → 派发 specflow-implement 编码', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: planWithRoadmap('- [ ] Code | F-01 |'),
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });
    ackPlanBeforeImplement(ws, 'R1', { activeGroup: 'Group A' });
    const ack = runManageState(ws, 'R1', 'ack-code-style-sync');
    assert.strictEqual(ack.status, 0, ack.stderr);
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-implement');
    assert.ok(String(j.suggestedAction.context).includes('Roadmap'));
  });

  it('Implement：autoProceed=true 下连续 mark-task（含 plan.md mtime 前进）不清授权、不弹 confirm_start_group', () => {
    const ws = mkWorkspace();
    const plan = planWithCompletionPacket('- [ ] **T-A1** | 任务1 | F-01 |\n- [ ] **T-A2** | 任务2 | F-01 |');
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan,
      state: { stateVersion: 1, activeGroup: 'Group A', autoProceedGroups: true },
    });
    ackPlanBeforeImplement(ws, 'R1', { activeGroup: 'Group A', auto: true });
    runManageState(ws, 'R1', 'ack-code-style-sync');

    // 首跑：托管生效 → 派发 implement
    const j1 = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j1.suggestedAction.type, 'dispatch');
    assert.strictEqual(j1.suggestedAction.agent, 'specflow-implement');

    // 模拟 implement 子代理连续更新 plan.md（mtime 前进多次）
    const r1 = runManageState(ws, 'R1', 'mark-task', ['T-A1', 'ready-for-qa']);
    assert.strictEqual(r1.status, 0, r1.stderr);
    const r2 = runManageState(ws, 'R1', 'mark-task', ['T-A1', 'completed', qaLiteEvidence()]);
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
    assert.notStrictEqual(
      j2.suggestedAction.agent,
      'specflow-code-style-explorer',
      `仅任务状态变化不应重复同步 code-style，实际：${JSON.stringify(j2.suggestedAction)}`
    );
  });

  it('Implement：confirm_start_implement 选择 Group 后同一快照下不再弹 confirm_start_group', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: planWithRoadmap('- [ ] T1 | F-01 |'),
      state: { stateVersion: 1 },
    });
    const j1 = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j1.suggestedAction.type, 'interaction_required');
    assert.ok(j1.suggestedAction.questions.some((x) => x.id === 'confirm_start_implement'));

    ackPlanBeforeImplement(ws, 'R1', { activeGroup: 'Group A' });
    const j1b = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j1b.suggestedAction.type, 'dispatch');
    assert.strictEqual(j1b.suggestedAction.agent, 'specflow-code-style-explorer');

    const ackCs = runManageState(ws, 'R1', 'ack-code-style-sync');
    assert.strictEqual(ackCs.status, 0, ackCs.stderr);
    const jReady = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(jReady.suggestedAction.type, 'dispatch');
    assert.strictEqual(jReady.suggestedAction.agent, 'specflow-implement');

    const st = readState(path.join(ws, 'ai-docs', 'R1'));
    assert.strictEqual(st.activeGroup, 'Group A');
    assert.strictEqual(st.autoProceedGroups, false, '单 Group 模式不应开启自动托管');
  });

  it('Implement：set-active-group <id>（不带 --auto）可作为退出自动托管入口', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: planWithRoadmap('- [ ] T1 | F-01 |'),
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
      plan: planAllCompleted(),
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
      plan: planAllCompleted(),
      state: { stateVersion: 1, domainMerged: false, knowledgeReviewed: false },
    });
    // 首跑：anchor 提示
    const j1 = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j1.suggestedAction.type, 'anchor');

    // 模拟用户主动触发归档
    const r = runManageState(ws, 'R1', 'set-archive-anchor');
    assert.strictEqual(r.status, 0, r.stderr);
    const gates = readGates(path.join(ws, 'ai-docs', 'R1'));
    assert.strictEqual(gates.gates['archive.user_anchor'].status, 'passed');

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
      plan: planAllCompleted(),
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
      plan: planAllCompleted(),
      state: { stateVersion: 1, archiveAnchorDone: true, domainMerged: true, knowledgeReviewed: false },
    });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'Archive');
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-knowledge-reviewer');
  });

  it('Archive：Merge/Review gate 被打回时忽略旧 state 并回到可恢复步骤', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: planAllCompleted(),
      state: { stateVersion: 1, archiveAnchorDone: true, domainMerged: true, knowledgeReviewed: true },
    });
    const reqDir = path.join(ws, 'ai-docs', 'R1');
    blockGate(reqDir, 'archive.knowledge_reviewed', {
      reason: 'global merge failed',
      evidence: 'test failure',
    });

    let j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-knowledge-reviewer');

    blockGate(reqDir, 'archive.domain_merged', {
      reason: 'domain merge failed',
      evidence: 'test failure',
    });
    j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-domain-explorer');
    assert.strictEqual(j.suggestedAction.mode, 'Merge');
  });

  it('Archive：domainMerged=true、knowledgeReviewed=true、archiveAnchorDone=true → specflow-archive', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: planAllCompleted(),
      state: { stateVersion: 1, domainMerged: true, knowledgeReviewed: true, archiveAnchorDone: true },
    });
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-archive');
  });

  it('Archive：旧 state 标记不再绕过 archive.user_anchor gate', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: planAllCompleted(),
      state: { stateVersion: 1, archiveAnchorDone: true },
    });
    const reqDir = path.join(ws, 'ai-docs', 'R1');
    fs.unlinkSync(path.join(reqDir, '.temp', 'gates.json'));
    const j = parseEngineJson(runEngine(ws, 'R1').stdout);
    assert.strictEqual(j.phase, 'Archive');
    assert.strictEqual(j.suggestedAction.type, 'anchor');
  });

  it('Archive（history 路径）：跳过领域合并，直接派发归档', () => {
    const ws = mkWorkspace();
    writeHistoryRequirement(
      ws,
      'H1',
      {
        specify: specifyComplete(),
        plan: planAllCompleted(),
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
      plan: planWithRoadmap('- [ ] P | F-01 |'),
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
      plan: plan,
      state: { stateVersion: 1, activeGroup: 'Group A', autoProceedGroups: true },
    });
    ackPlanBeforeImplement(ws, reqId, { activeGroup: 'Group A', auto: true });
    runManageState(ws, reqId, 'ack-code-style-sync');

    const r = spawnSync(process.execPath, [ORCHESTRATOR, 'implement', ws, reqId], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch_array');
    assert.strictEqual(j.suggestedAction.waitPolicy, 'any_done');
    assert.strictEqual(j.suggestedAction.groupIsolation, true);
    const items = Array.isArray(j.suggestedAction.items) ? j.suggestedAction.items : [];
    assert.ok(items.length >= 2);
    // 两个 Group 都是 pending → 都派 specflow-implement
    const groupIds = items.map((a) => a.groupId).sort();
    assert.deepStrictEqual(groupIds, ['Group A', 'Group B']);
    assert.ok(items.every((a) => a.agent === 'specflow-implement'),
      `都是 pending 时应全部派 specflow-implement，实际：${items.map((a) => a.agent).join(',')}`);
    // 每个 action 都必须带 per-group focusPlan
    assert.ok(items.every((a) => typeof a.focusPlan === 'string' && a.focusPlan.length > 0),
      '每个 dispatch_array 元素必须自带 per-group focusPlan');

    // pending-protocol.json 以 dispatch_array 形态落盘，便于 print-protocol.cjs --group 过滤
    const protocolPath = path.join(ws, 'ai-docs', reqId, '.temp', 'pending-protocol.json');
    assert.ok(fs.existsSync(protocolPath), 'pending-protocol.json 必须落盘');
    const protocol = JSON.parse(fs.readFileSync(protocolPath, 'utf8'));
    assert.strictEqual(protocol.kind, 'dispatch_array');
    assert.strictEqual(protocol.waitPolicy, 'any_done');
    assert.strictEqual(protocol.groupIsolation, true);
    assert.strictEqual(Array.isArray(protocol.items), true);
    assert.strictEqual(protocol.items.length, items.length);
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
      plan: plan,
      state: { stateVersion: 1, activeGroup: 'Group A', autoProceedGroups: true },
    });
    ackPlanBeforeImplement(ws, reqId, { activeGroup: 'Group A', auto: true });
    runManageState(ws, reqId, 'ack-code-style-sync');

    const r = spawnSync(process.execPath, [ORCHESTRATOR, 'implement', ws, reqId], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch_array');
    const agents = Array.isArray(j.suggestedAction.items) ? j.suggestedAction.items : [];
    // Group A ready-for-qa → specflow-qa；Group B pending → specflow-implement；同一批混合
    assert.ok(agents.some((a) => a.groupId === 'Group A' && a.agent === 'specflow-qa'));
    assert.ok(agents.some((a) => a.groupId === 'Group B' && a.agent === 'specflow-implement'));
    // Group B 仍 pending，Group A QA 本批不应触发 FinalQA
    const qaA = agents.find((a) => a.groupId === 'Group A' && a.agent === 'specflow-qa');
    assert.ok(qaA);
    assert.strictEqual(qaA.qaMode, 'lite');
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
      plan: plan,
      state: { stateVersion: 1, activeGroup: 'Group A', autoProceedGroups: true },
    });
    ackPlanBeforeImplement(ws, reqId, { activeGroup: 'Group A', auto: true });
    runManageState(ws, reqId, 'ack-code-style-sync');

    const r = spawnSync(process.execPath, [ORCHESTRATOR, 'implement', ws, reqId], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch_array');
    const agents = Array.isArray(j.suggestedAction.items) ? j.suggestedAction.items : [];
    const qaActions = agents.filter((a) => a.agent === 'specflow-qa');
    assert.ok(qaActions.length >= 2);
    for (const a of qaActions) {
      assert.strictEqual(a.qaMode, 'lite');
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
      plan: plan,
      state: { stateVersion: 1, activeGroup: 'Group B', autoProceedGroups: true },
    });
    ackPlanBeforeImplement(ws, reqId, { activeGroup: 'Group B', auto: true });
    runManageState(ws, reqId, 'ack-code-style-sync');

    const r = spawnSync(process.execPath, [ORCHESTRATOR, 'implement', ws, reqId], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const j = parseEngineJson(r.stdout);
    // 单剩一个 Group 的 dispatch_array 会退化为 dispatch
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-qa');
    assert.strictEqual(j.suggestedAction.groupId, 'Group B');
    assert.strictEqual(j.suggestedAction.qaMode, 'lite');
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
      plan: plan,
      state: { stateVersion: 1, activeGroup: 'Group A', autoProceedGroups: false },
    });
    ackPlanBeforeImplement(ws, reqId, { activeGroup: 'Group A' });
    runManageState(ws, reqId, 'ack-code-style-sync');

    const r = spawnSync(process.execPath, [ORCHESTRATOR, 'implement', ws, reqId], {
      encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0, r.stderr);
    const j = parseEngineJson(r.stdout);
    assert.strictEqual(j.suggestedAction.type, 'dispatch');
    assert.strictEqual(j.suggestedAction.agent, 'specflow-implement');
  });
});

describe('plan-parser focusPlan', () => {
  it('自足 Task Group 只下发本组上下文，不再携带全局 Contract/Feature 大块', () => {
    const plan = [
      '# Plan R1',
      '',
      '## 1. Architecture',
      '<!-- specflow:section=architecture -->',
      'GLOBAL ARCHITECTURE SHOULD NOT LEAK',
      '',
      '## 2. Technical Contracts',
      '<!-- specflow:section=contract -->',
      'GLOBAL CONTRACT SHOULD NOT LEAK',
      '',
      '## 3. Feature & Design',
      '<!-- specflow:section=feature -->',
      '### [F-01] Global Feature',
      'GLOBAL FEATURE SHOULD NOT LEAK',
      '',
      '## 4. Roadmap',
      '<!-- specflow:section=roadmap -->',
      '### Group A: 自足执行单元',
      '- **Goal**: 完成用户列表筛选',
      '- **Depends on**: none',
      '- **User AC**:',
      '  - AC-001 支持按用户名筛选',
      '- **Local Contract**:',
      '  - `GET /api/users?name=` returns `{ items: User[] }`',
      '- **Files**:',
      '  - Modify: `src/users/api.ts`',
      '- **Test Strategy**:',
      '  - TDD Units: `src/users/api.spec.ts`',
      '  - Unit/Component Checks: none',
      '  - Mock Smoke: mock `GET /api/users` and verify query param',
      '  - Static Diagnostics: changed files evidence',
      '- **Group Verify**: Red/Green/Refactor + mock smoke + contract evidence',
      '- [ ] **T-A1 [TDD]** | 用户筛选 API | Ref: F-01 | Step: Red → Green → Refactor | Verify: `src/users/api.spec.ts`',
      '',
      '## 5. Execution Log',
      '<!-- specflow:section=execution-log -->',
      '- Group A: previous attempt summary',
      '- Group B: unrelated summary',
    ].join('\n')

    const focusPlan = buildFocusPlanFromTree(parseMarkdownTree(plan), 'Group A')

    assert.ok(focusPlan.includes('## Active Task Group'))
    assert.ok(focusPlan.includes('Local Contract'))
    assert.ok(focusPlan.includes('Test Strategy'))
    assert.ok(focusPlan.includes('GET /api/users'))
    assert.ok(!focusPlan.includes('Group A: previous attempt summary'))
    assert.ok(!focusPlan.includes('GLOBAL ARCHITECTURE SHOULD NOT LEAK'))
    assert.ok(!focusPlan.includes('GLOBAL CONTRACT SHOULD NOT LEAK'))
    assert.ok(!focusPlan.includes('GLOBAL FEATURE SHOULD NOT LEAK'))
  });
});

describe('knowledge loop solution', () => {
  it('gates schema：未注册 gate 不能写入，passed 必须有 evidence', () => {
    const ws = mkWorkspace();
    const reqDir = path.join(ws, 'ai-docs', 'R1');
    fs.mkdirSync(reqDir, { recursive: true });

    const unknown = passGate(reqDir, 'random.unknown_gate', { evidence: 'x' });
    assert.strictEqual(unknown.ok, false);
    assert.match(unknown.error, /unknown gate id/);

    const missingEvidence = passGate(reqDir, 'init.global_assets');
    assert.strictEqual(missingEvidence.ok, false);
    assert.match(missingEvidence.error, /requires evidence/);

    assert.ok(GATE_DEFINITIONS['plan.readiness_review']);
    const invalidShape = validateGate({ id: 'plan.readiness_review', status: 'passed', evidence: ['ok'] });
    assert.strictEqual(invalidShape.ok, false);
    assert.match(invalidShape.error, /requires snapshot/);
  });

  it('gates schema：定义约束 stage/scope，block 必须有 reason', () => {
    const ws = mkWorkspace();
    const reqDir = path.join(ws, 'ai-docs', 'R1');
    fs.mkdirSync(reqDir, { recursive: true });

    const blockedNoReason = validateGate({
      id: 'init.global_assets',
      status: 'blocked',
      stage: 'Init',
      scope: 'global',
    });
    assert.strictEqual(blockedNoReason.ok, false);
    assert.match(blockedNoReason.error, /requires reason/);

    const ok = blockGate(reqDir, 'init.global_assets', {
      stage: 'Wrong',
      scope: 'wrong',
      reason: 'init failed',
    });
    assert.strictEqual(ok.ok, true, ok.error);
    assert.strictEqual(ok.gate.stage, 'Init');
    assert.strictEqual(ok.gate.scope, 'global');

    const gates = readGates(reqDir);
    assert.strictEqual(gates.gates['init.global_assets'].status, 'blocked');
    assert.strictEqual(gates.gates['init.global_assets'].stage, 'Init');
  });

  it('gates history：重复写入同一状态不追加，且最多保留最近 20 条', () => {
    const ws = mkWorkspace();
    const reqDir = path.join(ws, 'ai-docs', 'R1');
    fs.mkdirSync(reqDir, { recursive: true });

    const first = passGate(reqDir, 'init.global_assets', {
      evidence: 'assets ready',
    });
    assert.strictEqual(first.ok, true, first.error);
    const second = passGate(reqDir, 'init.global_assets', {
      evidence: 'assets ready',
    });
    assert.strictEqual(second.ok, true, second.error);

    let gates = readGates(reqDir);
    assert.strictEqual(gates.gates['init.global_assets'].history.length, 1);

    for (let i = 0; i < 25; i += 1) {
      const ok = passGate(reqDir, 'init.global_assets', {
        evidence: `assets ready ${i}`,
      });
      assert.strictEqual(ok.ok, true, ok.error);
    }

    gates = readGates(reqDir);
    const history = gates.gates['init.global_assets'].history;
    assert.strictEqual(history.length, 20);
    assert.strictEqual(history[0].status, 'passed');
    assert.strictEqual(history[history.length - 1].status, 'passed');
  });

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
    assert.ok(!indexText.includes('| services__order__payment |'), 'init 阶段 index.md 不得出现从目录名派生的领域行');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    assert.deepStrictEqual(metadata, {}, 'init 阶段 metadata.json 应为空对象');
  });

  it('inventory-scan add-domain 原语幂等落盘领域骨架 + index + metadata', () => {
    const ws = mkWorkspace();
    const init = spawnSync(process.execPath, [INVENTORY_SCAN, ws], { encoding: 'utf8' });
    assert.strictEqual(init.status, 0, init.stderr);

    // 第一次 add-domain：由 agent 显式传入领域身份与证据
    const r1 = spawnSync(
      process.execPath,
      [INVENTORY_SCAN, 'add-domain', '--workspace', ws, '--ref', 'services/order::payment', '--source', 'src/services/payment'],
      { encoding: 'utf8' }
    );
    assert.strictEqual(r1.status, 0, r1.stderr);
    const j1 = JSON.parse(r1.stdout);
    assert.strictEqual(j1.ok, true);
    assert.strictEqual(j1.domain, 'services/order::payment');
    assert.strictEqual(j1.domainKey, 'services__order__payment');
    assert.strictEqual(j1.created, true);

    const domainPath = path.join(ws, 'ai-docs', 'global-assets', 'domains', 'services__order__payment.md');
    const text = fs.readFileSync(domainPath, 'utf8');
    assert.ok(text.startsWith('---\n'));
    assert.ok(text.includes('sourceRequirementIds: []'));
    assert.ok(text.includes('**status**: Draft'));
    assert.ok(text.includes('## 领域摘要'), '应包含预算化领域摘要');
    assert.ok(/\|\s*术语\s*\|\s*语义\s*\|\s*约束 \/ 枚举\s*\|\s*来源\s*\|/.test(text), '应包含统一语言表头');
    assert.ok(!text.includes('## 证据附录'), '不再生成证据附录');

    const indexText = fs.readFileSync(path.join(ws, 'ai-docs', 'global-assets', 'domains', 'index.md'), 'utf8');
    assert.ok(indexText.includes('| services__order__payment | Draft | src/services/payment |'));

    // 第二次幂等调用：不覆盖、不重复追加
    const r2 = spawnSync(
      process.execPath,
      [INVENTORY_SCAN, 'add-domain', '--workspace', ws, '--ref', 'services/order::payment', '--source', 'src/services/payment'],
      { encoding: 'utf8' }
    );
    assert.strictEqual(r2.status, 0, r2.stderr);
    const j2 = JSON.parse(r2.stdout);
    assert.strictEqual(j2.created, false, '已存在的 <domain>.md 不应被覆盖');
    assert.strictEqual(j2.indexAppended, false, 'index.md 已存在行不应重复追加');
    const indexText2 = fs.readFileSync(path.join(ws, 'ai-docs', 'global-assets', 'domains', 'index.md'), 'utf8');
    const occurrences = indexText2.split('\n').filter((l) => l.trim().startsWith('| services__order__payment |')).length;
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
      plan: planWithRoadmap('- [ ] Task | F-01 |'),
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
      plan: planWithRoadmap('- [ ] **T-A1** | implement | F-01 |'),
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId, '.temp'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', reqId, '.temp', 'knowledge-patch.json'),
      JSON.stringify(
        [{ domain: 'services/order::payment', category: 'rule', scope: '本地规则', content: '局部 patch 内容' }],
        null,
        2,
      ),
      'utf8'
    );
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'domains'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'domains', 'services__order__payment.md'),
      '# Payment\n[Verified]\n全局规则',
      'utf8'
    );
    ackPlanBeforeImplement(ws, reqId, { activeGroup: 'Group A' });

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
    writeCalibratedArchitectureLayers(ws, reqId);
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: planAllCompleted(),
      state: { stateVersion: 1, domainMerged: true, archiveAnchorDone: true },
    });
    fs.writeFileSync(path.join(ws, 'ai-docs', reqId, 'summary.md'), '# Summary\n\n归档摘要\n', 'utf8');
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId, '.temp'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', reqId, '.temp', 'knowledge-patch.json'),
      JSON.stringify([{ domain: 'services/order::payment', status: 'Draft', content: '新增已验证规则' }], null, 2),
      'utf8'
    );
    fs.writeFileSync(
      path.join(ws, 'ai-docs', reqId, '.temp', 'coding-standard-patch.json'),
      JSON.stringify([{ section: 'naming', content: '函数名使用动词开头', layers: ['ui-page'] }], null, 2),
      'utf8'
    );
    const now = new Date();
    const year = String(now.getFullYear());
    const month = now.getMonth() + 1;
    const quarter = month <= 3 ? 'Q1' : month <= 6 ? 'Q2' : month <= 9 ? 'Q3' : 'Q4';
    const staleTargetDir = path.join(ws, 'ai-docs', 'history', year, quarter, reqId);
    fs.mkdirSync(path.join(staleTargetDir, '.temp'), { recursive: true });
    fs.writeFileSync(path.join(staleTargetDir, '.temp', 'gates.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(staleTargetDir, 'plan.md'), 'stale plan', 'utf8');

    const r = spawnSync(process.execPath, [ARCHIVE, ws, reqId], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(fs.readdirSync(staleTargetDir).sort(), ['specify.md', 'summary.md']);
    assert.ok(fs.readFileSync(path.join(staleTargetDir, 'summary.md'), 'utf8').includes('归档摘要'));
    assert.ok(fs.existsSync(path.join(ws, 'ai-docs', 'global-assets', 'domains', 'services__order__payment.md')));
    assert.ok(fs.existsSync(path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md')));
    const metadata = JSON.parse(
      fs.readFileSync(path.join(ws, 'ai-docs', 'global-assets', 'metadata.json'), 'utf8')
    );
    assert.ok(metadata.services__order__payment);
    assert.strictEqual(metadata.services__order__payment.last_requirement, reqId);
    assert.deepStrictEqual(metadata.services__order__payment.sourceRequirementIds, [reqId]);
    assert.strictEqual(metadata.services__order__payment.status, 'Draft');
    assert.strictEqual(metadata.services__order__payment.maintainer, 'specflow-knowledge-reviewer');
    assert.ok(!Object.prototype.hasOwnProperty.call(metadata.services__order__payment, 'lastRequirementId'), '不再保留兼容字段 lastRequirementId');
    assert.ok(!Object.prototype.hasOwnProperty.call(metadata.services__order__payment, 'author'), '不再保留兼容字段 author');
  });

  it('orchestrator change 默认会触发 --extract 并生成 patch 文件', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    writeCalibratedArchitectureLayers(ws, reqId);
    writeWorkspace(ws, reqId, {
      specify: `${specifyComplete()}

### [Resolved] CQ-Rule: 折扣规则
> **背景**: 活动
#### **[User]**:
**[User]**: 满减逻辑已确认`,
      plan: planWithRoadmap('- [ ] **T-A1** | coding | F-01 |\n- [CodeStyle] naming: 使用语义化命名 (layers: ui-page)'),
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
    writeCalibratedArchitectureLayers(ws, reqId);
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'standards'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md'),
      [
        '# Code Style & Architecture',
        '',
        '## Layers',
        '',
        '### `ui-page`',
        '- globs:',
        '  - `src/pages/**/*.vue`',
        '- role: 页面层',
        '',
        '## SOPs',
        '',
        '_（暂无全局 SOP）_',
        '',
        '## Rules by Layer',
        '',
        '### `ui-page`',
        '- [naming] 使用语义化命名 (layers: ui-page) (applies: src/pages/**/*.vue)',
        '',
      ].join('\n'),
      'utf8'
    );
    const plan = 
      planWithRoadmap(
        '- [ ] **T-A1** | coding | F-01 |\n- [CodeStyle] naming: 使用语义化命名 (layers: ui-page)\n- [CodeStyle] api: controller 层禁止直接访问数据库 (layers: ui-page)'
      )
    ;
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

  it('mark-task 到 ready-for-qa 时只执行结构门禁并沉淀 code-style patch', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    writeCalibratedArchitectureLayers(ws, reqId);
    const plan = planWithCompletionPacket(
      '- [ ] **T-A1** | coding | F-01 |\n- [CodeStyle] naming: 使用语义化命名 (layers: ui-page)'
    );
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan,
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });

    const passGate = runManageState(ws, reqId, 'mark-task', ['T-A1', 'ready-for-qa']);
    assert.strictEqual(passGate.status, 0, passGate.stderr);
    const j = JSON.parse(passGate.stdout);
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.to, 'ready-for-qa');
    assert.ok(!Object.prototype.hasOwnProperty.call(j, 'verify'));
    assert.ok(fs.existsSync(path.join(ws, 'ai-docs', reqId, '.temp', 'coding-standard-patch.json')));
    const codingPatch = JSON.parse(
      fs.readFileSync(path.join(ws, 'ai-docs', reqId, '.temp', 'coding-standard-patch.json'), 'utf8')
    );
    assert.ok(Array.isArray(codingPatch));
    assert.ok(codingPatch.some((p) => p.section === 'naming'));
  });

  it('mark-task 到 ready-for-qa 不再要求 plan.md Completion Packet', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    const plan = planWithRoadmap('- [ ] **T-A1** | coding | F-01 |');
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan,
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });

    const r = runManageState(ws, reqId, 'mark-task', ['T-A1', 'ready-for-qa']);
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.to, 'ready-for-qa');
    const gates = readGates(path.join(ws, 'ai-docs', reqId));
    assert.strictEqual(gates.gates['implement.completion_packet_ready'].status, 'passed');
  });

  it('mark-group 到 ready-for-qa 时仅执行结构门禁并批量更新任务', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    const plan = planWithCompletionPacket('- [ ] **T-A1** | coding | F-01 |\n- [ ] **T-A2** | coding | F-01 |');
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan,
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });

    const r = runManageState(ws, reqId, 'mark-group', ['Group A', 'ready-for-qa']);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.to, 'ready-for-qa');
    assert.strictEqual(j.matchedTasks, 2);
    assert.ok(!Object.prototype.hasOwnProperty.call(j, 'verify'));

    const planNow = fs.readFileSync(path.join(ws, 'ai-docs', reqId, 'plan.md'), 'utf8');
    assert.ok(planNow.includes('- [?] **T-A1**'));
    assert.ok(planNow.includes('- [?] **T-A2**'));
    assert.ok(!planNow.includes('### Roadmap Status Overview'));
    assert.ok(!planNow.includes('specflow:roadmap-status-overview'));
  });

  it('mark-group 到 ready-for-qa 不再要求 plan.md Completion Packet', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    const plan = planWithRoadmap('- [ ] **T-A1** | coding | F-01 |\n- [ ] **T-A2** | coding | F-01 |');
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan,
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });

    const r = runManageState(ws, reqId, 'mark-group', ['Group A', 'ready-for-qa']);
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.to, 'ready-for-qa');
    assert.strictEqual(out.matchedTasks, 2);
    const gates = readGates(path.join(ws, 'ai-docs', reqId));
    assert.strictEqual(gates.gates['implement.completion_packet_ready'].status, 'passed');
  });

  it('mark-group 到 ready-for-qa 不再要求 plan.md Verification Matrix', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    const plan = withoutVerificationMatrix(
      planWithCompletionPacket('- [ ] **T-A1** | coding | F-01 |\n- [ ] **T-A2** | coding | F-01 |')
    );
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan,
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });

    const r = runManageState(ws, reqId, 'mark-group', ['Group A', 'ready-for-qa']);
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.to, 'ready-for-qa');
    const gates = readGates(path.join(ws, 'ai-docs', reqId));
    assert.strictEqual(gates.gates['implement.completion_packet_ready'].status, 'passed');
  });

  it('mark-group 可将当前组 ready-for-qa 批量标记为 failed', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    const plan = 
      planWithRoadmap('- [?] **T-A1** | qa | F-01 |\n- [?] **T-A2** | qa | F-01 |')
    ;
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
    assert.ok(!planNow.includes('### Roadmap Status Overview'));
    assert.ok(!planNow.includes('specflow:roadmap-status-overview'));
  });

  it('mark-task failed 且 evidence 含 [CodeStyle] 时会沉淀 coding-standard-patch', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    writeCalibratedArchitectureLayers(ws, reqId);
    const plan = planWithRoadmap('- [?] **T-A1** | qa | F-01 |');
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan,
      state: { stateVersion: 1, activeGroup: 'Group A', groupRetryCount: 0 },
    });

    const r = runManageState(ws, reqId, 'mark-task', [
      'T-A1',
      'failed',
      '[CodeStyle] naming: 禁止使用无语义变量名 (layers: ui-page)',
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
    writeCalibratedArchitectureLayers(ws, reqId);
    const plan = 
      planWithRoadmap('- [?] **T-A1** | qa | F-01 |\n- [?] **T-A2** | qa | F-01 |')
    ;
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan,
      state: { stateVersion: 1, activeGroup: 'Group A', groupRetryCount: 0 },
    });

    const r = runManageState(ws, reqId, 'mark-group', [
      'Group A',
      'failed',
      '[CodeStyle] api: controller 层禁止直接访问数据库 (layers: ui-page)',
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
    const plan = 
      planWithCompletionPacket('- [?] **T-A1** | qa | F-01 |\n- [!] **T-A2** | qa | F-01 |')
    ;
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan,
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });

    const r = runManageState(ws, reqId, 'mark-group', ['Group A', 'completed', qaLiteEvidence()]);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.to, 'completed');
    assert.strictEqual(j.matchedTasks, 1);

    const planNow = fs.readFileSync(path.join(ws, 'ai-docs', reqId, 'plan.md'), 'utf8');
    assert.ok(planNow.includes('- [x] **T-A1**'));
    assert.ok(planNow.includes('- [!] **T-A2**'));
  });

  it('mark-group completed 缺少 QA Lite Evidence 时由状态机阻断', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    const plan = planWithRoadmap('- [?] **T-A1** | qa | F-01 |');
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan,
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });

    const r = runManageState(ws, reqId, 'mark-group', ['Group A', 'completed', 'qa pass evidence']);
    assert.ok(r.status !== 0);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.ok, false);
    assert.ok(String(out.error).includes('QA Lite Evidence'));
    const gates = readGates(path.join(ws, 'ai-docs', reqId));
    assert.strictEqual(gates.gates['qa.lite_evidence_ready'].status, 'blocked');
  });

  it('mark-group completed 只依赖调用参数中的 QA Lite Evidence，不依赖 plan.md Completion Packet', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    const plan = withoutVerificationMatrix(planWithCompletionPacket('- [?] **T-A1** | qa | F-01 |'));
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan,
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });

    const r = runManageState(ws, reqId, 'mark-group', ['Group A', 'completed', qaLiteEvidence()]);
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.to, 'completed');
    const gates = readGates(path.join(ws, 'ai-docs', reqId));
    assert.strictEqual(gates.gates['qa.lite_evidence_ready'].status, 'passed');
  });

  it('mark-group 到 ready-for-qa 时会在保留历史补丁的基础上补充 plan 规范', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    writeCalibratedArchitectureLayers(ws, reqId);
    const plan = planWithCompletionPacket(
      '- [ ] **T-A1** | coding | F-01 |\n- [CodeStyle] naming: 使用语义化命名 (layers: ui-page)'
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
      JSON.stringify([{ section: 'legacy', content: '旧规则', layers: ['ui-page'] }], null, 2),
      'utf8'
    );

    const r = runManageState(ws, reqId, 'mark-group', ['Group A', 'ready-for-qa']);
    assert.strictEqual(r.status, 0, r.stderr);
    const patchNow = JSON.parse(
      fs.readFileSync(path.join(ws, 'ai-docs', reqId, '.temp', 'coding-standard-patch.json'), 'utf8')
    );
    assert.ok(patchNow.some((p) => p.section === 'naming'));
    assert.ok(patchNow.some((p) => p.section === 'legacy' && p.content === '旧规则'));
  });

  it('知识注入会优先返回与当前任务更相关的 domain', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    const plan = planWithRoadmap('- [ ] **T-A1** | implement payment checkout and refund flow | F-01 |');
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan,
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'domains'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'domains', 'services__order__payment.md'),
      '# payment\n核心支付规则',
      'utf8'
    );
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'domains', 'inventory.md'),
      '# inventory\n库存规则',
      'utf8'
    );
    ackPlanBeforeImplement(ws, reqId, { activeGroup: 'Group A' });

    const r = runEngine(ws, reqId);
    assert.strictEqual(r.status, 0, r.stderr);
    const pending = JSON.parse(
      fs.readFileSync(path.join(ws, 'ai-docs', reqId, '.temp', 'pending-protocol.json'), 'utf8')
    );
    const ctx = String(pending.knowledgeContext || '');
    assert.ok(ctx.includes('services__order__payment.md'));
    assert.ok(!ctx.includes('inventory.md'));
  });

  it('知识注入存在已确认领域时只读取该领域，避免相似文本串入其他模块', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    const plan = planWithRoadmap('- [ ] **T-A1** | Inventory wording appears in the task, but confirmed domain is payment | F-01 |');
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan,
      state: { stateVersion: 1, activeGroup: 'Group A', domainInitRefs: ['services/order::payment'] },
    });
    writeBusinessDomain(ws, reqId, 'services/order::payment', '# payment\n需求级支付规则');
    writeBusinessDomain(ws, reqId, 'services/inventory::inventory', '# inventory\n需求级库存规则');
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'domains'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'domains', 'services__order__payment.md'),
      '# payment\n全局支付规则',
      'utf8'
    );
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'domains', 'services__inventory__inventory.md'),
      '# inventory\n全局库存规则',
      'utf8'
    );
    ackPlanBeforeImplement(ws, reqId, { activeGroup: 'Group A' });

    const r = runEngine(ws, reqId);
    assert.strictEqual(r.status, 0, r.stderr);
    const pending = JSON.parse(
      fs.readFileSync(path.join(ws, 'ai-docs', reqId, '.temp', 'pending-protocol.json'), 'utf8')
    );
    const ctx = String(pending.knowledgeContext || '');
    assert.ok(ctx.includes('services__order__payment.md'));
    assert.ok(ctx.includes('需求级支付规则'));
    assert.ok(!ctx.includes('inventory.md'));
    assert.ok(!ctx.includes('需求级库存规则'));
    assert.ok(!ctx.includes('全局库存规则'));
  });

});

describe('archive knowledge reviewer gate', () => {
  it('Archive 阶段在 archiveAnchorDone=true、domainMerged=true 但未 knowledgeReviewed 时派发 specflow-knowledge-reviewer', () => {
    const ws = mkWorkspace();
    writeWorkspace(ws, 'R1', {
      specify: specifyComplete(),
      plan: planAllCompleted(),
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
      plan: planAllCompleted(),
      state: { stateVersion: 1, domainMerged: true, archiveAnchorDone: true },
    });
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId, '.temp'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', reqId, '.temp', 'knowledge-patch.json'),
      JSON.stringify([{ domain: 'services/order::payment', category: 'rule', scope: '默认', content: '新增规则' }], null, 2),
      'utf8'
    );
    const r = spawnSync(process.execPath, [MERGE_GLOBAL_ASSETS, ws, reqId], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const domainPath = path.join(ws, 'ai-docs', 'global-assets', 'domains', 'services__order__payment.md');
    assert.ok(fs.existsSync(domainPath));
    const metadata = JSON.parse(
      fs.readFileSync(path.join(ws, 'ai-docs', 'global-assets', 'metadata.json'), 'utf8')
    );
    assert.ok(metadata.services__order__payment);
    assert.strictEqual(metadata.services__order__payment.last_requirement, reqId);
    assert.deepStrictEqual(metadata.services__order__payment.sourceRequirementIds, [reqId]);
  });

  it('set-domain-merged 从 business-domains 文件提取 patch（H1 含 scope::slug、无 frontmatter）', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    const bdDir = path.join(ws, 'ai-docs', reqId, 'business-domains');
    fs.mkdirSync(bdDir, { recursive: true });
    // 贴近模板：仅 H1 用 scope::slug，无 YAML frontmatter
    fs.writeFileSync(
      path.join(bdDir, 'services__order-flow.md'),
      [
        '# Domain: services::order-flow',
        '',
        '## 稳定业务规则',
        '',
        '| 场景 | 规则 | 强度 | 来源 |',
        '| --- | --- | --- | --- |',
        '| 关单 | 待支付订单30分钟未支付自动关闭 | Hard | R1 |',
        '',
      ].join('\n'),
      'utf8'
    );
    const ms = runManageState(ws, reqId, 'set-domain-merged');
    assert.strictEqual(ms.status, 0, ms.stderr);
    const out = JSON.parse(ms.stdout);
    assert.strictEqual(out.domainExtractedCount, 1, '应从 business-domains 提取 1 条 patch');
    const patch = JSON.parse(
      fs.readFileSync(path.join(ws, 'ai-docs', reqId, '.temp', 'knowledge-patch.json'), 'utf8')
    );
    assert.strictEqual(patch.length, 1);
    assert.strictEqual(patch[0].domain, 'services::order-flow');
    assert.strictEqual(patch[0].category, 'rule');
  });

  it('set-domain-merged 在文件无 frontmatter 也无合法 H1 时回退用文件名反推 domain', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    const bdDir = path.join(ws, 'ai-docs', reqId, 'business-domains');
    fs.mkdirSync(bdDir, { recursive: true });
    // H1 是中文名（非 scope::slug），靠文件名 services__inventory 反推
    fs.writeFileSync(
      path.join(bdDir, 'services__inventory.md'),
      [
        '# Domain: 库存管理',
        '',
        '## 统一语言 & 实体',
        '',
        '| 术语 | 语义 | 约束 / 枚举 | 来源 |',
        '| --- | --- | --- | --- |',
        '| 库存 | 可售数量 | 在库/锁定/缺货 | R1 |',
        '',
      ].join('\n'),
      'utf8'
    );
    const ms = runManageState(ws, reqId, 'set-domain-merged');
    assert.strictEqual(ms.status, 0, ms.stderr);
    const out = JSON.parse(ms.stdout);
    assert.strictEqual(out.domainExtractedCount, 1, '应通过文件名反推 domain 并提取 patch');
    const patch = JSON.parse(
      fs.readFileSync(path.join(ws, 'ai-docs', reqId, '.temp', 'knowledge-patch.json'), 'utf8')
    );
    assert.strictEqual(patch[0].domain, 'services::inventory');
  });

  it('merge-global-assets 合并代码规范时按 layer 分组渲染（不丢 layers 落入 unmapped）', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: planAllCompleted(),
      state: { stateVersion: 1, domainMerged: true, archiveAnchorDone: true },
    });
    const standardsDir = path.join(ws, 'ai-docs', 'global-assets', 'standards');
    fs.mkdirSync(standardsDir, { recursive: true });
    fs.writeFileSync(
      path.join(standardsDir, 'architecture-layers.md'),
      [
        '# Architecture Layers',
        '',
        '## Layers',
        '',
        '### `service`',
        '- globs:',
        '  - `src/services/**/*.ts`',
        '- role: 服务层',
        '',
      ].join('\n'),
      'utf8'
    );
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId, '.temp'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', reqId, '.temp', 'coding-standard-patch.json'),
      JSON.stringify([
        { section: 'imports', content: 'service 仅调用 api 层', kind: 'addition', layers: ['service'], applies: ['src/services/**/*.ts'] },
      ], null, 2),
      'utf8'
    );
    const r = spawnSync(process.execPath, [MERGE_GLOBAL_ASSETS, ws, reqId], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const styleNow = fs.readFileSync(path.join(standardsDir, 'code-style.md'), 'utf8');
    assert.ok(styleNow.includes('### `service`'), '规则应归入 service layer 分组');
    assert.ok(!styleNow.includes('### `unmapped`'), '规则不应落入 unmapped');
    assert.ok(styleNow.includes('imports: service 仅调用 api 层'), styleNow);
  });

  it('merge-global-assets 在未确认归档时拒绝提前合并', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: planAllCompleted(),
      state: { stateVersion: 1, domainMerged: true, archiveAnchorDone: false },
    });
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId, '.temp'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', reqId, '.temp', 'knowledge-patch.json'),
      JSON.stringify([{ domain: 'services/order::payment', title: 'Rule', content: '新增规则' }], null, 2),
      'utf8'
    );
    const r = spawnSync(process.execPath, [MERGE_GLOBAL_ASSETS, ws, reqId], { encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.ok, false);
    assert.ok(String(j.error || '').includes('归档尚未确认'));
    assert.ok(!fs.existsSync(path.join(ws, 'ai-docs', 'global-assets', 'domains', 'services__order__payment.md')));
  });

  it('merge-global-assets 首次合并单一需求时 status 为 Draft（置信度阶梯化）', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: planAllCompleted(),
      state: { stateVersion: 1, domainMerged: true, knowledgeReviewed: false, archiveAnchorDone: true },
    });
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId, '.temp'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', reqId, '.temp', 'knowledge-patch.json'),
      JSON.stringify([{ domain: 'services/order::payment', title: 'Rule', content: '新增规则' }], null, 2),
      'utf8'
    );
    const r = spawnSync(process.execPath, [MERGE_GLOBAL_ASSETS, ws, reqId], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const domainPath = path.join(ws, 'ai-docs', 'global-assets', 'domains', 'services__order__payment.md');
    const text = fs.readFileSync(domainPath, 'utf8');
    assert.ok(text.includes(`sourceRequirementIds: [${reqId}]`), 'frontmatter 应仅保留 sourceRequirementIds 为事实字段');
    assert.ok(!/^status:\s/m.test(text), 'frontmatter 不应再双写 status 派生字段');
    assert.ok(text.includes('**status**: Draft'), 'body badge 应现算 status=Draft');
    assert.ok(text.includes(`**last_requirement**: ${reqId}`), 'body badge 应现算 last_requirement');
  });

  it('merge-global-assets 按 category 分桶：entity/rule/stateMachine/formula/pitfall/techDebt 各进对应表格', () => {
    const ws = mkWorkspace();
    const reqId = 'R-CAT';
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: planAllCompleted(),
      state: { stateVersion: 1, domainMerged: true, knowledgeReviewed: false, archiveAnchorDone: true },
    });
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId, '.temp'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', reqId, '.temp', 'knowledge-patch.json'),
      JSON.stringify(
        [
          { domain: 'services/order::payment', category: 'entity', term: 'payStatus', content: '付费状态枚举', enum: ['FREE', 'PAID'] },
          { domain: 'services/order::payment', category: 'rule', scope: '上线判定', content: '可上线需审核通过', strength: 'hard' },
          { domain: 'services/order::payment', category: 'stateMachine', from: '审核中', condition: '*', to: '禁编辑', content: '审核中禁编辑' },
          { domain: 'services/order::payment', category: 'formula', scope: '热度判定', formula: 'MAX(当前热度值 × 2, 历史峰值热度值)', boundary: '内容库专辑' },
          { domain: 'services/order::payment', category: 'pitfall', scope: 'suggest', content: '内容库 suggest 与推广域 SheetSuggest 不可混用', impact: '错误关联片单' },
          { domain: 'services/order::payment', category: 'techDebt', id: 'TD-1', content: '付费档位扩展需升级枚举' },
        ],
        null,
        2,
      ),
      'utf8'
    );
    const r = spawnSync(process.execPath, [MERGE_GLOBAL_ASSETS, ws, reqId], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const text = fs.readFileSync(path.join(ws, 'ai-docs', 'global-assets', 'domains', 'services__order__payment.md'), 'utf8');
    assert.ok(text.includes('## 统一语言 & 实体'));
    assert.ok(text.includes('payStatus'));
    assert.ok(text.includes('## 稳定业务规则'));
    assert.ok(text.includes('可上线需审核通过'));
    assert.ok(text.includes('| Hard |') || text.includes('Hard'));
    assert.ok(text.includes('## 状态机 / 门禁'));
    assert.ok(text.includes('审核中'));
    assert.ok(text.includes('## 核心公式'));
    assert.ok(text.includes('MAX(当前热度值'));
    assert.ok(text.includes('## 避坑 / 风险'));
    assert.ok(text.includes('SheetSuggest'));
    assert.ok(text.includes('## 技术债 & TODO'));
    assert.ok(text.includes('TD-1'));
    assert.ok(text.includes('## 领域摘要'));
    assert.ok(!text.includes('## 证据附录'));
  });

  it('merge-global-assets：category=ui 的条目不回流到全局 domains/', () => {
    const ws = mkWorkspace();
    const reqId = 'R-UI';
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: planAllCompleted(),
      state: { stateVersion: 1, domainMerged: true, knowledgeReviewed: false, archiveAnchorDone: true },
    });
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId, '.temp'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', reqId, '.temp', 'knowledge-patch.json'),
      JSON.stringify(
        [
          { domain: 'services/order::payment', category: 'ui', content: '列表列固定在付费状态后' },
          { domain: 'services/order::payment', category: 'rule', content: '保存入参与查询字段一致' },
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
    const text = fs.readFileSync(path.join(ws, 'ai-docs', 'global-assets', 'domains', 'services__order__payment.md'), 'utf8');
    assert.ok(text.includes('保存入参与查询字段一致'));
    assert.ok(!text.includes('列表列固定在付费状态后'), 'ui 类别不应回流到全局 domain md');
  });

  it('merge-global-assets 置信度阶梯化：同一规则被 3 个需求覆盖 → Verified', () => {
    const ws = mkWorkspace();
    const ensureReq = (reqId) => {
      writeWorkspace(ws, reqId, {
        specify: specifyComplete(),
        plan: planAllCompleted(),
        state: { stateVersion: 1, domainMerged: true, knowledgeReviewed: false, archiveAnchorDone: true },
      });
      fs.mkdirSync(path.join(ws, 'ai-docs', reqId, '.temp'), { recursive: true });
      fs.writeFileSync(
        path.join(ws, 'ai-docs', reqId, '.temp', 'knowledge-patch.json'),
        JSON.stringify(
          [{ domain: 'services/order::payment', category: 'rule', content: '保存入参与查询字段一致', attributes: { scope: '入参一致性' } }],
          null,
          2,
        ),
        'utf8',
      );
      const r = spawnSync(process.execPath, [MERGE_GLOBAL_ASSETS, ws, reqId], { encoding: 'utf8' });
      assert.strictEqual(r.status, 0, r.stderr);
    };
    ensureReq('REQ-A');
    let text = fs.readFileSync(path.join(ws, 'ai-docs', 'global-assets', 'domains', 'services__order__payment.md'), 'utf8');
    assert.ok(text.includes('**status**: Draft'));
    ensureReq('REQ-B');
    text = fs.readFileSync(path.join(ws, 'ai-docs', 'global-assets', 'domains', 'services__order__payment.md'), 'utf8');
    assert.ok(text.includes('**status**: Consolidating'));
    ensureReq('REQ-C');
    text = fs.readFileSync(path.join(ws, 'ai-docs', 'global-assets', 'domains', 'services__order__payment.md'), 'utf8');
    assert.ok(text.includes('**status**: Verified'));
    assert.ok(text.includes('sourceRequirementIds: [REQ-A, REQ-B, REQ-C]'));
  });

  it('merge-global-assets 兼容老 bullet list：保留为 Legacy 段，不误伤', () => {
    const ws = mkWorkspace();
    const reqId = 'R-LEG';
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: planAllCompleted(),
      state: { stateVersion: 1, domainMerged: true, knowledgeReviewed: false, archiveAnchorDone: true },
    });
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'domains'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'domains', 'services__order__payment.md'),
      '# payment\n\n- 旧规则一：支付状态必须同步\n- 旧规则二：退款链路独立\n',
      'utf8'
    );
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId, '.temp'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', reqId, '.temp', 'knowledge-patch.json'),
      JSON.stringify(
        [{ domain: 'services/order::payment', category: 'rule', content: '新结构规则', attributes: { scope: '新增' } }],
        null,
        2,
      ),
      'utf8'
    );
    const r = spawnSync(process.execPath, [MERGE_GLOBAL_ASSETS, ws, reqId], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const text = fs.readFileSync(path.join(ws, 'ai-docs', 'global-assets', 'domains', 'services__order__payment.md'), 'utf8');
    assert.ok(text.includes('## 稳定业务规则'));
    assert.ok(text.includes('新结构规则'));
    assert.ok(text.includes('## Legacy (pre-migration)'));
    assert.ok(text.includes('旧规则一：支付状态必须同步'));
    assert.ok(text.includes('旧规则二：退款链路独立'));
  });

  it('domain-knowledge 计算默认上下文预算', () => {
    const domainKnowledge = require(
      path.join(__dirname, '..', 'tools', 'domain-knowledge.cjs')
    );
    const md = [
      '---',
      'domain: services/order::payment',
      'maintainer: specflow-knowledge-reviewer',
      'sourceRequirementIds: [R1]',
      '---',
      '',
      '# services/order::payment',
      '',
      '## 领域摘要',
      '',
      '| 项 | 内容 |',
      '| --- | --- |',
      '| 职责边界 | 支付规则 |',
      '| 核心实体 | 订单 |',
      '| 关键门禁 | 支付完成 |',
      '| 常见冲突 | 无 |',
      '| 非目标 | 结算 |',
      '',
      '## 稳定业务规则',
      '',
      '| 场景 | 规则 | 强度 | 来源 |',
      '| --- | --- | --- | --- |',
      ...Array.from({ length: 31 }, (_, i) => `| 场景${i} | 规则${i} | Hard | E-${i} |`),
      '',
    ].join('\n');
    const parsed = domainKnowledge.parseDomainMd(md);
    assert.strictEqual(parsed.buckets.summary.length, 5);
    const budget = domainKnowledge.computeDomainBudgetUsage(parsed);
    assert.ok(budget.overBudget.some((x) => x.key === 'ruleRows'));

    const rendered = domainKnowledge.renderDomainMd(parsed);
    assert.ok(!rendered.includes('## 证据附录'));
    assert.ok(!rendered.includes('## Legacy (pre-migration)'));
  });

  it('merge-global-assets 合并代码规范时同规则累积来源并派生置信度', () => {
    const ws = mkWorkspace();
    const reqId = 'R2';
    writeCalibratedArchitectureLayers(ws, reqId);
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: planAllCompleted(),
      state: { stateVersion: 1, domainMerged: true, knowledgeReviewed: true, archiveAnchorDone: true },
    });
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'standards'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md'),
      [
        '# Code Style & Architecture',
        '',
        '## Layers',
        '',
        '### `ui-page`',
        '- globs:',
        '  - `src/pages/**/*.vue`',
        '- role: 页面层',
        '',
        '## SOPs',
        '',
        '_（暂无全局 SOP）_',
        '',
        '## Rules by Layer',
        '',
        '### `ui-page`',
        '- [api] controller 层禁止直接访问数据库 (layers: ui-page) (applies: src/pages/**/*.vue) (sources: R1) (status: Draft, confidence: 0.3)',
        '',
      ].join('\n'),
      'utf8'
    );
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId, '.temp'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', reqId, '.temp', 'coding-standard-patch.json'),
      JSON.stringify([{ section: 'api', content: 'controller 层禁止直接访问数据库', layers: ['ui-page'] }], null, 2),
      'utf8'
    );

    const r = spawnSync(process.execPath, [MERGE_GLOBAL_ASSETS, ws, reqId], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const styleNow = fs.readFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md'),
      'utf8'
    );
    assert.ok(styleNow.includes('controller 层禁止直接访问数据库'));
    // sources/status/confidence 元数据保留在 patch JSON，markdown 不再渲染
  });

  it('merge-global-assets 不回灌 kind=override 的代码规范条目（仅本需求生效）', () => {
    const ws = mkWorkspace();
    const reqId = 'R-OV';
    writeCalibratedArchitectureLayers(ws, reqId);
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: planAllCompleted(),
      state: { stateVersion: 1, domainMerged: true, knowledgeReviewed: true, archiveAnchorDone: true },
    });
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'standards'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md'),
      [
        '# Code Style & Architecture',
        '',
        '## Layers',
        '',
        '### `ui-page`',
        '- globs:',
        '  - `src/pages/**/*.vue`',
        '- role: 页面层',
        '',
        '## SOPs',
        '',
        '_（暂无全局 SOP）_',
        '',
        '## Rules by Layer',
        '',
        '### `ui-page`',
        '- [logging] 接入新 SDK 必须输出 traceId (layers: ui-page) (applies: src/pages/**/*.vue)',
        '',
      ].join('\n'),
      'utf8'
    );
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId, '.temp'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', reqId, '.temp', 'coding-standard-patch.json'),
      JSON.stringify(
        [
          { section: 'naming', content: '后端枚举使用 SCREAMING_SNAKE_CASE', kind: 'addition', layers: ['ui-page'] },
          { section: 'logging', content: '允许在外部 SDK 未提供链路字段时跳过 traceId 注入', kind: 'override', layers: ['ui-page'], basedOn: '接入新 SDK 必须输出 traceId' },
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
    writeCalibratedArchitectureLayers(ws, reqId);
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: planAllCompleted(),
      state: { stateVersion: 1, domainMerged: true, knowledgeReviewed: true, archiveAnchorDone: true },
    });
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'standards'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'standards', 'architecture-layers.md'),
      [
        '# Architecture Layers',
        '',
        '## Layers',
        '',
        '### `api-layer`',
        '- globs:',
        '  - `src/api/**/*.ts`',
        '  - `src/controllers/**`',
        '  - `src/services/**/*.ts`',
        '- role: 接口与服务边界',
        '',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md'),
      [
        '# Code Style',
        '',
        '> 编码规范与跨层 SOP 的全局事实源。',
        '',
        '## SOPs',
        '',
        '_（暂无全局 SOP）_',
        '',
        '## Rules by Layer',
        '',
        '### `api-layer`',
        '- [api] controller 层禁止直接访问数据库 (layers: api-layer) (applies: src/api/**/*.ts, src/controllers/**)',
        '',
      ].join('\n'),
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
            layers: ['api-layer'],
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
    writeCalibratedArchitectureLayers(ws, reqId);
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'standards'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md'),
      [
        '# Code Style & Architecture',
        '',
        '## Layers',
        '',
        '### `ui-page`',
        '- globs:',
        '  - `src/pages/**/*.vue`',
        '- role: 页面层',
        '',
        '## SOPs',
        '',
        '_（暂无全局 SOP）_',
        '',
        '## Rules by Layer',
        '',
        '### `ui-page`',
        '- [naming] 使用语义化命名 (layers: ui-page) (applies: src/pages/**/*.vue)',
        '',
      ].join('\n'),
      'utf8'
    );
    const planMd = planAllCompleted()
      + '\n\n## Code Style\n\n- [CodeStyle] api: controller 层禁止直接访问数据库 (layers: ui-page)\n'
      + '- [CodeStyle:override] logging: 允许在外部 SDK 未提供链路字段时跳过 traceId 注入 (layers: ui-page) (基于: 接入新 SDK 必须输出 traceId)\n';
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
    assert.ok(md.includes('## Additions'));
    assert.ok(md.includes('controller 层禁止直接访问数据库'));
    assert.ok(md.includes('## Overrides'));
    assert.ok(md.includes('允许在外部 SDK 未提供链路字段时跳过 traceId 注入'));
    // basedOn 元数据保留在 patch JSON，markdown 不再渲染 (基于: ...) 后缀

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

  it('filterCodingPatchesForCodeStyle：拒绝具体业务实体/组件场景伪装成规范', () => {
    const ws = mkWorkspace();
    writeCalibratedArchitectureLayers(ws, 'R1');
    const stylePath = path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md');
    const prevStyle = fs.readFileSync(stylePath, 'utf8');
    fs.writeFileSync(
      stylePath,
      prevStyle.replace(
        '## SOPs',
        [
        '### `domain`',
        '- globs:',
        '  - `packages/*/src/domain/**/*.ts`',
        '- role: domain layer',
        '- should:',
        '  - derive business flags',
        '- should_not:',
        '  - call api',
        '- evidence:',
        '  - `packages/demo/src/domain/Demo.ts`',
        '',
        '## SOPs',
        ].join('\n'),
      ),
      'utf8',
    );

    const out = codeStyle.filterCodingPatchesForCodeStyle(ws, [
      {
        section: 'general',
        content: '列表行是否可审核/可重试/可勾选仅引用 `ShortDramaMaterial` domain getter，禁止在模板或 composition 用裸字符串比较审核/媒体状态',
        kind: 'addition',
        layers: ['domain'],
        applies: ['packages/*/src/domain/**/*.ts', 'packages/*/src/composition/**/*.ts'],
      },
    ]);

    // ShortDramaMaterial 被 looksBusinessNamedIdentifier 识别为业务实体标识符
    // looksFeatureScenarioWording 已移除，通用中文业务词不再机械拦截，
    // 语义质量由 CodeStyle agent 五问门禁保障
    assert.strictEqual(out.accepted.length, 0);
    assert.strictEqual(out.rejected.length, 1);
    assert.ok(out.rejected[0].reasons.includes('implementation-specific or business-scoped wording'));
  });

  it('extractCodingStandardPatchesFromPlan：把 [Hard] 剥离到 strength 字段，content 干净', () => {
    const planContent =
      '- [CodeStyle] api: [Hard] controller 禁止访问 DB (applies: src/api/**)\n'
      + '- [CodeStyle] naming: 使用语义化命名 (layers: ui-page)\n';
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

  it('renderRequirementCodeStyleMarkdown：只输出需求增量，不渲染全局命中规则', () => {
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
    assert.ok(!md.includes('## Matched Rules (from global)'), 'should not render matched global rules');
    assert.ok(!md.includes('[naming] 使用语义化命名'), 'should not copy global rules');
    assert.ok(md.includes('## Additions'), 'should have additions');
    assert.ok(md.includes('- should:'), 'should use structured format');
    assert.ok(
      md.includes('[Hard] 统一导出命名为 useXxx'),
      'Hard 标记应渲染到 content 前',
    );
  });

  it('writeRequirementCodeStyleArtifacts：历史 patch 中的全局规则不会兜底复制进需求 code-style', () => {
    const ws = mkWorkspace();
    const reqId = 'R1';
    writeCalibratedArchitectureLayers(ws, reqId);
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'standards'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md'),
      [
        '# Code Style',
        '',
        '> 编码规范与跨层 SOP 的全局事实源。',
        '',
        '## SOPs',
        '',
        '_（暂无全局 SOP）_',
        '',
        '## Rules by Layer',
        '',
        '### `ui-page`',
        '- [naming] 使用语义化命名 (layers: ui-page) (applies: src/pages/**/*.vue)',
        '',
      ].join('\n'),
      'utf8',
    );
    const reqTempDir = path.join(ws, 'ai-docs', reqId, '.temp');
    fs.mkdirSync(reqTempDir, { recursive: true });
    fs.writeFileSync(
      path.join(reqTempDir, 'coding-standard-patch.json'),
      JSON.stringify([
        {
          section: 'naming',
          content: '使用语义化命名',
          kind: 'addition',
          layers: ['ui-page'],
          applies: ['src/pages/**/*.vue'],
        },
      ], null, 2),
      'utf8',
    );

    const out = codeStyle.writeRequirementCodeStyleArtifacts(ws, reqId, '', { mergePatch: true });
    assert.strictEqual(out.reusedFromGlobalCount, 1);

    const patch = JSON.parse(
      fs.readFileSync(path.join(reqTempDir, 'coding-standard-patch.json'), 'utf8'),
    );
    assert.strictEqual(patch.length, 0);

    const md = fs.readFileSync(path.join(ws, 'ai-docs', reqId, 'code-style.md'), 'utf8');
    assert.ok(!md.includes('[naming] 使用语义化命名'), md);
    assert.ok(md.includes('## Additions'), md);
  });

  it('writeRequirementCodeStyleArtifacts：未知 layer 会在需求 code-style 末尾写入分层漂移提示', () => {
    const ws = mkWorkspace();
    const reqId = 'R-DRIFT';
    writeCalibratedArchitectureLayers(ws, reqId);

    const out = codeStyle.writeRequirementCodeStyleArtifacts(
      ws,
      reqId,
      '- [CodeStyle] adapter: 新增适配器规则 (layers: service-adapter)\n',
    );
    assert.strictEqual(out.generated, true);
    assert.deepStrictEqual(out.unmappedSignals, ['service-adapter']);
    const md = fs.readFileSync(path.join(ws, 'ai-docs', reqId, 'code-style.md'), 'utf8');
    assert.ok(md.includes('<!-- specflow:layers-drift-hint -->'), md);
    assert.ok(md.includes('service-adapter'), md);
    assert.ok(md.includes('recalibrate-layers <ws> R-DRIFT'), md);
  });

  it('writeRequirementCodeStyleArtifacts：Layers 为空时拒绝规范增量并提示校准', () => {
    const ws = mkWorkspace();
    const reqId = 'R-EMPTY-LAYERS';
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId), { recursive: true });
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'standards'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'standards', 'code-style.md'),
      '# Code Style & Architecture\n\n## Layers\n\n_（待 agent 校准填充）_\n\n## SOPs\n\n_（暂无全局 SOP）_\n',
      'utf8'
    );

    const out = codeStyle.writeRequirementCodeStyleArtifacts(
      ws,
      reqId,
      '- [CodeStyle] api: controller 禁止访问 DB (layers: ui-page)\n',
    );
    assert.strictEqual(out.generated, true);
    assert.strictEqual(out.additionsCount, 0);
    assert.ok(out.unmappedSignals.includes('code-style Layers section is empty'));
    const patch = JSON.parse(
      fs.readFileSync(path.join(ws, 'ai-docs', reqId, '.temp', 'coding-standard-patch.json'), 'utf8')
    );
    assert.strictEqual(patch.length, 0);
    const md = fs.readFileSync(path.join(ws, 'ai-docs', reqId, 'code-style.md'), 'utf8');
    assert.ok(!md.includes('controller 禁止访问 DB'), md);
    assert.ok(md.includes('code-style Layers section is empty'), md);
  });

  it('code-style layers 元数据：提取、解析、合并、渲染时保留 architecture layer', () => {
    const planContent =
      '- [CodeStyle] api: [Hard] controller 禁止访问 DB (layers: controller, service) (applies: src/api/**)\n'
      + '- [CodeStyle] api: controller 禁止访问 DB (layers: usecase)\n';
    const patches = codeStyle.extractCodingStandardPatchesFromPlan(planContent);
    assert.strictEqual(patches.length, 2);
    assert.deepStrictEqual(patches[0].layers, ['controller', 'service']);

    const merged = codeStyle.mergeCodingPatches([], patches);
    assert.strictEqual(merged.length, 1);
    assert.deepStrictEqual(merged[0].layers.sort(), ['controller', 'service', 'usecase']);

    const line = codeStyle.renderStructuredRuleLine(merged[0]);
    assert.ok(line.includes(merged[0].content));
    // layers 信息由 renderStructuredRulesByLayer 通过 ### layer-id 分组承载，不在单行中
    const md = codeStyle.renderStructuredRulesByLayer([merged[0]]);
    assert.ok(md.includes('### `controller`'), 'should group by layer');
    assert.ok(md.includes(merged[0].content));

    const parsed = codeStyle.parseGlobalCodeStyleRules(`## Rules by Layer\n\n${md}`);
    assert.ok(parsed.length >= 1);
    const parsedLayers = new Set(parsed.flatMap((r) => r.layers || []));
    assert.ok(parsedLayers.has('controller') || parsedLayers.has('service') || parsedLayers.has('usecase'));
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
      path.join(ws, 'ai-docs', 'global-assets', 'domains', 'services__order__payment.md'),
      renderDomain('payment', 'Verified', '- 已验证规则：支付状态同步'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(ws, 'ai-docs', 'global-assets', 'domains', 'promotion.md'),
      renderDomain('promotion', 'Draft', '- 草案规则：促销叠加上限'),
      'utf8',
    );
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId), { recursive: true });

    const hintText = [
      '## Active Group',
      '支付 payment 场景与促销 promotion 场景同时受影响。',
      '- [ ] **T-A1** | **Modify**: `src/api/payment.ts`',
    ].join('\n');
    const ctx = engineKnowledge.buildKnowledgeContext(ws, reqId, hintText);

    assert.ok(ctx.includes('【已验证规则 · Verified】'), '应含 Verified banner');
    assert.ok(ctx.includes('【草案'), '应含 Draft banner');

    const idxVerified = ctx.indexOf('### services__order__payment.md');
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
    write('services__order__payment', 'Verified', 3);
    fs.mkdirSync(path.join(ws, 'ai-docs', reqId), { recursive: true });

    const hintText = '支付 payment 与促销 promotion 场景全量命中。';
    const ctx = engineKnowledge.buildKnowledgeContext(ws, reqId, hintText);

    const verifiedIdx = ctx.indexOf('### services__order__payment.md');
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
        '- [composition] [Hard] 统一导出命名 useXxx (applies: packages/*/src/composition/**/*.ts) (sources: R1) (status: Draft, confidence: 0.3)',
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

    const { globalRules } = codeStyle.readGlobalCodeStyleRules(ws);
    const paths = codeStyle.extractTaskFilePaths(focusPlan);
    const hits = codeStyle.matchRulesForPaths(globalRules, paths);
    const sections = hits.map((r) => r.section).sort();
    // 应命中 composition（glob 匹配）+ naming（全局无 applies），不含 dto
    assert.deepStrictEqual(sections, ['composition', 'naming']);
    const ctx = engineKnowledge.buildKnowledgeContext(ws, reqId, focusPlan);
    assert.ok(ctx.includes('Code Style Context'), ctx);
    assert.ok(ctx.includes('统一导出命名 useXxx'), ctx);
    assert.ok(ctx.includes('使用语义化命名'), ctx);
  });

  it('buildKnowledgeContext：localPatches 按 category 分组；ui 被丢弃；已在全局的规则跨源去重', () => {
    const ws = mkWorkspace();
    const reqId = 'R-CTX';
    writeWorkspace(ws, reqId, {
      specify: specifyComplete(),
      plan: planWithRoadmap('- [ ] **T-A1** | implement | F-01 |'),
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });
    fs.mkdirSync(path.join(ws, 'ai-docs', 'global-assets', 'domains'), { recursive: true });
    const domainKnowledge = require(
      path.join(__dirname, '..', 'tools', 'domain-knowledge.cjs')
    );
    const merged = domainKnowledge.mergePatchesIntoDomainMd(
      '# payment\n\n',
      'payment',
      [{ domain: 'services/order::payment', category: 'rule', scope: '既存', content: '已入全局的规则' }],
      { requirementId: 'PAST' },
    );
    fs.writeFileSync(path.join(ws, 'ai-docs', 'global-assets', 'domains', 'services__order__payment.md'), merged.md, 'utf8');

    fs.mkdirSync(path.join(ws, 'ai-docs', reqId, '.temp'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'ai-docs', reqId, '.temp', 'knowledge-patch.json'),
      JSON.stringify(
        [
          { domain: 'services/order::payment', category: 'rule', scope: '既存', content: '已入全局的规则' },
          { domain: 'services/order::payment', category: 'rule', scope: '新增', content: '本期新增规则', strength: 'hard' },
          { domain: 'services/order::payment', category: 'ui', content: '本期 UI 约定：按钮靠右' },
          { domain: 'services/order::payment', category: 'entity', term: 'payStatus', content: '付费状态' },
        ],
        null,
        2,
      ),
      'utf8',
    );

    const ctx = engineKnowledge.buildKnowledgeContext(ws, reqId, '## Active Group\n- [ ] **T-A1** payment');
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
      plan: planWithRoadmap('- [ ] **T-A1** | implement | F-01 |'),
      state: { stateVersion: 1, activeGroup: 'Group A' },
    });
    const bizDir = path.join(ws, 'ai-docs', reqId, 'business-domains');
    fs.mkdirSync(bizDir, { recursive: true });
    fs.writeFileSync(
      path.join(bizDir, 'services__order__payment.md'),
      '# payment\n\n## 本期权威业务规则\n- 规则X：本期新定义的权威业务事实（Explorer 产出）\n',
      'utf8',
    );

    const ctx = engineKnowledge.buildKnowledgeContext(ws, reqId, 'payment');
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
        { domain: 'services/order::payment', category: 'entity', term: 'Order', content: '订单主实体', enum: ['A', 'B'] },
        { domain: 'services/order::payment', category: 'rule', scope: '上线判定', content: '需审核通过', strength: 'hard' },
        { domain: 'services/order::payment', category: 'stateMachine', from: '审核中', condition: '*', to: '禁编辑', content: 'sm' },
        { domain: 'services/order::payment', category: 'techDebt', id: 'TD-9', content: '枚举需扩展', owner: 'alice' },
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
      plan: planAllCompleted(),
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

    const ctx = engineKnowledge.buildKnowledgeContext(ws, reqId, hintText);
    assert.ok(ctx.includes('## Code Style Context'));
    assert.ok(ctx.includes('composition') && ctx.includes('useXxx'), '应命中 composition 规则');
    assert.ok(ctx.includes('dto') && ctx.includes('禁止引用 services'), '应命中 dto 规则');
  });
});
