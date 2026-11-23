import {createHash} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {isAbsolute, join} from 'node:path';
import {terms} from './store.mjs';

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function wikiFile(directory, scope) {
  if (!directory || !isAbsolute(directory)) throw new Error('TEAM_WIKI_DIR 须为绝对路径');
  return join(directory, digest(scope) + '.json');
}

export function wikiSnapshot(records) {
  return digest(records.map(row => [row.id, row.version, row.text, row.occurred_at, row.author]).sort(
    (left, right) => left[0].localeCompare(right[0])));
}

export async function writeScopeWiki(directory, scope, snapshot, pages) {
  const file = wikiFile(directory, scope), temporary = file + '.' + randomUUID();
  await mkdir(directory, {recursive: true, mode: 0o700});
  try {
    await writeFile(temporary, JSON.stringify({scope, snapshot, pages}), {mode: 0o600, flag: 'wx'});
    await rename(temporary, file);
  } finally {
    await rm(temporary, {force: true});
  }
}

export async function readScopeWiki(directory, scope) {
  try {
    const wiki = JSON.parse(await readFile(wikiFile(directory, scope), 'utf8'));
    return wiki.scope === scope ? wiki : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function lookupWiki(view, user, scopes, question, directory = process.env.TEAM_WIKI_DIR) {
  if (!directory) return [];
  const keywords = new Set(terms(question));
  const candidates = [];
  for (const scope of scopes) {
    view.access(user, scope);
    if (view.knowledge?.pending(scope)) continue;
    const records = view.knowledge ? view.knowledge.evidence(scope, view.knowledge.entries(scope)) : view.records(user, scope);
    const byShortId = new Map(records.map(row => [row.id.slice(0, 8), row]));
    if (byShortId.size !== records.length) continue;
    const wiki = await readScopeWiki(directory, scope);
    const pages = wiki?.snapshot === wikiSnapshot(records) ? wiki.pages : [];
    for (const {title, text} of pages) {
      const score = terms(title + ' ' + text).filter(word => keywords.has(word)).length;
      if (!score) continue;
      const ids = [...new Set([...text.matchAll(/\[\^([a-z0-9]{8})\]/gi)].map(match => match[1]))];
      const sources = ids.map(id => byShortId.get(id));
      if (sources.length && sources.length <= 12 && sources.every(Boolean)) {
        candidates.push({title, text, sources, score});
      }
    }
  }
  return candidates.sort((left, right) => right.score - left.score).slice(0, 3);
}
