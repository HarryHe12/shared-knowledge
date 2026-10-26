import {createHash, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';

const fail = (code, status = 403) => Object.assign(new Error(code), {status});
const digest = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit = 128) => typeof value === 'string' && value.length > 0 && value.length <= limit && value.trim() === value;
const has = (db, table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));

// Explicit deployment migration only. Constructing the service never performs DDL.
export function upgradeFederation(db) {
  db.exec('SAVEPOINT federation_upgrade');
  try { db.exec(`CREATE TABLE IF NOT EXISTS federation_identities (
    app_id TEXT NOT NULL REFERENCES channel_apps(id), subject_hash TEXT NOT NULL,
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id), company_id TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), PRIMARY KEY(app_id,subject_hash)
  );
  CREATE TABLE IF NOT EXISTS federation_scopes (
    user_id TEXT NOT NULL REFERENCES federation_identities(user_id), scope_id TEXT NOT NULL REFERENCES org_scopes(scope_id),
    PRIMARY KEY(user_id,scope_id)
  );
  CREATE TABLE IF NOT EXISTS federation_requests (
    app_id TEXT NOT NULL REFERENCES channel_apps(id), request_hash TEXT NOT NULL,
    expires INTEGER NOT NULL, PRIMARY KEY(app_id,request_hash)
  );`);
  db.exec('RELEASE federation_upgrade');
  } catch (error) { db.exec('ROLLBACK TO federation_upgrade; RELEASE federation_upgrade'); throw error; }
}

export function federationIdentity(db, userId) {
  return has(db, 'federation_identities') ? db.prepare('SELECT * FROM federation_identities WHERE user_id=?').get(userId) : undefined;
}

function config(env, appId) {
  let data;
  try {
    if (env.TEAM_FEDERATION_CONFIG_JSON && env.TEAM_FEDERATION_CONFIG_FILE) throw Error();
    data = JSON.parse(env.TEAM_FEDERATION_CONFIG_JSON || (env.TEAM_FEDERATION_CONFIG_FILE ? readFileSync(env.TEAM_FEDERATION_CONFIG_FILE, 'utf8') : '{}'));
  } catch { throw fail('federation_invalid_config', 503); }
  const row = object(data?.apps) && data.apps[appId];
  if (!object(row) || !['company_id','tenant_id','brand_id','operator_user_id'].every(k => text(row[k])) || !object(row.stores) || !Object.keys(row.stores).length) throw fail('federation_not_configured', 503);
  return row;
}

function checkedScope(db, policy, app, scopeId) {
  const row = db.prepare(`SELECT s.* FROM org_scopes s JOIN org_tenants t ON t.id=s.tenant_id
    JOIN org_brands b ON b.id=s.brand_id AND b.tenant_id=s.tenant_id
    JOIN org_stores l ON l.id=s.store_id AND l.tenant_id=s.tenant_id AND l.brand_id=s.brand_id
    WHERE s.scope_id=? AND s.active=1 AND t.active=1 AND b.active=1 AND l.active=1`).get(scopeId);
  if (!row || row.tenant_id !== policy.tenant_id || row.brand_id !== policy.brand_id || row.level !== 'staff' || row.audience !== 'staff' ||
      app.tenant_id !== row.tenant_id || app.brand_id !== row.brand_id || app.store_id && app.store_id !== row.store_id) throw fail('federation_scope_not_allowed');
  return row;
}

/** Independent hard ceiling: even extra owner/grant rows cannot broaden a federated user. */
export function federationRole(store, user, scope) {
  const identity = federationIdentity(store.db, user?.id);
  if (!identity) return undefined;
  if (!identity.active || user?.channel_app_id !== identity.app_id) return null;
  const db = store.db;
  try {
    const policy = config(store.federationEnv || process.env, identity.app_id);
    const app = db.prepare('SELECT * FROM channel_apps WHERE id=? AND enabled=1').get(identity.app_id);
    if (!app || app.channel !== 'agent' || app.audience !== 'staff' || policy.company_id !== identity.company_id ||
        !Object.values(policy.stores).includes(scope.id)) return null;
    if (!db.prepare('SELECT 1 FROM org_memberships WHERE user_id=? AND tenant_id=? AND active=1').get(user.id,policy.tenant_id)) return null;
    checkedScope(db, policy, app, scope.id);
    return db.prepare('SELECT 1 FROM federation_scopes WHERE user_id=? AND scope_id=?').get(user.id, scope.id) ? 'writer' : null;
  } catch { return null; }
}

