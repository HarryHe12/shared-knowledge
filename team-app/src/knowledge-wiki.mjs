import {readScopeWiki, wikiSnapshot, writeScopeWiki} from './wiki.mjs';

function markdownText(text) {
  return text.replace(/[\r\n]+/g, ' ').replace(/[\\<>&\[\]`*_]/g, match => '\\' + match);
}

function pagesFrom(entries, rows) {
  const groups = new Map(), ids = new Set(rows.map(row => row.id.slice(0, 8)));
  if (ids.size !== rows.length) throw new Error('Wiki 原文简称重复');
  for (const {id, subject, text} of entries) {
    const lines = groups.get(subject) ?? [];
    lines.push('- ' + markdownText(text) + ' [^' + id.slice(0, 8) + ']');
    groups.set(subject, lines);
  }
  const pages = [];
  for (const [subject, lines] of groups) {
    for (let index = 0; index < lines.length; index += 12) {
      const title = subject + (index ? '（' + (index / 12 + 1) + '）' : '');
      pages.push({title, text: lines.slice(index, index + 12).join('\n')});
    }
  }
  return pages;
}

export function currentWiki(knowledge, scope) {
  if (knowledge.pending(scope)) return null;
  const entries = knowledge.entries(scope);
  const rows = knowledge.evidence(scope, entries);
  return {snapshot: wikiSnapshot(rows), pages: pagesFrom(entries, rows)};
}

async function refreshWiki(knowledge, directory, published, logger) {
  const scopes = knowledge.db.prepare('SELECT id FROM projects ORDER BY id').all();
  for (const {id} of scopes) {
    if (!knowledge.isActive(id)) continue;
    try {
      const wiki = currentWiki(knowledge, id);
      if (!wiki) continue;
      if (wiki.snapshot === published.get(id) && wiki.snapshot === (await readScopeWiki(directory, id).catch(() => null))?.snapshot) continue;
      await writeScopeWiki(directory, id, wiki.snapshot, wiki.pages);
      published.set(id, wiki.snapshot);
    } catch {
      logger.warn('有一个知识范围的 Wiki 更新失败，稍后会重试。');
    }
  }
}

export function startKnowledgeWorkers(knowledge, model, directory, logger = console) {
  let work, stopped = false, wikiWork;
  const published = new Map();
  const process = () => {
    if (stopped || work) return;
    work = knowledge.runOnce(model).catch(() => logger.warn('知识更新任务失败，稍后会重试。'))
      .finally(() => { work = null; });
  };
  const publish = () => {
    if (!directory || stopped || wikiWork) return;
    wikiWork = refreshWiki(knowledge, directory, published, logger)
      .catch(() => logger.warn('Wiki 刷新任务失败，稍后会重试。')).finally(() => { wikiWork = null; });
  };
  const timer = setInterval(process, 500).unref();
  const wikiTimer = setInterval(publish, 2000).unref();
  process();
  publish();
  return async () => {
    stopped = true;
    clearInterval(timer);
    clearInterval(wikiTimer);
    await Promise.all([work, wikiWork]);
  };
}
