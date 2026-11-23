import {randomUUID} from 'node:crypto';
import {extractFacts, factKey, knowledgeDay, lookupDay, STATUS_LABELS} from './knowledge-facts.mjs';
import {terms} from './store.mjs';
import {retrieve} from './retrieval.mjs';
import {anchoredLookup} from './query-policy.mjs';

const LEASE_MS = 180000;
const UPDATE_MESSAGE = '这个知识范围有新记录正在整理，稍后再查当前结论。';
const sources = `JOIN records r ON r.id=k.record_id
  LEFT JOIN record_lifecycle l ON l.record_id=r.id`;
const active = 'COALESCE(l.deleted,0)=0';

function setup(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_records(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, record_id TEXT NOT NULL UNIQUE REFERENCES records(id) ON DELETE CASCADE,
      done INTEGER NOT NULL DEFAULT 0, claim TEXT, retry_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      rejected INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS knowledge_pending ON knowledge_records(done,retry_at,seq);
    CREATE TABLE IF NOT EXISTS knowledge_facts(
      seq INTEGER NOT NULL REFERENCES knowledge_records(seq) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL, key TEXT NOT NULL, subject TEXT NOT NULL, field TEXT NOT NULL,
      qualifier TEXT NOT NULL, value TEXT NOT NULL, starts_on TEXT, ends_on TEXT, item_id TEXT, status TEXT,
      PRIMARY KEY(seq,ordinal)
    );
    CREATE TRIGGER IF NOT EXISTS knowledge_record_saved AFTER INSERT ON records BEGIN
      INSERT INTO knowledge_records(record_id) VALUES(NEW.id);
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_record_corrected AFTER UPDATE OF text,occurred_at ON records BEGIN
      DELETE FROM knowledge_records WHERE record_id=NEW.id;
      INSERT INTO knowledge_records(record_id) VALUES(NEW.id);
    END;
    INSERT INTO knowledge_records(record_id)
      SELECT id FROM records WHERE NOT EXISTS(SELECT 1 FROM knowledge_records WHERE record_id=records.id)
      ORDER BY recorded_at,rowid;
  `);
  if (!db.prepare('PRAGMA table_info(knowledge_records)').all().some(column => column.name === 'rejected')) {
    db.exec('ALTER TABLE knowledge_records ADD COLUMN rejected INTEGER NOT NULL DEFAULT 0');
  }
}

function factLine(fact) {
  const context = [fact.qualifier, [fact.starts_on, fact.ends_on].filter(Boolean).join(' 至 ')].filter(Boolean).join('，');
  return [fact.subject, fact.field + (context ? '（' + context + '）' : ''), fact.value].join(' ');
}

function itemEntries(item) {
  const status = {id: item.source_id, subject: item.title, text: item.title + ' 状态 ' + STATUS_LABELS[item.status]};
  const details = [item.owner && '跟进人 ' + item.owner, item.deadline && '截止 ' + item.deadline].filter(Boolean);
  if (!details.length) return [status];
  return [status, {id: item.details_source_id, subject: item.title, text: [item.title, ...details].join('，')}];
}

function ranked(entries, query, limit) {
  const words = terms(query), exact = factKey(query);
  return entries.map(row => {
    const rowWords = new Set(terms(row.text));
    const text = factKey(row.text);
    return {row, score: words.filter(word => rowWords.has(word)).length + (text.includes(exact) && exact ? 4 : 0)};
  }).filter(hit => hit.score > 0)
    .sort((a, b) => b.score - a.score || b.row.order - a.row.order).slice(0, limit).map(hit => hit.row);
}

export function setKnowledgeReadMode(db, serving) {
  db.exec('CREATE TABLE IF NOT EXISTS service_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const value = serving ? 'current' : 'legacy';
  const before = db.prepare("SELECT value FROM service_settings WHERE key='knowledge_read_mode'").get()?.value ?? 'legacy';
  if (before === value) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("INSERT OR REPLACE INTO service_settings VALUES('knowledge_read_mode',?)").run(value);
    db.exec('UPDATE record_epoch SET value=value+1; COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

async function findCurrent(view, user, scope, query, rows, {strategy, limit, depth, options}) {
  if (!rows.length) return {records: [], ranking: strategy, anchors: []};
  const searchable = Object.create(view);
  searchable.records = () => rows;
  searchable.search = () => ranked(rows, query, 40);
  const anchors = anchoredLookup(searchable, user, scope, query, {depth});
  const rankedResult = strategy === 'exact' ? {hits: [], mode: 'exact'} :
    await retrieve(searchable, user, scope, query, {...options, topK: limit});
  const rankedRows = [...new Map([...rankedResult.hits, ...anchors.hits].map(row => [row.id, row])).values()];
  return {records: rankedRows.slice(0, limit), ranking: rankedResult.mode, anchors: anchors.anchors};
}

export class CurrentKnowledge {
  constructor(store, {now = Date.now, serving = true} = {}) {
    this.store = store;
    this.db = store.db;
    this.now = now;
    this.serving = serving;
    setup(this.db);
  }

  isActive(scope) {
    const organization = this.store.organization;
    const context = organization?.context(scope);
    return !context || organization.scopeActive(context);
  }

  pending(scope) {
    return Boolean(this.db.prepare(`SELECT 1 FROM knowledge_records k ${sources}
      WHERE r.project_id=? AND k.done=0 AND ${active} LIMIT 1`).get(scope));
  }

  rejectedCount(scope) {
    return this.db.prepare(`SELECT COALESCE(SUM(k.rejected),0) AS count FROM knowledge_records k ${sources}
      WHERE r.project_id=? AND k.done=1 AND ${active}`).get(scope).count;
  }

  claim() {
    const now = this.now(), claim = randomUUID();
    const jobs = this.db.prepare(`SELECT k.seq,r.* FROM knowledge_records k ${sources}
      WHERE k.done=0 AND k.retry_at<=? AND ${active} ORDER BY k.seq`).iterate(now);
    for (const record of jobs) {
      if (!this.isActive(record.project_id)) continue;
      const changed = this.db.prepare(`UPDATE knowledge_records SET claim=?,retry_at=?,attempts=attempts+1
        WHERE seq=? AND done=0 AND retry_at<=?`).run(claim, now + LEASE_MS, record.seq, now);
      if (changed.changes) return {...record, claim};
    }
    return null;
  }

  columns(record) {
    const items = this.db.prepare('SELECT id AS item_id,title FROM items WHERE project_id=? ORDER BY rowid DESC').all(record.project_id);
    items.sort((a, b) => Number(record.text.includes(b.title)) - Number(record.text.includes(a.title)));
    const facts = this.db.prepare(`SELECT DISTINCT subject,field,qualifier FROM knowledge_facts f
      JOIN knowledge_records k USING(seq) ${sources}
      WHERE r.project_id=? AND ${active} ORDER BY f.seq DESC LIMIT 250`).all(record.project_id);
    const words = new Set(terms(record.text));
    const score = row => terms(row.subject + ' ' + row.field).filter(word => words.has(word)).length;
    facts.sort((a, b) => score(b) - score(a));
    return [...items.slice(0, 25), ...facts.slice(0, 35)];
  }

  async runOnce(model) {
    const record = this.claim();
    if (!record) return 'idle';
    try {
      const name = this.db.prepare('SELECT name FROM projects WHERE id=?').get(record.project_id).name;
      const facts = await extractFacts(model, record, name, this.columns(record));
      if (!this.isActive(record.project_id)) throw new Error('知识范围已停用');
      this.complete(record, facts);
      return 'processed';
    } catch {
      this.db.prepare(`UPDATE knowledge_records SET claim=NULL,retry_at=?+MIN(300000,1000*(1<<MIN(attempts,8)))
        WHERE seq=? AND claim=?`).run(this.now(), record.seq, record.claim);
      return 'retry';
    }
  }

  complete(record, {facts, rejected}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const saved = this.db.prepare(`UPDATE knowledge_records SET done=1,claim=NULL,rejected=?
        WHERE seq=? AND claim=? AND retry_at>?
        AND NOT EXISTS(SELECT 1 FROM record_lifecycle WHERE record_id=? AND deleted=1)`)
        .run(rejected, record.seq, record.claim, this.now(), record.id);
      if (saved.changes) this.insertFacts(record.seq, facts);
      else this.db.prepare('UPDATE knowledge_records SET claim=NULL,retry_at=0 WHERE seq=? AND claim=?').run(record.seq, record.claim);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  insertFacts(seq, facts) {
    const insert = this.db.prepare('INSERT INTO knowledge_facts VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    facts.forEach((fact, index) => insert.run(seq, index, fact.key, fact.subject, fact.field, fact.qualifier,
      fact.value, fact.from, fact.through, fact.itemId, fact.status));
    if (this.serving) this.db.exec('UPDATE record_epoch SET value=value+1');
  }

  stateRows(scope) {
    return this.db.prepare(`
      WITH details AS (
        SELECT i.id,i.title,i.project_id,e.record_id,e.status,e.owner,e.deadline,e.kind,k.seq,1 AS structured,e.record_id AS details_source_id
        FROM items i JOIN events e ON e.item_id=i.id JOIN knowledge_records k ON k.record_id=e.record_id
        ${sources} WHERE i.project_id=? AND ${active}
      ), candidates AS (
        SELECT * FROM details
        UNION ALL
        SELECT i.id,i.title,i.project_id,k.record_id,f.status,
          (SELECT d.owner FROM details d WHERE d.id=i.id AND d.seq<=k.seq ORDER BY d.seq DESC LIMIT 1),
          (SELECT d.deadline FROM details d WHERE d.id=i.id AND d.seq<=k.seq ORDER BY d.seq DESC LIMIT 1),
          'reported',k.seq,0,
          (SELECT d.record_id FROM details d WHERE d.id=i.id AND d.seq<=k.seq ORDER BY d.seq DESC LIMIT 1)
        FROM knowledge_facts f JOIN knowledge_records k USING(seq) ${sources}
        JOIN items i ON i.id=f.item_id AND i.project_id=r.project_id
        WHERE i.project_id=? AND ${active}
      ), latest AS (
        SELECT *, ROW_NUMBER() OVER(PARTITION BY id ORDER BY seq DESC,structured DESC) AS rank FROM candidates
      )
      SELECT i.id,i.title,i.project_id,i.status,i.owner,i.deadline,i.kind,r.occurred_at,r.recorded_at,r.id AS source_id,i.details_source_id
      FROM latest i JOIN records r ON r.id=i.record_id WHERE i.rank=1 ORDER BY i.id
    `).all(scope, scope);
  }

  entries(scope, date = knowledgeDay(this.now()), includeItems = true) {
    const selected = this.db.prepare(`
      WITH latest AS (
        SELECT f.*,k.record_id,ROW_NUMBER() OVER(PARTITION BY f.key ORDER BY f.seq DESC,f.ordinal DESC) AS rank
        FROM knowledge_facts f JOIN knowledge_records k USING(seq) ${sources}
        WHERE r.project_id=? AND ${active} AND f.item_id IS NULL
        AND (f.starts_on IS NULL OR f.starts_on<=?) AND (f.ends_on IS NULL OR f.ends_on>=?)
      )
      SELECT * FROM latest WHERE rank=1 ORDER BY key
    `).all(scope, date, date);
    const facts = selected.map(row => ({id: row.record_id, subject: row.subject, text: factLine(row)}));
    return includeItems ? facts.concat(this.stateRows(scope).flatMap(itemEntries)) : facts;
  }

  evidence(scope, entries) {
    const byId = new Map();
    for (const entry of entries) {
      const group = byId.get(entry.id) ?? [];
      byId.set(entry.id, group.concat(entry.text));
    }
    const rows = this.db.prepare(`SELECT r.id,r.project_id,r.author_id,r.occurred_at,r.recorded_at,k.seq AS "order",
      u.name AS author,COALESCE(l.version,1) AS version
      FROM knowledge_records k ${sources} JOIN users u ON u.id=r.author_id
      WHERE r.project_id=? AND ${active}`).all(scope);
    return rows.filter(row => byId.has(row.id)).map(row => ({...row, text: byId.get(row.id).join('\n')}));
  }

  async search(view, user, scope, input, {limit, strategy, depth, options}) {
    const epoch = this.db.prepare('SELECT value FROM record_epoch');
    const before = epoch.get().value;
    const date = lookupDay(input.query, input.as_of, knowledgeDay(this.now()));
    const pending = this.pending(scope);
    const rows = pending ? [] : this.evidence(scope, this.entries(scope, date, date === knowledgeDay(this.now())));
    const {records, ranking, anchors} = await findCurrent(view, user, scope, input.query, rows, {limit, strategy, depth, options});
    view.access(user, scope);
    if (epoch.get().value !== before) throw Object.assign(new Error('记录已变化，请重新检索'), {status:409});
    return {query: input.query, scope: {project_id: scope}, records,
      retrieval: {mode: 'current-knowledge', strategy, ranking, as_of: date, anchors},
      coverage: {status: pending ? 'updating' : 'current', total_records: rows.length, returned: records.length, limit, exhaustive: false},
      meaning: pending ? UPDATE_MESSAGE : '返回当前生效事实和原始来源编号。'};
  }
}
