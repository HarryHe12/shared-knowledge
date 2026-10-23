// 消息路由器（Agent B 提供，A 会 import，签名不得更改）。
// 把员工在企业微信里发来的纯文本分流成：帮助 / 提问 / 作废指令 / 忽略 / 普通记录。
// 契约签名：route(text) → {kind}，kind ∈ note(带text) | question(带question) | help | retract(带recordId) | ignore

/** 面向员工的中文使用说明，语气友好。 */
export const HELP_TEXT = [
  '👋 我是团队知识库助手，可以这样使用我：',
  '',
  '📥 投喂记录：直接把工作进展、决定、问题发给我，我会原样收进知识库。建议开头注明日期或项目名，之后更好查。',
  '❓ 提问：直接说你想查什么就行（比如"上周谁改了方案"），也可以用「问：xxx」开头或以 ?/？ 结尾，我会查知识库，像同事一样告诉你答案。提问不会被存进知识库。',
  '🗑️ 纠错撤回：发「作废 #记录号」（例如：作废 #a1b2c3d4），我会把那条记录标记撤回。记录号在每条收录回执里。',
  '📖 使用说明：随时发「帮助」或 help 再看一遍这段说明。',
  '',
  '小提示：我收录时会回执一条 #短编号，它就是这条记录的身份证号，纠错、引用都靠它。所有内容原样留存、可溯源，请放心投喂。',
].join('\n');

/** 触发帮助的关键词（忽略大小写、前后空白）。 */
const HELP_WORDS = new Set([
  '帮助', '帮忙', '使用说明', '说明', 'help', 'h', '?', '？',
]);

/** 提问前缀："问：xxx"、"/q xxx"、"请问 xxx"。 */
const QUESTION_PREFIX = /^\s*(?:问\s*[:：]|\/q\s+|请问\s*[:：,，]?)/i;

/** LLM 意图分类提示词：把规则吃不透的口语消息分成 投喂 / 提问 / 闲聊。 */
const CLASSIFY_PROMPT = [
  '你是消息分类器。员工给团队知识库助手发消息，判断这条消息的意图，只回答一个单词：',
  'FEED —— 员工在汇报/分享信息，希望存进知识库（工作进展、决定、通知、想法、"记一下…"）；',
  'QUERY —— 员工想从知识库查东西、要答案（"查一下…""看一下有没有…""谁做了什么""帮我找…""现在存着哪些信息"）；',
  'CHAT —— 与知识库无关的闲聊（"你好""在吗""谢谢"）。',
  '只输出 FEED、QUERY 或 CHAT 其中一个单词，不要输出任何其他内容。',
].join('\n');

/** 作废指令："作废/删除/撤回 #xxxxxxxx"（短 ID 为 6-12 位十六进制或字母数字）。 */
const RETRACT_RE = /^\s*(?:作废|删除|撤回|撤销)\s*(?:记录)?\s*#([0-9a-zA-Z]{6,12})\s*$/;

/**
 * 消息分流。
 * @param {string} text 员工发来的原始文本
 * @returns {{kind: 'note', text: string} | {kind: 'question', question: string} | {kind: 'help'} | {kind: 'retract', recordId: string} | {kind: 'ignore'}}
 */
export function route(text) {
  const raw = String(text ?? '').trim();

  // 空消息：忽略，不入库
  if (!raw) return {kind: 'ignore'};

  // 帮助
  if (HELP_WORDS.has(raw.toLowerCase())) return {kind: 'help'};

  // 作废指令
  const retract = raw.match(RETRACT_RE);
  if (retract) return {kind: 'retract', recordId: retract[1].toLowerCase()};

  // 显式提问前缀
  const prefixed = raw.match(QUESTION_PREFIX);
  if (prefixed) {
    const question = raw.replace(QUESTION_PREFIX, '').trim();
    // 剥完前缀后没有实际内容，视为帮助
    if (!question) return {kind: 'help'};
    return {kind: 'question', question};
  }

  // 疑问句启发式：以 ?/？ 结尾且长度 6–500 的文本视为提问
  if (/[?？]\s*$/.test(raw) && raw.length >= 6 && raw.length <= 500) {
    return {kind: 'question', question: raw.replace(/[?？]\s*$/, '').trim()};
  }

  // 默认：普通记录
  return {kind: 'note', text: raw};
}

/**
 * 增强分流（新增，异步）：先用 route() 的明确规则快速分流；
 * 只有落到"普通记录"的模糊消息，才请 LLM 判断是投喂、提问还是闲聊。
 * route() 签名保持不变；LLM 未配置或识别失败时等同 route()（宁可错存，不可丢）。
 * @param {string} text 员工发来的原始文本
 * @param {object} [llm] LLM 实例（契约：collector/src/llm.mjs），可选
 * @returns {Promise<{kind: string, text?: string, question?: string, recordId?: string}>}
 */
export async function routeWithLLM(text, llm) {
  const r = route(text);
  if (r.kind !== 'note' || !llm?.configured) return r;
  const content = await llm.chat([
    {role: 'system', content: CLASSIFY_PROMPT},
    {role: 'user', content: String(text ?? '').slice(0, 500)},
  ], {maxTokens: 150});
  const verdict = (content ?? '').trim().toUpperCase();
  if (verdict.startsWith('QUERY')) return {kind: 'question', question: String(text ?? '').trim()};
  if (verdict.startsWith('CHAT')) return {kind: 'chat'};
  return r; // FEED 或分类失败：按投喂处理
}
