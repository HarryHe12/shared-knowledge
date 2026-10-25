#!/usr/bin/env node
// 增量编译：把知识内核里的新记录整理进 Wiki（规则见 librarian/SCHEMA.md）。
// 用法：node librarian/scripts/compile.mjs
// 环境变量：
//   KB_URL      知识内核地址（默认 http://127.0.0.1:5181）
//   KB_WIKI_DIR Wiki 根目录（默认 <kb-system>/wiki）
//   KB_LLM_*    LLM 配置；未配置时跳过编译、只推进游标（记录已在内核，检索不受影响）
// 退出码：恒 0——这是定时任务，任何失败只说明、不炸调度器。

import {readFile, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {allowLegacyExport} from './export-policy.mjs';
import {KnowledgeBase} from '../../collector/src/kb.mjs';
import {LLM} from '../../collector/src/llm.mjs';
import {extractAuthor, stripHeader} from './answer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Wiki 根目录：默认 kb-system/wiki（与 librarian/ 平级，属 Agent B 地盘）
const WIKI_DIR = path.resolve(process.env.KB_WIKI_DIR ?? path.join(HERE, '..', '..', 'wiki'));
const CURSOR_FILE = path.join(WIKI_DIR, '.cursor');
const INDEX_FILE = path.join(WIKI_DIR, 'index.md');

/** 读取编译游标（已编译的记录条数）；文件不存在或损坏一律从 0 开始。 */
async function readCursor() {
  try {
    const n = parseInt((await readFile(CURSOR_FILE, 'utf8')).trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

async function writeCursor(n) {
  await mkdir(WIKI_DIR, {recursive: true});
  await writeFile(CURSOR_FILE, String(n) + '\n', 'utf8');
}

/** 短 ID：记录 id 前 8 位。 */
const shortId = (id) => String(id ?? '').slice(0, 8);

/** 新记录格式化成"【#短ID】日期 作者：正文"清单。 */
function formatNewRecords(records) {
  return records.map((r) => {
    const date = String(r.occurred_at ?? '').slice(0, 10) || '时间未知';
    const author = extractAuthor(r.text) ?? r.author ?? '未知作者';
    return `【#${shortId(r.id)}】${date} ${author}：${stripHeader(r.text)}`;
  }).join('\n');
}

const SYSTEM_PROMPT = [
  '你是团队知识库的 Wiki 编译员。规则（摘要）：',
  '- 原始记录是唯一事实来源；Wiki 里每条陈述句尾必须带 [^短ID] 脚注（短ID 即记录编号，去掉 # 号）。',
  '- 矛盾用"⚠️ 矛盾"标注，两边都保留并分别引用，不许覆盖。',
  '- 区分成员陈述（@作者：……）与 AI 整理（注明"整理自多条记录"）；不创作事实。',
  '- 页面归属：项目事项进 projects/，人或系统等实体进 entities/，通用主题或拿不准的进 topics/（实在拿不准写 topics/杂项.md）。',
  '- 页面模板：标题、一句话定位、状态行、当前状态、关键事实、待办与阻塞、时间线、引用清单（见 SCHEMA.md）。',
  '- 页间用 [[页面名]] 互链。',
  '',
  '输出格式（严格遵守，不要输出任何其他文字）：',
  '===PAGE: 相对路径.md===',
  '<该页完整 Markdown 内容>',
  '===END===',
  '（可输出多个 PAGE 块；只输出需要新建或有实质更新的页面）',
  '===INDEX===',
  '<index.md 的完整内容：全部页面的清单，每项一行 "- [[页面名]]（路径）：一句话定位 —— 最后更新 YYYY-MM-DD">',
  '===END===',
  '',
  '如果这批新记录没有任何值得进 Wiki 的信息，整段回复只输出：NOOP',
].join('\n');

/**
 * 解析 LLM 输出，返回 {pages: Map<相对路径, 内容>, index: string|null, noop: boolean}。
 * 解析是防御式的：格式不对的块直接丢弃，绝不让一次坏输出毁掉编译。
 */
function parseOutput(text) {
  const out = {pages: new Map(), index: null, noop: false};
  const t = String(text ?? '').trim();
  if (!t) return out;
  if (/^NOOP\s*$/i.test(t)) { out.noop = true; return out; }

  const blockRe = /===(PAGE:\s*([^=\n]+?)|INDEX)\s*===\n([\s\S]*?)===END===/g;
  let m;
  while ((m = blockRe.exec(t)) !== null) {
    if (m[2] !== undefined) {
      const rel = m[2].trim();
      out.pages.set(rel, m[3].trim() + '\n');
    } else {
      out.index = m[3].trim() + '\n';
    }
  }
  return out;
}

/** 防路径穿越：页面路径必须落在 WIKI_DIR 内的 projects/entities/topics/ 下，且是 .md 文件。 */
function safePagePath(rel) {
  if (!/^(projects|entities|topics)\/[^/\\]+\.md$/.test(rel)) return null;
  if (rel.includes('..')) return null;
  const abs = path.resolve(WIKI_DIR, rel);
  return abs.startsWith(WIKI_DIR + path.sep) ? abs : null;
}

async function main() {
  const kb = new KnowledgeBase(process.env.KB_URL);
  if (!await allowLegacyExport(kb)) {console.log('旧 Wiki/静态摘要导出默认停用；公司知识请通过受控聊天查询。');return;}
  const llm = new LLM();

  // 1. 取全部记录，与游标比较得出新增部分
  const all = await kb.records();
  const total = Array.isArray(all) ? all.length : (all?.records?.length ?? 0);
  const list = Array.isArray(all) ? all : (all?.records ?? []);
  const cursor = await readCursor();
  const fresh = list.slice(cursor); // 内核按 occurred_at 排序返回

  if (fresh.length === 0) {
    console.log(`没有新增记录（库内共 ${total} 条，游标 ${cursor}），本次无需编译。`);
    return;
  }
  console.log(`发现 ${fresh.length} 条新记录（库内共 ${total} 条，游标 ${cursor}）。`);

  // 2. LLM 未配置：说明情况并推进游标——记录已在内核里，问答检索不受影响
  if (!llm.configured) {
    await writeCursor(cursor + fresh.length);
    console.log('未配置 KB_LLM_*，跳过 Wiki 编译并推进游标。记录已在内核中，检索与问答不受影响；配置 LLM 后可人工全量重建补齐 Wiki。');
    return;
  }

  // 3. 调 LLM 编译
  let indexNow = '';
  try { indexNow = await readFile(INDEX_FILE, 'utf8'); } catch { /* 首次编译没有 index */ }
  const userMsg = [
    `当前 index.md 内容：\n${indexNow || '（空，本次为首次编译）'}`,
    '',
    `新增记录（共 ${fresh.length} 条，按时间排序）：\n${formatNewRecords(fresh)}`,
  ].join('\n');
  const reply = await llm.chat([
    {role: 'system', content: SYSTEM_PROMPT},
    {role: 'user', content: userMsg},
  ], {maxTokens: 8000});

  // 4. LLM 调用失败：不推进游标，下次重试
  if (reply == null) {
    console.log('LLM 调用失败（返回 null）。游标保持不动，本次新记录留待下次编译重试。');
    return;
  }

  // 5. NOOP：LLM 判断无值得收录的信息，只推进游标
  const parsed = parseOutput(reply);
  if (parsed.noop) {
    await writeCursor(cursor + fresh.length);
    console.log('LLM 判定本批记录无需入 Wiki（NOOP），已推进游标。');
    return;
  }

  // 6. 写页面 + 更新 index + 推进游标
  let written = 0;
  for (const [rel, content] of parsed.pages) {
    const abs = safePagePath(rel);
    if (!abs) {
      console.log(`跳过不安全或不合法的页面路径：${rel}`);
      continue;
    }
    await mkdir(path.dirname(abs), {recursive: true});
    await writeFile(abs, content, 'utf8');
    written++;
    console.log(`已写入 ${rel}（${content.length} 字符）`);
  }
  if (parsed.index != null) {
    await mkdir(WIKI_DIR, {recursive: true});
    await writeFile(INDEX_FILE, parsed.index, 'utf8');
    console.log('已更新 index.md');
  }
  await writeCursor(cursor + fresh.length);
  console.log(`编译完成：写入 ${written} 个页面，游标推进到 ${cursor + fresh.length}。`);
}

main().catch((err) => {
  // 定时任务兜底：报错说明清楚，退出码仍为 0，不炸调度器
  console.error('编译中断：' + (err?.message ?? err));
  process.exitCode = 0;
});
