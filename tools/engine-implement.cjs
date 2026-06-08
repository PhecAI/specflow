const {
  findByKey,
  renderNode,
} = require('./plan-parser.cjs');

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
        '\n\n[FinalQA=true] 本批验收通过后 Roadmap 将全绿。请在"阶段 A QA Lite"的基础上追加一次"阶段 B 收口"：' +
        '仅执行 Final Gate / Verification Contract 中已证明安全的局部收口验证；无法安全本地执行的全量回归写明 CI/manual 承接。' +
        '两段只执行一次，禁止回跑范围不明的项目级或模块级验证。';
      actions.push({
        groupId: id,
        agent: 'specflow-qa',
        context: isFinalQA ? baseContext + finalHint : baseContext,
        finalQa: isFinalQA === true,
        qaMode: 'lite',
        dependsOn,
      });
    }
  }
  actions.sort((a, b) => a.groupId.localeCompare(b.groupId));
  return actions.slice(0, 2);
}

module.exports = {
  analyzeParallelGroupActions,
  parseGroupDependsOn,
};