export class Federation {
  constructor(channels, {env = process.env, now = Date.now} = {}) {
    this.channels = channels; this.store = channels.store; this.db = channels.db; this.env = env; this.now = now;
    this.store.federationEnv = env;
  }
  assertIdentity(app,user) {
    const identity=federationIdentity(this.db,user.id);
    if(!identity)return;
    const policy=config(this.env,app.id);
    if(!identity.active||identity.app_id!==app.id||identity.company_id!==policy.company_id||app.channel!=='agent'||app.tenant_id!==policy.tenant_id||app.brand_id!==policy.brand_id)
      throw fail('federation_identity_disabled');
  }
  federate(appId, bearer, input) {
    if (!has(this.db, 'federation_identities') || !has(this.db, 'federation_scopes') || !has(this.db, 'federation_requests')) throw fail('federation_schema_not_ready', 503);
    const app = this.channels.activeApp(appId), policy = config(this.env, appId);
    if (app.channel !== 'agent' || app.tenant_id !== policy.tenant_id || app.brand_id !== policy.brand_id || !app.brand_id) throw fail('federation_app_not_allowed');
    const expected = app.secret_env && this.env[app.secret_env];
    if (!text(expected, 8192) || expected.length < 24 || typeof bearer !== 'string' || !timingSafeEqual(Buffer.from(digest(expected)), Buffer.from(digest(bearer)))) throw fail('federation_unauthorized', 401);
    if (!object(input) || Object.keys(input).some(k => !['subject','company_id','role','store_keys','name','issued_at','request_id'].includes(k)) ||
        !text(input.subject, 256) || !text(input.company_id) || input.company_id !== policy.company_id || !['owner','staff','clerk'].includes(input.role) ||
        !Array.isArray(input.store_keys) || !input.store_keys.length || input.store_keys.length > 40 || new Set(input.store_keys).size !== input.store_keys.length ||
        input.store_keys.some(key => !text(key) || ['all','cw'].includes(key) || !Object.prototype.hasOwnProperty.call(policy.stores, key)) ||
        input.role !== 'owner' && input.store_keys.length !== 1 || !Number.isInteger(input.issued_at) || Math.abs(Math.floor(this.now()/1000) - input.issued_at) > 60 ||
        !text(input.request_id) || !/^[A-Za-z0-9_-]{8,128}$/.test(input.request_id) || input.name !== undefined && !text(input.name, 80)) throw fail('federation_invalid_assertion', 400);
    const operator = this.channels.currentUser(policy.operator_user_id);
    if (!operator || this.channels.organization.membership(operator.id, policy.tenant_id)?.role !== 'owner') throw fail('federation_operator_unavailable');
    const scopes = input.store_keys.map(key => { const id = policy.stores[key]; if (!text(id)) throw fail('federation_invalid_config', 503); checkedScope(this.db, policy, app, id); return id; });
    const subjectHash = digest(input.subject), requestHash = digest(input.request_id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM federation_requests WHERE expires<?').run(this.now());
      if (this.db.prepare('SELECT 1 FROM federation_requests WHERE app_id=? AND request_hash=?').get(appId,requestHash)) throw fail('federation_assertion_replayed', 409);
      this.db.prepare('INSERT INTO federation_requests VALUES(?,?,?)').run(appId,requestHash,this.now()+300000);
      let identity = this.db.prepare('SELECT * FROM federation_identities WHERE app_id=? AND subject_hash=?').get(appId,subjectHash);
      if (identity && (!identity.active || identity.company_id !== policy.company_id || !this.channels.currentUser(identity.user_id) || !this.channels.organization.membership(identity.user_id,policy.tenant_id))) throw fail('federation_identity_disabled');
      if (!identity) {
        const id = randomUUID(), name = input.name || '小程序员工';
        this.db.prepare('INSERT INTO users VALUES(?,?,?)').run(id,name,digest(randomBytes(32)));
        this.db.prepare('INSERT INTO accounts(user_id,email,department,reason,password,status,admin) VALUES(?,?,?,?,?,?,0)').run(id,id+'@federated.invalid','受信入口','现有小程序身份','external-only','approved');
        this.db.prepare("INSERT INTO org_memberships VALUES(?,?,'member',1)").run(policy.tenant_id,id);
        this.db.prepare('INSERT INTO federation_identities VALUES(?,?,?,?,1)').run(appId,subjectHash,id,policy.company_id);
        identity = {user_id:id};
        this.db.prepare('INSERT INTO channel_bindings VALUES(?,?,?,?,?,?)').run(appId,subjectHash,id,1,operator.id,new Date(this.now()).toISOString());
      } else {
        const binding=this.db.prepare('SELECT * FROM channel_bindings WHERE app_id=? AND external_id=?').get(appId,subjectHash);
        if (!binding?.active || binding.user_id !== identity.user_id) throw fail('federation_identity_disabled');
      }
      this.db.prepare('DELETE FROM federation_scopes WHERE user_id=?').run(identity.user_id);
      for (const id of scopes) this.db.prepare('INSERT INTO federation_scopes VALUES(?,?)').run(identity.user_id,id);
      this.db.prepare('DELETE FROM channel_sessions WHERE user_id=?').run(identity.user_id);
      this.channels.auth.audit(operator.id,'federate-sync',JSON.stringify({app_id:appId,user_id:identity.user_id,scopes,role:input.role}));
      this.db.exec('UPDATE record_epoch SET value=value+1');
      const result = this.channels.issue(appId,subjectHash);
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
