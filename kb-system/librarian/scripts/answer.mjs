// 知识库问答（Agent B 提供，A 会 import，签名不得更改）。
// 契约签名：
//   answerQuestion(kb, llm, question) → Promise<string>
//   extractAuthor(text) → string|undefined
//   stripHeader(text) → string
// 原则：只用证据回答、每条引用标 [#短ID]、无 LLM 时降级为证据列表、永不抛异常。

/** 记录头部的元信息标记，例如【作者:xxx】【来源:企微】。 */
const HEADER_RE = /^(?:【[^】]*】\s*)+/;

/**
 * 从文本头部【作者:xxx】解析作者。
 * @param {string} text 记录原文
 * @returns {string|undefined} 作者标识；解析不到返回 undefined
 */
export function extractAuthor(text) {
  const m = String(text ?? '').match(/^【作者[:：]([^】]+)】/);
  return m ? m[1].trim() : undefined;
}

/**
 * 去掉文本头部连续的【...】元信息标记，返回正文。
 * @param {string} text 记录原文
 * @returns {string} 去掉头部后的正文
 */
export function stripHeader(text) {
  return String(text ?? '').replace(HEADER_RE, '').trim();
}

/** 记录 id 前 8 位作为短编号，引用与回执统一用它。 */
function shortId(id) {
  return String(id ?? '').slice(0, 8);
}

/** occurred_at 可能是 ISO 字符串或毫秒时间戳，统一转成 YYYY-MM-DD HH:mm。 */
function formatTime(t) {
  if (t == null) return '时间未知';
  const d = new Date(typeof t === 'number' ? t : t);
  if (Number.isNaN(d.getTime())) return String(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** search 返回形态兼容：可能是数组，也可能是 {records: [...]} 等包装。 */
function normalizeHits(res) {
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res.records)) return res.records;
  if (res && Array.isArray(res.results)) return res.results;
  if (res && Array.isArray(res.data)) return res.data;
  return [];
}

/** 北京时间的"今天"，格式 YYYY-MM-DD（服务器时区无关，固定 +8）。 */
function todayBeijing() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 把口语问题里的相对日期（今天/昨天/前天/上周…）换算成北京时间的时间范围。
 * 返回 [[startDate, endDate), ...]；没提到相对日期返回空数组。
 */
function dateRangesFromQuestion(q) {
  const dayMs = 24 * 3600 * 1000;
  const bjNow = new Date(Date.now() + 8 * 3600 * 1000); // 北京时间伪装成 UTC
  // 北京今天 00:00 对应的真实时刻（UTC 毫秒）
  const todayStart = Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate()) - 8 * 3600 * 1000;
  const ranges = [];
  const addDay = (n) => ranges.push([new Date(todayStart + n * dayMs), new Date(todayStart + (n + 1) * dayMs)]);

  if (/大前天/.test(q)) addDay(-3);
  if (/前天/.test(q) && !/大前天/.test(q)) addDay(-2);
  if (/昨天|昨日/.test(q)) addDay(-1);
  if (/今天|今日|今早|今晚/.test(q)) addDay(0);
  if (/明天|明日/.test(q)) addDay(1);

  const dow = (bjNow.getUTCDay() + 6) % 7; // 周一 = 0
  const thisMonday = todayStart - dow * dayMs;
  if (/上周|上礼拜|上星期/.test(q)) {
    ranges.push([new Date(thisMonday - 7 * dayMs), new Date(thisMonday)]);
  }
  if (/这周|本周|这礼拜|本礼拜|这星期|本星期/.test(q)) {
    ranges.push([new Date(thisMonday), new Date(todayStart + dayMs)]);
  }
  return ranges;
}

/** 按时间范围直接从全量记录里筛（相对日期问题的可靠兜底，不依赖全文检索）。 */
async function recordsInRanges(kb, ranges) {
  if (!ranges.length) return [];
  try {
    const list = normalizeHits(await kb.records());
    return list.filter((r) => {
      const t = new Date(r.occurred_at ?? r.recorded_at ?? 0).getTime();
      return t && ranges.some(([s, e]) => t >= s.getTime() && t < e.getTime());
    });
  } catch {
    return [];
  }
}

/** 收集知识库里出现过的作者 ID，给人名改写当对照表用。 */
async function collectAuthorHints(kb) {
  try {
    const list = normalizeHits(await kb.records());
    const authors = new Set();
    for (const r of list) {
      const a = extractAuthor(r?.text ?? '');
      if (a) authors.add(a);
    }
    return [...authors].slice(0, 50).join('、');
  } catch {
    return '';
  }
}

/** 提问改写提示词：把口语问题改写成检索友好的一行关键词。 */
const REWRITE_PROMPT = [
  '你是检索助手。把口语化的问题改写成用于全文检索的一行关键词。',
  '规则：',
  '1. 去掉"做了什么""怎么样了""呢""吗"这类不携带信息的虚词，保留实体词（人名、项目名、事项）；',
  '2. 如果问题里出现中文人名，而作者对照表里有疑似对应的拼音/英文 ID，把那个 ID 也写进关键词；',
  '3. 如果问题里有"昨天""上周"等相对日期，原样保留日期词即可，不用换算；',
  '4. 只输出一行空格分隔的关键词，不要输出任何解释。',
].join('\n');

