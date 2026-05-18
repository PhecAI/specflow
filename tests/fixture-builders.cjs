/**
 * 测试用最小 Markdown / 状态构造（与 plan-parser / specflow-engine 约定一致）。
 */

const fs = require('fs');
const path = require('path');

/** 完整 specify.md（可进 Plan：含 acceptanceCriteria 实质内容、无未闭合 CQ） */
function specifyComplete(extraInBody = '') {
  return `# Test Requirement

## Executive Summary
<!-- specflow:section=executive-summary -->
Summary content.

## User Scenarios
<!-- specflow:section=user-scenarios -->
User roles.

## Business Rules
<!-- specflow:section=business-rules -->
Rules.

## Acceptance Criteria
<!-- specflow:section=acceptance-criteria -->
- AC-1: Done.

## Clarification Log
<!-- specflow:section=clarification-log -->
${extraInBody}

## Changelog
<!-- specflow:section=changelog -->
- Initial
`;
}

/** 含 [BLOCKER] 且规格未完成（无 AC）→ 阶段 Specify，走 Specify 分支 block */
function specifyDraftWithBlocker() {
  return `# Draft

## Executive Summary
<!-- specflow:section=executive-summary -->
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
 * 草稿级 specify（无 Acceptance Criteria 实质 → specifyComplete=false，阶段仍为 Specify）
 * → determineAction 默认派发 specflow-specify
 */
function specifyDraftMinimal() {
  return `# Draft

## Executive Summary
<!-- specflow:section=executive-summary -->
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
 * CQ-Domain-Init：澄清已闭合、仍缺 AC → 阶段 Specify；
 * 领域文件缺失 → dispatch domain-explorer（非 Merge）
 * 标题需含：缺少 [DomainName] 业务知识库（兼容旧文「领域知识库」）
 */
function specifyIncompleteDomainCQClosed(domainName = 'Payment') {
  return `# Draft Domain

## Executive Summary
<!-- specflow:section=executive-summary -->
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
### 📦 Group A: First
${taskLine}
${extraGroups}

## Execution Log
<!-- specflow:section=execution-log -->
Log.

## Changelog
<!-- specflow:section=changelog -->
- Initial
`;
}

/** 全部 [x] 且无其它未完成任务 → 可进 Archive */
function planAllCompleted() {
  return planWithRoadmap('- [x] Done | F-01 |');
}

/** 在 plan 中插入 decision-summary（供 confirm_start_group 摘要） */
function appendPlanDecisionSummary(planMd, summary = 'Plan decision summary') {
  if (planMd.includes('specflow:decision-summary')) return planMd;
  return planMd.replace(/\n## Changelog\n/, `\n\n<!-- specflow:decision-summary -->\n${summary}\n<!-- /specflow:decision-summary -->\n\n## Changelog\n`);
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
  const d = path.join(workspaceRoot, 'ai-docs', requirementId, 'business-domains');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${name}.md`), body, 'utf8');
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
  appendPlanDecisionSummary,
  planWithBlockedTag,
  planWithBlocker,
  planEmptyGroup,
  writeWorkspace,
  writeHistoryRequirement,
  writeRequirementDir,
  writeBusinessDomain,
};

