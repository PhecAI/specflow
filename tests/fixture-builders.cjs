/**
 * 测试用最小 Markdown / 状态构造（与 plan-parser / specflow-engine 约定一致）。
 */

const fs = require('fs');
const path = require('path');

/** 完整 specify.md（可进 Plan：含 capabilities/验收要点实质内容、无未闭合 CQ） */
function specifyComplete(extraInBody = '') {
  return `# Test Requirement

## Requirement Overview
<!-- specflow:section=overview -->
- **业务背景**: Summary content.
- **目标**: Test goal.
- **本期范围**: Test scope.
- **非目标**: None.
- **本仓职责边界**: Test workspace.

## Product Decisions & Boundaries
<!-- specflow:section=product-decisions -->
- **已确认产品决策**: Test decision.

## Capabilities
<!-- specflow:section=capabilities -->
### 3.1 Test capability
- **用户目标**: Complete test.
- **入口 / 触发条件**: Test entry.
- **主流程**:
  1. Do it.
- **业务规则**:
  - Rules.
- **异常与边界**:
  - None.
- **权限要求**:
  - Default.
- **验收要点**:
  - **[AC-001]** Done.

## Business Objects & States
<!-- specflow:section=business-objects -->
- **Object**: Test object.
- **状态定义**:
  - Ready: ready.

## Decision Log
<!-- specflow:section=clarification-log -->
${extraInBody}

## Changelog
<!-- specflow:section=changelog -->
- Initial
`;
}

/** 含 [BLOCKER] 且规格未完成（无能力切片）→ 阶段 Specify，走 Specify 分支 block */
function specifyDraftWithBlocker() {
  return `# Draft

## Requirement Overview
<!-- specflow:section=overview -->
Text [BLOCKER] in draft.

## Changelog
<!-- specflow:section=changelog -->
- Initial
`;
}

/** 规格已完整但正文含 [BLOCKER]（gate 计数）→ 可进入 Plan 门禁 block */
function specifyCompleteWithBlockerGate() {
  const base = specifyComplete();
  return base.replace('Summary content.', 'Summary [BLOCKER] must fix.');
}

/** 未闭合澄清（Option + 无 User 回复） */
function specifyWithOpenClarification() {
  return specifyComplete(`
### [?] CQ-01: Test question
> **背景**: Need input

- **Option A**: Yes
- **Option B**: No

#### **[User]**:
`);
}

/**
 * 草稿级 specify（无 Capabilities 实质 → specifyComplete=false，阶段仍为 Specify）
 * → determineAction 默认派发 specflow-specify
 */
function specifyDraftMinimal() {
  return `# Draft

## Requirement Overview
<!-- specflow:section=overview -->
Draft only.

## Clarification Log
<!-- specflow:section=clarification-log -->
(none)

## Changelog
<!-- specflow:section=changelog -->
- Initial
`;
}

/**
 * CQ-Domain-Init：澄清已闭合、仍缺 Capabilities → 阶段 Specify；
 * 领域文件缺失 → dispatch domain-explorer（非 Merge）
 * 标题需含：缺少 [DomainName] 业务知识库（兼容旧文「领域知识库」）
 */
function specifyIncompleteDomainCQClosed(domainName = 'Payment') {
  return `# Draft Domain

## Requirement Overview
<!-- specflow:section=overview -->
X.

## Clarification Log
<!-- specflow:section=clarification-log -->
### [?] CQ-Domain-Init: 缺少 [${domainName}] 业务知识库
> **背景**: Domain

- **Option A**: Scan
- **Option B**: Skip

#### **[User]**:
**[User]**: option a

## Changelog
<!-- specflow:section=changelog -->
- Initial
`;
}

/**
 * plan.md：Roadmap 下 Group A，任务状态可配。
 * F-01 出现在 Group 文本中以供 focus 构建。
 */
function planWithRoadmap(taskLine = '- [ ] Task | F-01 |', extraGroups = '') {
  const roadmapBody = addDefaultTaskGroupContext(`### 📦 Group A: First
${taskLine}
${extraGroups}`)
  return `# Plan

## Architecture
<!-- specflow:section=architecture -->
Arch.

## Contract
<!-- specflow:section=contract -->
Contract.

## Feature Design
<!-- specflow:section=feature -->
### [F-01] Feature One
Design.

## Roadmap
<!-- specflow:section=roadmap -->
${roadmapBody}

## Execution Log
<!-- specflow:section=execution-log -->
Log.

## Changelog
<!-- specflow:section=changelog -->
- Initial
`;
}