/** 用 LLM 把口语问题改写成检索关键词；失败返回 null（降级为只用原问题搜）。 */
async function rewriteQuery(llm, kb, question) {
  if (!llm?.configured) return null;
  const authors = await collectAuthorHints(kb);
  const content = await llm.chat([
    {role: 'system', content: REWRITE_PROMPT},
    {role: 'user', content: `作者对照表：${authors || '（暂无）'}\n问题：${question}`},
  ], {maxTokens: 80});
  const kw = (content ?? '').trim().replace(/\s*\n+\s*/g, ' ');
  return kw && kw !== question ? kw : null;
}

/** 取一条记录的作者：优先【作者:xxx】头部，其次记录对象上的 author 字段。 */
function authorOf(rec) {
  return extractAuthor(rec?.text) ?? rec?.author ?? '未知作者';
}

/** 把证据列表格式化成 LLM 可用的编号清单。 */
function formatEvidence(hits) {
  return hits.map((r, i) => {
    const body = stripHeader(r.text);
    return `[#${shortId(r.id)}]（${formatTime(r.occurred_at)}，${authorOf(r)}）${body}`;
  }).join('\n');
}

/** 系统提示词：像一个了解情况的同事助理一样回答——自然、直接，不摆证据、不提编号。 */
const SYSTEM_PROMPT = [
  '你是团队的知识助理。同事们把工作进展、决定、问题随手发给你，你基于这些记录回答提问。',
  '',
  '回答风格：',
  '1. 像一个熟悉情况的同事一样，直接回答问题，先给结论，再按需要补充细节；',
  '2. 用自然、口语化的中文，像平时聊天说话，不要书面腔，不要机械分点；',
  '3. 绝对不要出现记录编号、引用标记、"证据"、"记录显示"这类字眼——提问的人不关心这些，就像你问助理"某人今天干了啥"，他只会直接告诉你干了啥；',
  '4. 涉及具体事情时，自然地说清楚是谁、什么时候做的，比如"李任重周二下午说……"；',
  '5. 记录之间互相矛盾时，用大白话指出来，比如"他上午说做完了，下午又说要改，最好找他确认一下"；',
  '6. 记录里没有的信息，直接说"我这边还没收到这方面的记录"，并顺口邀请对方把情况发给你；',
  '7. 不要复述问题，不要自我介绍，不要解释你是怎么知道的。',
  '',
  '铁律：只能依据给出的记录回答，严禁编造记录里没有的内容。500 字以内。',
].join('\n');

/**
 * 检索并回答提问；任何路径都不抛异常。
 * @param {object} kb KnowledgeBase 实例（契约：collector/src/kb.mjs）
 * @param {object} llm LLM 实例（契约：collector/src/llm.mjs）
 * @param {string} question 用户问题
 * @returns {Promise<string>} 给用户的回答文本
 */
export async function answerQuestion(kb, llm, question) {
  try {
    const q = String(question ?? '').trim();
    if (!q) return '你想问什么？可以直接发"问：xxx"，或一句话以问号结尾。';

    // 1. 检索证据：原问题搜一次；问题里有相对日期时按日期范围直接取；
    //    再用 LLM 改写出的关键词补搜一次（处理中文名→作者ID 这类别名），三路合并去重。
    const hits = [];
    const seen = new Set();
    const pushHits = (list) => {
      for (const r of list) {
        const key = String(r?.id ?? r?.text ?? Math.random());
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push(r);
      }
    };

    let searchOk = false;
    try {
      pushHits(normalizeHits(await kb.search(q, {limit: 10})));
      searchOk = true;
    } catch { /* 继续尝试其他路径 */ }

    const ranges = dateRangesFromQuestion(q);
    if (ranges.length) {
      pushHits(await recordsInRanges(kb, ranges));
      searchOk = true;
    }

    const rewritten = await rewriteQuery(llm, kb, q);
    if (rewritten) {
      try {
        pushHits(normalizeHits(await kb.search(rewritten, {limit: 10})));
      } catch { /* 改写搜索失败不影响主路径 */ }
    }

    if (!searchOk && hits.length === 0) {
      return '知识库检索暂时不可用，请稍后再试；如果是新信息，也可以直接发给我先收录。';
    }

    // 2. 无证据：友好提示并引导投喂
    if (hits.length === 0) {
      return '知识库暂时没有相关记录。如果你正好了解这件事，可以把信息直接发给我，我会收录进知识库。';
    }

    // 3. 有证据且有 LLM：组织自然口吻的答案（告诉它今天日期，方便理解"昨天""上周"）
    if (llm?.configured) {
      const evidence = formatEvidence(hits.slice(0, 15));
      const content = await llm.chat([
        {role: 'system', content: SYSTEM_PROMPT},
        {role: 'user', content: `（今天是 ${todayBeijing()}，北京时间）\n\n问题：${q}\n\n知识库相关记录：\n${evidence}`},
      ], {maxTokens: 1200});
      if (content && content.trim()) return content.trim();
      // LLM 调用失败（返回 null）：落入下面的降级分支
    }

    // 4. 降级：列出前 5 条证据原文
    const lines = hits.slice(0, 5).map((r) => {
      const body = stripHeader(r.text);
      const oneLine = body.length > 200 ? body.slice(0, 200) + '…' : body;
      return `• [#${shortId(r.id)}] ${formatTime(r.occurred_at)} ${authorOf(r)}：${oneLine}`;
    });
    return [
      '找到以下相关记录：',
      '',
      ...lines,
      '',
      '（配置 KB_LLM_BASE_URL / KB_LLM_API_KEY / KB_LLM_MODEL 后，我会基于以上记录给出整理好的答案。）',
    ].join('\n');
  } catch (err) {
    // 兜底：绝不抛异常
    return '回答时出了点问题（' + (err?.message ?? '未知错误') + '），请稍后重试。';
  }
}
