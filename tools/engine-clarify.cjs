const { normalizeDomainInitRef } = require('./specflow-state.cjs');
const { safeReadJson } = require('./engine-io.cjs');

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
  const closedAnswers = [];
  for (let idx = 0; idx < entries.length; idx++) {
    const item = entries[idx] || {};
    const status = String(item.status || item.state || '').toLowerCase();
    const id = String(item.id || item.cqId || `${item.type || 'clarification'}_${idx + 1}`);
    const hasAnswer =
      item.answer != null ||
      item.userAnswer != null ||
      item.resolution != null ||
      item.decision != null;
    if (['closed', 'resolved', 'done'].includes(status) || hasAnswer) {
      const answer = item.answer ?? item.userAnswer ?? item.resolution ?? item.decision;
      closedAnswers.push({
        id,
        type: item.type || 'clarification',
        title: item.title || item.prompt || item.question || item.decisionPrompt || item.confirmationPrompt || '',
        answer,
        impact: item.impact || item.whyCritical || '',
        recommendation: item.recommendation || '',
        domainRef: item.domainRef || item.domain || item.targetDomain || item.slug || '',
        source: item.source || '',
        sourceKind: 'temp',
      });
      continue;
    }

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
    closedAnswers,
    totalCount: entries.length,
    sourcePath: filePath,
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
  const closedAnswers = [
    ...(Array.isArray(a.closedAnswers) ? a.closedAnswers : []),
    ...(Array.isArray(b.closedAnswers) ? b.closedAnswers : []),
  ];
  return {
    open: Boolean(a.open || b.open),
    openCount: Number(a.openCount || 0) + Number(b.openCount || 0),
    questions,
    questionsAll,
    closedAnswers,
  };
}

function formatClosedClarificationAnswers(answers) {
  const list = Array.isArray(answers) ? answers.filter((a) => a && a.answer != null) : [];
  if (list.length === 0) return '';
  const lines = ['【已闭合澄清答案】', '生成正式 specify.md 时必须只依据以下 answer 字段沉淀到正文与 Decision Log，不得从对话历史猜测答案：'];
  for (const item of list) {
    const title = String(item.title || item.id || '').replace(/\s+/g, ' ').trim();
    const answer = String(item.answer || '').replace(/\s+/g, ' ').trim();
    const impact = String(item.impact || '').replace(/\s+/g, ' ').trim();
    const recommendation = String(item.recommendation || '').replace(/\s+/g, ' ').trim();
    const parts = [`- ${item.id}`];
    if (title) parts.push(`问题：${title}`);
    parts.push(`答案：${answer}`);
    if (impact) parts.push(`影响：${impact}`);
    if (recommendation) parts.push(`原建议：${recommendation}`);
    lines.push(parts.join('；'));
  }
  return lines.join('\n');
}

function appendClosedClarificationContext(context, gates) {
  const summary = formatClosedClarificationAnswers(gates && gates.closedClarificationAnswers);
  if (!summary) return context;
  return `${context || ''}\n\n${summary}`.trim();
}

function isDomainInitScanAnswer(answer) {
  const text = String(answer || '').trim().toLowerCase();
  if (!text) return false;
  return (
    text === 'a' ||
    text === 'yes' ||
    text.includes('option a') ||
    text.includes('option_a') ||
    text.includes('scan') ||
    text.includes('需要') ||
    text.includes('先扫') ||
    text.includes('扫代码') ||
    text.includes('生成业务知识库')
  );
}

function extractDomainInitRefsFromAnswer(item) {
  const candidates = [];
  const add = (value) => {
    const s = String(value || '').trim();
    if (s) candidates.push(s);
  };
  if (item && typeof item === 'object') {
    add(item.domainRef);
    add(item.domain);
    add(item.targetDomain);
    add(item.source);
    add(item.title);
    add(item.prompt);
    add(item.answer);
  }
  const refs = [];
  for (const text of candidates) {
    const bracketMatches = String(text).matchAll(/\[([^\]]+)\]/g);
    for (const m of bracketMatches) {
      const normalized = normalizeDomainInitRef(m[1]);
      if (normalized) refs.push(normalized);
      else if (m[1]) refs.push(String(m[1]).trim());
    }
    const explicitMatches = String(text).matchAll(/([a-z0-9_.\/-]+::[a-z0-9_.-]+)/gi);
    for (const m of explicitMatches) {
      const normalized = normalizeDomainInitRef(m[1]);
      if (normalized) refs.push(normalized);
    }
  }
  return Array.from(new Set(refs.filter(Boolean)));
}

module.exports = {
  appendClosedClarificationContext,
  detectTechnicalClarificationDebt,
  extractClarificationLogText,
  extractDomainInitRefsFromAnswer,
  formatClosedClarificationAnswers,
  isDomainInitScanAnswer,
  mergeClarificationStates,
  normalizeClarificationEntries,
  parseTempClarifications,
};
