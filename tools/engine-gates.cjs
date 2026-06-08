const {
  getGate,
  gatePassed,
  passGate,
  resetGate,
} = require('./gates.cjs');

function countBlockers(content) {
  const m = content.match(/\[BLOCKER\]/g);
  return m ? m.length : 0;
}

/** 归档前人工确认：由 manage-state set-archive-anchor 写入 archive.user_anchor gate */
function isArchiveAnchorAllowed(registryOrDir) {
  return gatePassed(registryOrDir, 'archive.user_anchor');
}

function detectPhase(
  hasSpecify,
  specifyDocumentReady,
  hasPlan,
  planReadinessComplete,
  planDocumentReady,
  pendingTaskCount,
  readyForQACount,
  failedTaskCount,
  completedTaskCount,
) {
  if (!hasSpecify) return 'Init';
  // specify.md 存在但未完整生成（仅 Draft，缺少功能切片/验收要点）→ 仍停留在 Specify
  if (!specifyDocumentReady) return 'Specify';
  if (!hasPlan && !planReadinessComplete) return 'PlanReadiness';
  if (!hasPlan) return 'Plan';
  if (!planDocumentReady) return 'Plan';
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

function syncArtifactGate(requirementDir, gateRegistry, gateId, ready, snapshot, evidence) {
  const current = getGate(gateRegistry, gateId);
  if (ready) {
    if (!gatePassed(gateRegistry, gateId, { snapshot })) {
      const result = passGate(requirementDir, gateId, { snapshot, evidence });
      if (result && result.ok) gateRegistry.gates[gateId] = result.gate;
    }
    return;
  }
  if (current && current.status === 'passed') {
    const result = resetGate(requirementDir, gateId, {
      reason: 'artifact is not ready',
      snapshot,
      evidence: evidence ? [`not ready: ${evidence}`] : [],
    });
    if (result && result.ok) gateRegistry.gates[gateId] = result.gate;
  }
}

function dispatchArrayItems(suggestedAction) {
  if (!suggestedAction || suggestedAction.type !== 'dispatch_array') return [];
  if (Array.isArray(suggestedAction.items)) return suggestedAction.items;
  if (Array.isArray(suggestedAction.agents)) return suggestedAction.agents;
  return [];
}

function buildSpecifyKnowledgeHint(gates, suggestedAction, specifyContent) {
  const parts = [];
  if (suggestedAction && suggestedAction.context) parts.push(suggestedAction.context);
  const refs = Array.isArray(gates && gates.domainInitRefs) ? gates.domainInitRefs : [];
  if (refs.length > 0) parts.push(`confirmed domains: ${refs.join(', ')}`);
  if (typeof specifyContent === 'string' && specifyContent.trim()) {
    parts.push(specifyContent);
  }
  return parts.filter(Boolean).join('\n\n');
}

module.exports = {
  buildSpecifyKnowledgeHint,
  countBlockers,
  detectPhase,
  dispatchArrayItems,
  isArchiveAnchorAllowed,
  syncArtifactGate,
};
