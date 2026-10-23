#!/usr/bin/env node
// 每周质量巡检：对 Wiki 做规则检查（无需 LLM）+ 可选 LLM 语义检查，输出中文报告。
// 用法：node librarian/scripts/lint.mjs
// 环境变量：KB_URL / KB_WIKI_DIR / KB_LLM_*（配置了才跑语义检查，并对比内核 state()）
// 只读脚本：不修改任何文件，报告打到 stdout。

import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {KnowledgeBase} from '../../collector/src/kb.mjs';
import {LLM} from '../../collector/src/llm.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WIKI_DIR = path.resolve(process.env.KB_WIKI_DIR ?? path.join(HERE, '..', '..', 'wiki'));

/** 递归收集 dir 下全部 .md 文件（相对 WIKI_DIR 的路径）。 */
async function listMarkdown(dir, prefix = '') {
  let out = [];
  let entries;
  try {
    entries = await readdir(dir, {withFileTypes: true});
  } catch {
    return out; // 目录不存在
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // 跳过 .cursor 等
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out = out.concat(await listMarkdown(path.join(dir, e.name), rel));
    else if (e.name.endsWith('.md')) out.push(rel);
  }
  return out;
}

/** 统计一页里"陈述行"与"带 [^ 引用的陈述行"。陈述行 ≈ 列表项或普通正文句（剔除标题/引用/状态行/脚注定义/代码）。 */
function citationStats(content) {
  let total = 0, cited = 0;
  let inRefList = false;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (/^##\s*引用清单/.test(line)) { inRefList = true; continue; }
    if (/^##\s/.test(line)) { inRefList = false; continue; }
    if (inRefList) continue;
    if (!line || line.startsWith('#') || line.startsWith('>') || line.startsWith('```')) continue;
    if (/^\*\*状态\*\*/.test(line)) continue;          // 状态行是元信息
    if (/^\[\^[^\]]+\]:/.test(line)) continue;          // 脚注定义
    const isStatement = /^[-*]|\|/.test(line) || /[。；;：:，,]/.test(line);
    if (!isStatement) continue;
    total++;
    if (/\[\^/.test(line)) cited++;
  }
  return {total, cited};
}

/** 提取正文里的 [[链接]] 目标。 */
function wikiLinks(content) {
  const links = [];
  for (const m of content.matchAll(/\[\[([^\]]+)\]\]/g)) links.push(m[1].trim());
  return links;
}

async function main() {
  const pages = await listMarkdown(WIKI_DIR);
  const report = [];
  const add = (s) => report.push(s);

  add('# 知识库 Wiki 每周巡检报告');
  add(`巡检目录：${WIKI_DIR}`);
  add(`巡检时间：${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
  add('');

  if (pages.length === 0) {
    add('Wiki 目录里还没有任何页面（可能尚未编译）。先跑 `node librarian/scripts/compile.mjs`。');
    console.log(report.join('\n'));
    return;
  }

  // 读取全部页面
  const docs = new Map(); // rel → content
  for (const rel of pages) docs.set(rel, await readFile(path.join(WIKI_DIR, rel), 'utf8'));

  const stems = new Set(pages.map((rel) => path.basename(rel, '.md'))); // 页面名（[[链接]] 按页面名匹配）
  const indexContent = docs.get('index.md') ?? '';
  // wikiPages：参与规则检查的页面。digests/ 是只增不改的日志（用 [#短ID] 而非脚注、不进 index.md），
  // 只参与断链检查（摘要里也可能写 [[链接]]），不参与引用覆盖与孤儿页检查。
  const wikiPages = pages.filter((rel) => rel !== 'index.md');
  const contentPages = wikiPages.filter((rel) => !rel.startsWith('digests/'));

  // ---- 规则一：过半陈述无 [^ 引用 ----
  const underCited = [];
  for (const rel of contentPages) {
    const {total, cited} = citationStats(docs.get(rel));
    if (total >= 4 && cited * 2 < total) underCited.push(`  - ${rel}：${total} 条陈述仅 ${cited} 条带引用`);
  }
  add('## 一、引用覆盖不足的页面（过半陈述无 [^ 引用）');
  add(underCited.length ? underCited.join('\n') : '  ✅ 无');
  add('');

  // ---- 规则二：[[链接]] 断链 ----
  const broken = [];
  for (const rel of wikiPages) {
    for (const link of wikiLinks(docs.get(rel))) {
      if (!stems.has(link)) broken.push(`  - ${rel} → [[${link}]]`);
    }
  }
  add('## 二、断链（[[链接]] 找不到目标页面）');
  add(broken.length ? broken.join('\n') : '  ✅ 无');
  add('');

  // ---- 规则三：含 ⚠️ 矛盾标注的页面（需要人盯一眼）----
  const conflicts = wikiPages.filter((rel) => docs.get(rel).includes('⚠️'));
  add('## 三、存在矛盾标注的页面（请相关成员确认取舍）');
  add(conflicts.length ? conflicts.map((r) => `  - ${r}`).join('\n') : '  ✅ 无');
  add('');

  // ---- 规则四：未被 index.md 收录的孤儿页 ----
  const orphans = contentPages.filter((rel) => {
    const stem = path.basename(rel, '.md');
    return !indexContent.includes(stem) && !indexContent.includes(rel);
  });
  add('## 四、孤儿页（未在 index.md 中收录）');
  add(orphans.length ? orphans.map((r) => `  - ${r}`).join('\n') : '  ✅ 无');
  add('');

  // ---- LLM 语义检查（可选）----
  const llm = new LLM();
  if (!llm.configured) {
    add('## 五、语义检查（跨页矛盾 / 过时状态 / 缺支撑结论）');
    add('  ⏭️ 未配置 KB_LLM_*，跳过。配置后可自动发现跨页矛盾、过时的"当前状态"和缺少引用支撑的关键结论。');
  } else {
    add('## 五、语义检查（跨页矛盾 / 过时状态 / 缺支撑结论）');
    let stateText = '（获取失败）';
    try {
      const state = await new KnowledgeBase(process.env.KB_URL).state();
      stateText = JSON.stringify(state, null, 2).slice(0, 6000);
    } catch { /* 内核不可达时仍给出提示 */ }
    const pagesText = [...docs.entries()]
      .filter(([rel]) => rel !== 'index.md')
      .map(([rel, c]) => `--- ${rel} ---\n${c}`)
      .join('\n\n')
      .slice(0, 24000);
    const reply = await llm.chat([
      {role: 'system', content: [
        '你是知识库 Wiki 的质量巡检员。给你若干 Wiki 页面和知识内核的事项当前状态投影（state）。',
        '请找出三类问题：1）不同页面之间相互矛盾的陈述；2）与 state 投影不一致、已经过时的"当前状态"描述；3）缺乏 [^引用] 支撑的关键结论。',
        '每类问题逐条列出：页面名 + 问题描述。没有问题就写"无"。简洁，中文。',
      ].join('\n')},
      {role: 'user', content: `内核 state 投影：\n${stateText}\n\nWiki 页面：\n${pagesText}`},
    ], {maxTokens: 2500});
    add(reply?.trim() ? reply.trim().split('\n').map((l) => '  ' + l).join('\n') : '  ⚠️ LLM 调用失败（返回 null），本次语义检查未完成，下周重试。');
  }

  add('');
  add('—— 报告结束。规则检查每周自动跑；带 ⚠️ 的条目需要人工跟进。');
  console.log(report.join('\n'));
}

main().catch((err) => {
  console.error('巡检中断：' + (err?.message ?? err));
  process.exitCode = 0;
});
