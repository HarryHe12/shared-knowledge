import { terms } from './store.mjs';

export function queryFingerprint(query) {
  return [...new Set(terms(query))].sort().join('|');
}

// Project names come only from the caller's permitted catalog; no other project's records are read.
export function explicitOtherScope(projects, active, question, turns = []) {
  const text = [question, ...turns.map(t => t.answer)].join(' ');
  const names = projects.filter(p => p.id !== active.id).filter(p =>
    text.includes(p.name.endsWith('项目') ? p.name : p.name + '项目'));
  const currentNamed = text.includes(active.name);
  return currentNamed ? [] : names.map(p => p.name);
}

export function unboundedAbsence(answer) {
  return answer.split(/[。！？\n]/u).filter(clause =>
    !/(本轮|本次检索|当前检索|所给证据|提供的证据|现有证据|检索到的证据)/u.test(clause) &&
    /(无记录|没有[^，；]{0,45}记录|未记录(?:$|[，；])|库[内中][^，；]{0,45}(没有|缺少|未提供|不存在|未记录)|没有任何[^，；]{0,30}(资料|信息|证据))/u.test(clause));
}

const codes = text => [...new Set(text.match(/\b[A-Z]+(?:-?\d+)[A-Z0-9-]*\b/g) ?? [])];
const containsCode = (text, code) => new RegExp(`(?<![A-Za-z0-9-])${code.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?![A-Za-z0-9-])`).test(text);

// A deterministic alternate search: preserve rare lexical/entity anchors and traverse explicit reference codes.
// This never consults another project, and does not infer that referenced records are semantically equivalent.
export function anchoredLookup(store, user, project, query, { depth = 1, limit = 12 } = {}) {
  const records = store.records(user, project);
  const exactCodes = codes(query);
  const hanSpans = query.match(/[\p{Script=Han}]+/gu) ?? [];
  const hanGrams = hanSpans.flatMap(span => {
    const chars = [...span], grams = chars.slice(1).map((_, i) => chars.slice(i, i + 2).join(''));
    return chars.length <= 12 ? [span, ...grams] : grams;
  });
  const tokens = [...new Set([...terms(query), ...hanGrams])].filter(t => [...t].length >= 2 && !/^\d+$/.test(t));
  const rare = tokens.map(token => ({ token, count: records.filter(r => r.text.toLowerCase().includes(token)).length }))
    .filter(t => t.count > 0 && t.count <= Math.max(2, Math.ceil(records.length * 0.08)))
    .sort((a,b) => a.count - b.count || b.token.length - a.token.length).slice(0, 3);
  const anchors = exactCodes.length ? exactCodes : rare.map(t => t.token);
  if (!anchors.length) return { hits: [], anchors: [], strategy: 'exact_reference', depth };
  const ranked = records.map(r => ({ record: r, score: anchors.reduce((score, a) => score +
    (exactCodes.length ? containsCode(r.text, a) : r.text.toLowerCase().includes(a)) *
      (exactCodes.length ? 100 : 1 / rare.find(t => t.token === a).count), 0) }))
    .filter(r => r.score > 0).sort((a,b) => b.score - a.score || a.record.id.localeCompare(b.record.id));
  const hits = ranked.slice(0, 4).map(r => r.record), seen = new Set(hits.map(r => r.id));
  let frontier = [...hits];
  for (let hop = 0; hop < depth && hits.length < limit; hop++) {
    const references = codes(frontier.map(r => r.text).join(' '));
    const next = records.filter(r => !seen.has(r.id) && references.some(code => containsCode(r.text, code)))
      .slice(0, limit - hits.length);
    for (const r of next) { seen.add(r.id); hits.push(r); }
    frontier = next;
  }
  return { hits, anchors, strategy: 'exact_reference', depth };
}

// High-confidence, first-turn user-owned variables. Ordinary summaries and recorded project criteria do not trigger this.
export function missingUserConstraint(question, turns = []) {
  if (turns.length) return null;
  if (/我.{0,12}(之前|定过|设定|定的).{0,8}(标准|口径)/u.test(question) &&
      !/(标准|口径)[^。；？]{0,20}(是|为|即|：|:|就算)/u.test(question)) {
    return { slot: 'personal_criterion', question: '你所指的判断标准具体是什么？', reason: '你明确引用了个人标准，但本次上下文尚未定义，不能直接用项目验收门槛替代。' };
  }
  if (/我.{0,10}(关心|之前|指定|说过).{0,8}(周期|时间范围|时间段)/u.test(question) &&
      !/(今天|本周|上周|本月|上月|最近.{0,4}[天周月]|20\d{2}[-年/])/u.test(question)) {
    return { slot: 'personal_period', question: '你所指的时间范围是从哪天到哪天？', reason: '你要求使用特定周期，但尚未给出该周期，不能擅自用全部记录的日期替代。' };
  }
  if (/我.{0,8}(打算|计划|准备|愿意).{0,8}(投|花)[^。；？]{0,8}(钱|金额|预算)/u.test(question) &&
      !/我.{0,8}(打算|计划|准备|愿意).{0,8}(投|花)[^，。；？]{0,6}\d+(\.\d+)?\s*(万|元|块)/u.test(question)) {
    return { slot: 'personal_amount', question: '你计划投入的金额是多少？', reason: '个人计划投入的金额尚未给出，不能用已批准预算或草案金额代替。' };
  }
  return null;
}
