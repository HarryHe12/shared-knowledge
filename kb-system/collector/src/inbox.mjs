import {DatabaseSync} from 'node:sqlite';
import {mkdirSync, chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (message, status) => Object.assign(new Error(message), {status});

/** Durable, per-employee FIFO with leases; acknowledging a callback happens after enqueue commits. */
export class DurableInbox {
  constructor(path, {now = Date.now, maxAttempts = 5} = {}) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new Error('COLLECTOR_MAX_ATTEMPTS 须为1—20');
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true, mode: 0o700});
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.now = now;
    this.maxAttempts = maxAttempts;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS collector_inbox(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, app_id TEXT NOT NULL,
        external_id TEXT NOT NULL, fingerprint TEXT NOT NULL, text TEXT, occurred_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','dead')),
        attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,claim_token TEXT,
        user_id TEXT, input TEXT, output TEXT, sent_count INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS collector_inbox_pending ON collector_inbox(status,next_at,seq);
      CREATE TABLE IF NOT EXISTS collector_preferences(
        app_id TEXT NOT NULL,external_id TEXT NOT NULL,user_id TEXT NOT NULL,scope_id TEXT,
        PRIMARY KEY(app_id,external_id,user_id));
      CREATE TABLE IF NOT EXISTS collector_conversations(
        app_id TEXT NOT NULL,external_id TEXT NOT NULL,user_id TEXT NOT NULL,scope_key TEXT NOT NULL,
        conversation_id TEXT NOT NULL,PRIMARY KEY(app_id,external_id,user_id,scope_key));`);
    if (!this.db.prepare('PRAGMA table_info(collector_inbox)').all().some(column => column.name === 'claim_token')) {
      this.db.exec('ALTER TABLE collector_inbox ADD COLUMN claim_token TEXT');
    }
  }

  enqueue({appId, externalId, msgId, text, occurredAt}) {
    if (![appId, externalId, msgId, text].every(value => typeof value === 'string' && value) || text.length > 20000) throw fail('消息编号、员工或正文无效', 400);
    const id = 'wecom:' + digest(appId + '\0' + msgId);
    const fingerprint = digest(JSON.stringify({externalId, text, occurredAt}));
    const now = this.now();
    this.db.prepare(`INSERT OR IGNORE INTO collector_inbox(id,app_id,external_id,fingerprint,text,occurred_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, appId, externalId, fingerprint, text, occurredAt, now, now);
    const row = this.get(id);
    if (row.fingerprint !== fingerprint) throw fail('同一消息编号不能用于不同内容', 409);
    return row;
  }

  get(id) { return this.db.prepare('SELECT * FROM collector_inbox WHERE id=?').get(id); }

  claim() {
    const now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`UPDATE collector_inbox SET status='dead',text=NULL,input=NULL,output=NULL,
        lease_until=0,claim_token=NULL,last_error='处理重试次数已达上限',updated_at=?
        WHERE attempts>=? AND status='processing' AND lease_until<=?`).run(now, this.maxAttempts, now);
      const row = this.db.prepare(`SELECT j.* FROM collector_inbox j WHERE
        ((j.status='pending' AND j.next_at<=?) OR (j.status='processing' AND j.lease_until<=?)) AND j.attempts<?
        AND NOT EXISTS(SELECT 1 FROM collector_inbox earlier WHERE earlier.app_id=j.app_id
          AND earlier.external_id=j.external_id AND earlier.seq<j.seq AND earlier.status IN ('pending','processing'))
        ORDER BY j.seq LIMIT 1`).get(now, now, this.maxAttempts);
      if (row) this.db.prepare("UPDATE collector_inbox SET status='processing',attempts=attempts+1,lease_until=?,claim_token=?,updated_at=? WHERE id=?")
        .run(now + 120000, randomUUID(), now, row.id);
      this.db.exec('COMMIT');
      return row ? this.get(row.id) : null;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  assertLease(job) {
    const current = this.get(job.id);
    if (current?.status !== 'processing' || current.claim_token !== job.claim_token || current.lease_until <= this.now()) {
      throw Object.assign(fail('本次处理已由另一工作进程接管', 409), {leaseLost: true});
    }
  }

  update(job, sql, parameters) {
    const changed = this.db.prepare(sql + " WHERE id=? AND claim_token=? AND status='processing' AND lease_until>?")
      .run(...parameters, job.id, job.claim_token, this.now()).changes;
    if (!changed) throw Object.assign(fail('本次处理已由另一工作进程接管', 409), {leaseLost: true});
  }

  heartbeat(job) { this.update(job, 'UPDATE collector_inbox SET lease_until=?,updated_at=?', [this.now() + 120000, this.now()]); }

  bind(job, userId) {
    if (job.user_id && job.user_id !== userId) throw fail('员工身份绑定发生变化，请管理员核对后重新发送', 403);
    this.update(job, 'UPDATE collector_inbox SET user_id=?,lease_until=?,updated_at=?', [userId, this.now() + 120000, this.now()]);
    job.user_id = userId;
  }
  preference(job) { return this.db.prepare('SELECT scope_id FROM collector_preferences WHERE app_id=? AND external_id=? AND user_id=?').get(job.app_id, job.external_id, job.user_id)?.scope_id; }
  select(job, scopeId) {
    this.assertLease(job);
    this.db.prepare(`INSERT INTO collector_preferences VALUES(?,?,?,?) ON CONFLICT(app_id,external_id,user_id)
      DO UPDATE SET scope_id=excluded.scope_id`).run(job.app_id, job.external_id, job.user_id, scopeId);
  }
  conversation(job, scopeIds) {
    return this.db.prepare('SELECT conversation_id FROM collector_conversations WHERE app_id=? AND external_id=? AND user_id=? AND scope_key=?')
      .get(job.app_id, job.external_id, job.user_id, JSON.stringify([...scopeIds].sort()))?.conversation_id;
  }
  rememberConversation(job, scopeIds, id) {
    this.assertLease(job);
    this.db.prepare(`INSERT INTO collector_conversations VALUES(?,?,?,?,?) ON CONFLICT(app_id,external_id,user_id,scope_key)
      DO UPDATE SET conversation_id=excluded.conversation_id`).run(job.app_id, job.external_id, job.user_id, JSON.stringify([...scopeIds].sort()), id);
  }
  setInput(job, input) {
    this.update(job, 'UPDATE collector_inbox SET input=?,lease_until=?,updated_at=?', [JSON.stringify(input), this.now() + 120000, this.now()]);
    job.input = JSON.stringify(input);
  }
  setOutput(job, output) {
    const serialized = JSON.stringify(output);
    const old = this.get(job.id);
    this.update(job, 'UPDATE collector_inbox SET output=?,sent_count=?,lease_until=?,updated_at=?',
      [serialized, old.output === serialized ? old.sent_count : 0, this.now() + 120000, this.now()]);
    return this.get(job.id);
  }
  sent(job, count) { this.update(job, 'UPDATE collector_inbox SET sent_count=?,lease_until=?,updated_at=?', [count, this.now() + 120000, this.now()]); }
  finish(job, dead = false, reason = null) {
    this.update(job, 'UPDATE collector_inbox SET status=?,text=NULL,input=NULL,output=NULL,lease_until=0,claim_token=NULL,last_error=?,updated_at=?',
      [dead ? 'dead' : 'done', reason, this.now()]);
  }
  retry(job, reason) {
    if (job.attempts >= this.maxAttempts) return this.finish(job, true, reason);
    const delay = Math.min(60000, 1000 * 2 ** Math.min(job.attempts, 6));
    this.update(job, "UPDATE collector_inbox SET status='pending',lease_until=0,claim_token=NULL,next_at=?,last_error=?,updated_at=?",
      [this.now() + delay, reason, this.now()]);
  }
  close() { this.db.close(); }
}