function addDefaultTaskGroupContext(roadmapBody) {
  const lines = String(roadmapBody || '').split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    out.push(line)
    if (!/^###\s+(?:📦\s*)?Group\s+\w+/i.test(line.trim())) continue
    let j = i + 1
    while (j < lines.length && !lines[j].trim()) j++
    if (j < lines.length && /^\s*-\s+\*\*Goal\*\*\s*[:：]/i.test(lines[j])) continue
    out.push(
      '- **Goal**: 完成本组交付',
      '- **Depends on**: none',
      '- **User AC**:',
      '  - AC-001 覆盖本组用户可观察验收点',
      '- **Local Contract**:',
      '  - 本组接口、字段、权限与常量保持一致',
      '- **Files**:',
      '  - Modify: `src/example.ts`',
      '- **Test Strategy**:',
      '  - TDD Units: none',
      '  - Unit/Component Checks: targeted local checks',
      '  - Mock Smoke: none',
      '  - Static Diagnostics: changed files evidence',
      '- **Group Verify**: AC mapping + Local Contract + targeted evidence',
    )
  }
  return out.join('\n')
}

/** 全部 [x] 且无其它未完成任务 → 可进 Archive */
function planAllCompleted() {
  return planWithRoadmap('- [x] Done | F-01 |');
}

/** 含 Roadmap [Blocked] → hasBlockedTask */
function planWithBlockedTag() {
  return planWithRoadmap('- [ ] T | F-01 |\n\n[Blocked] waiting');
}

/** 含 plan [BLOCKER] */
function planWithBlocker() {
  const p = planWithRoadmap();
  return p.replace('Arch.', 'Arch [BLOCKER].');
}

/** 空 Group（仅标题无任务）→ roadmap 全 0、completed=0 → Implement 且无 nextPendingGroup */
function planEmptyGroup() {
  return planWithRoadmap('', '');
}

function writeRequirementDir(reqDir, { specify, plan, state, resourceFailed }) {
  fs.mkdirSync(reqDir, { recursive: true });
  if (specify != null) fs.writeFileSync(path.join(reqDir, 'specify.md'), specify, 'utf8');
  const planPath = path.join(reqDir, 'plan.md');
  if (plan != null) fs.writeFileSync(planPath, plan, 'utf8');
  if (state != null) {
    const temp = path.join(reqDir, '.temp');
    fs.mkdirSync(temp, { recursive: true });
    fs.writeFileSync(path.join(temp, 'specflow-state.json'), JSON.stringify(state, null, 2), 'utf8');
    const { passGate } = require('../tools/gates.cjs');
    if (state.archiveAnchorDone === true) {
      passGate(reqDir, 'archive.user_anchor', {
        evidence: 'fixture archive anchor confirmed',
      });
    }
    if (state.domainMerged === true) {
      passGate(reqDir, 'archive.domain_merged', {
        evidence: 'fixture domain knowledge merged',
      });
    }
    if (state.knowledgeReviewed === true) {
      passGate(reqDir, 'archive.knowledge_reviewed', {
        evidence: 'fixture knowledge reviewed',
      });
    }
  }
  if (resourceFailed != null) {
    const temp = path.join(reqDir, '.temp');
    fs.mkdirSync(temp, { recursive: true });
    fs.writeFileSync(
      path.join(temp, 'resource-load-failed.json'),
      JSON.stringify(resourceFailed, null, 2),
      'utf8'
    );
  }
}

function writeWorkspace(workspaceRoot, requirementId, payload) {
  const aiDocs = path.join(workspaceRoot, 'ai-docs');
  const reqDir = path.join(aiDocs, requirementId);
  writeRequirementDir(reqDir, payload);
}

/** 历史归档路径：ai-docs/history/<year>/<quarter>/<id>/ */
function writeHistoryRequirement(workspaceRoot, requirementId, payload, year = '2024', quarter = 'Q1') {
  const reqDir = path.join(workspaceRoot, 'ai-docs', 'history', year, quarter, requirementId);
  writeRequirementDir(reqDir, payload);
}

function writeBusinessDomain(workspaceRoot, requirementId, name, body = '# Domain\n') {
  const { domainRefToFileStem } = require('../tools/specflow-state.cjs');
  const d = path.join(workspaceRoot, 'ai-docs', requirementId, 'business-domains');
  fs.mkdirSync(d, { recursive: true });
  const stem = domainRefToFileStem(name) || name;
  fs.writeFileSync(path.join(d, `${stem}.md`), body, 'utf8');
}

module.exports = {
  specifyComplete,
  specifyDraftMinimal,
  specifyDraftWithBlocker,
  specifyCompleteWithBlockerGate,
  specifyWithOpenClarification,
  specifyIncompleteDomainCQClosed,
  planWithRoadmap,
  planAllCompleted,
  planWithBlockedTag,
  planWithBlocker,
  planEmptyGroup,
  writeWorkspace,
  writeHistoryRequirement,
  writeRequirementDir,
  writeBusinessDomain,
};
