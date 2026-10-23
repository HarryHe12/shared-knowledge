#!/usr/bin/env node
// 每日摘要：把某一天（默认昨天）的记录整理成摘要写入 wiki/digests/<日期>.md，可选企微推送。
// 用法：node librarian/scripts/digest.mjs [YYYY-MM-DD]
// 环境变量：
//   KB_URL           知识内核地址
//   KB_WIKI_DIR      Wiki 根目录（默认 <kb-system>/wiki）
//   KB_LLM_*         LLM 配置；未配置时降级为原始记录罗列
//   WECOM_DIGEST_TO  推送目标 userId（多人用 | 分隔）；配合企微凭证 WECOM_CORP_ID/WECOM_SECRET 生效
// 企微推送模块 collector/src/wecom.mjs 由 Agent A 并行开发，可能暂不存在——动态 import，缺了只提示不崩溃。

import {writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {KnowledgeBase} from '../../collector/src/kb.mjs';
import {LLM} from '../../collector/src/llm.mjs';
import {extractAuthor, stripHeader} from './answer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WIKI_DIR = path.resolve(process.env.KB_WIKI_DIR ?? path.join(HERE, '..', '..', 'wiki'));

/** 昨天的日期（本地时区），YYYY-MM-DD。 */
function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const shortId = (id) => String(id ?? '').slice(0, 8);
const authorOf = (r) => extractAuthor(r.text) ?? r.author ?? '未知作者';

const SYSTEM_PROMPT = [
  '你是团队知识库的日报整理员。下面是某一天的知识库原始记录（含编号、作者、正文）。',
  '请输出 300 字以内的当日摘要：',
  '1. 按主题分组，每主题一个要点；',
  '2. 每个要点写明作者并带 [#短ID] 引用（短ID 即记录编号去掉 # 号，写为 [#xxxxxxxx]）；',
  '3. 末尾单列一节"阻塞与待办"，汇总所有记录里提到的阻塞和待办，没有就写"无"；',
  '4. 只依据给出的记录，不补充任何外部信息。',
].join('\n');

async function main() {
  const date = (process.argv[2] ?? '').trim() || yesterday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`日期格式不对：${date}（应为 YYYY-MM-DD）`);
    return;
  }

  const kb = new KnowledgeBase(process.env.KB_URL);
  const llm = new LLM();
  const all = await kb.records();
  const list = Array.isArray(all) ? all : (all?.records ?? []);

  // 筛 occurred_at 当天的记录（occurred_at 是 ISO 字符串或时间戳，统一转成本地日期比较）
  const dayRecords = list.filter((r) => {
    const t = r.occurred_at;
    if (t == null) return false;
    const d = new Date(typeof t === 'number' ? t : t);
    if (Number.isNaN(d.getTime())) return String(t).startsWith(date);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` === date;
  });

  if (dayRecords.length === 0) {
    console.log(`${date} 没有任何记录，无需生成摘要。`);
    return;
  }

  // 生成摘要正文
  let body;
  const evidenceList = dayRecords.map((r) => {
    const time = String(r.occurred_at ?? '').slice(11, 16);
    return `【#${shortId(r.id)}】${time} ${authorOf(r)}：${stripHeader(r.text)}`;
  }).join('\n');

  if (llm.configured) {
    const reply = await llm.chat([
      {role: 'system', content: SYSTEM_PROMPT},
      {role: 'user', content: `${date} 的记录（共 ${dayRecords.length} 条）：\n${evidenceList}`},
    ], {maxTokens: 1500});
    body = reply?.trim() || null;
    if (!body) console.log('LLM 调用失败，降级为原始记录罗列。');
  } else {
    console.log('未配置 KB_LLM_*，摘要降级为原始记录罗列。');
  }
  if (!body) {
    body = '（未启用 AI 整理，以下为原始记录）\n\n' + dayRecords.map((r) =>
      `- ${authorOf(r)}：${stripHeader(r.text)} [#${shortId(r.id)}]`
    ).join('\n');
  }

  // 写入 wiki/digests/<日期>.md
  const doc = `# ${date} 知识库摘要\n\n> 当日共 ${dayRecords.length} 条记录。\n\n${body}\n`;
  await mkdir(path.join(WIKI_DIR, 'digests'), {recursive: true});
  const file = path.join(WIKI_DIR, 'digests', `${date}.md`);
  await writeFile(file, doc, 'utf8');
  console.log(`摘要已写入 ${file}`);

  // 企微推送（可选）：模块由 Agent A 并行开发，缺失时仅提示
  const to = (process.env.WECOM_DIGEST_TO ?? '').trim();
  if (!to) return;
  if (!process.env.WECOM_CORP_ID || !process.env.WECOM_SECRET) {
    console.log('已设置 WECOM_DIGEST_TO，但企微凭证（WECOM_CORP_ID/WECOM_SECRET）不齐全，跳过推送。');
    return;
  }
  try {
    const {WeCom} = await import('../../collector/src/wecom.mjs');
    const wecom = new WeCom();
    const pushText = `📋 ${date} 知识库摘要\n${body}`.slice(0, 1900);
    for (const userId of to.split('|').map((s) => s.trim()).filter(Boolean)) {
      await wecom.sendText(userId, pushText);
    }
    console.log(`已推送给 ${to}`);
  } catch (err) {
    console.log('企微推送未完成（' + (err?.code === 'ERR_MODULE_NOT_FOUND' ? 'wecom.mjs 尚未就绪' : (err?.message ?? err)) + '），摘要文件不受影响。');
  }
}

main().catch((err) => {
  console.error('摘要生成中断：' + (err?.message ?? err));
  process.exitCode = 0;
});
