import {createHash, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {Organization} from './organization.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), {status});
const digest = value => createHash('sha256').update(value).digest('hex');
const channels = new Set(['miniapp', 'wecom', 'agent']);
const lifetime = 60 * 60;

function text(value, label, limit = 128) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw fail(`${label}无效`);
  return value.trim();
}

function flag(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw fail('enabled/active 须为布尔值');
  return value ? 1 : 0;
}

/** External applications restrict an employee's current grants; they never grant employment. */
export class Channels {
  constructor(store, auth, {fetchImpl = fetch, organization} = {}) {
    this.store = store;
    this.db = store.db;
    this.auth = auth;
    this.organization = organization ?? auth.organization ?? new Organization(store);
    this.fetch = fetchImpl;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_apps (
        id TEXT PRIMARY KEY, name TEXT NOT NULL,
        channel TEXT NOT NULL CHECK(channel IN ('miniapp','wecom','agent')),
        tenant_id TEXT NOT NULL REFERENCES org_tenants(id), brand_id TEXT, store_id TEXT,
        external_app_id TEXT, secret_env TEXT,
        audience TEXT NOT NULL DEFAULT 'staff' CHECK(audience='staff'),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
        FOREIGN KEY(tenant_id,brand_id) REFERENCES org_brands(tenant_id,id),
        FOREIGN KEY(tenant_id,brand_id,store_id) REFERENCES org_stores(tenant_id,brand_id,id),
        CHECK(store_id IS NULL OR brand_id IS NOT NULL)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS channel_external_app ON channel_apps(channel,external_app_id)
        WHERE external_app_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS channel_bindings (
        app_id TEXT NOT NULL REFERENCES channel_apps(id), external_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id), active INTEGER NOT NULL CHECK(active IN (0,1)),
        verified_by TEXT NOT NULL REFERENCES users(id), verified_at TEXT NOT NULL,
        PRIMARY KEY(app_id,external_id)
      );
      CREATE TABLE IF NOT EXISTS channel_sessions (
        hash TEXT PRIMARY KEY, app_id TEXT NOT NULL, external_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(app_id,external_id) REFERENCES channel_bindings(app_id,external_id)
      );
      CREATE INDEX IF NOT EXISTS channel_sessions_binding ON channel_sessions(app_id,external_id);
    `);
  }

  app(id) {
    return this.db.prepare('SELECT * FROM channel_apps WHERE id=?').get(id);
  }

  publicApp(app) {
    if (!app) return undefined;
    const credential = app.secret_env && process.env[app.secret_env];
    return {...app, configured: Boolean(credential && (app.channel === 'miniapp'
      ? app.external_app_id : credential.length >= 24))};
  }

  currentUser(id) {
    return this.db.prepare(`SELECT u.id,u.name,a.status,a.admin FROM users u
      JOIN accounts a ON a.user_id=u.id WHERE u.id=? AND a.status='approved'`).get(id);
  }

  requireManager(user, tenantId) {
    if (user?.channel_app_id) throw fail('接入应用会话不能管理组织或接入配置', 403);
    this.organization.requireManager(user, tenantId);
  }

  activeApp(id) {
    const app = this.app(id);
    if (!app?.enabled || app.audience !== 'staff') throw fail('接入应用不可用', 403);
    this.organization.tenant(app.tenant_id);
    if (app.brand_id) this.organization.brand(app.tenant_id, app.brand_id);
    if (app.store_id) this.organization.location(app.tenant_id, app.store_id);
    return app;
  }

  assertScope(app, user, scopeId, write = false) {
    const current = this.activeApp(typeof app === 'string' ? app : app?.id);
    if (user?.channel_app_id && user.channel_app_id !== current.id) throw fail('接入会话与应用不匹配', 403);
    const scope = this.organization.context(scopeId);
    if (!scope || scope.tenant_id !== current.tenant_id ||
      current.brand_id && scope.brand_id !== current.brand_id ||
      current.store_id && scope.store_id !== current.store_id) throw fail('范围不属于此接入应用', 403);
    this.organization.authorize(user, scopeId, write);
    return scope;
  }

  overview(user, tenantId) {
    if (user?.channel_app_id) throw fail('接入应用会话不能读取管理配置', 403);
    const account = this.currentUser(user?.id);
    if (!account) throw fail('账号尚未获准使用', 403);
    if (tenantId) this.requireManager(user, tenantId);
    const apps = this.db.prepare('SELECT * FROM channel_apps ORDER BY name,id').all()
      .filter(app => (!tenantId || app.tenant_id === tenantId) && this.organization.canManage(user, app.tenant_id));
    const allowed = new Set(apps.map(app => app.id));
    return {
      apps: apps.map(app => this.publicApp(app)),
      bindings: this.db.prepare('SELECT * FROM channel_bindings ORDER BY verified_at').all().filter(row => allowed.has(row.app_id)),
      sessions: this.db.prepare(`SELECT hash,app_id,user_id,expires,created_at FROM channel_sessions
        WHERE expires>? ORDER BY created_at`).all(Date.now()).filter(row => allowed.has(row.app_id)),
    };
  }

  manage(user, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('管理请求须为对象');
    let app;
    if (input.action === 'app') {
      app = input.id ? this.app(input.id) : undefined;
      if (input.id && !app) throw fail('接入应用不存在', 404);
      this.requireManager(user, app?.tenant_id ?? input.tenant_id);
    } else if (input.action === 'binding') {
      app = this.app(input.app_id);
      if (!app) throw fail('接入应用不存在', 404);
      this.requireManager(user, app.tenant_id);
    } else if (input.action === 'revoke') {
      if (Object.keys(input).some(key => !['action','id'].includes(key))) throw fail('会话撤销包含不支持的字段');
      const session = this.db.prepare('SELECT app_id FROM channel_sessions WHERE hash=?').get(text(input.id, '会话'));
      if (!session) throw fail('接入会话不存在', 404);
      app = this.app(session.app_id);
      this.requireManager(user, app.tenant_id);
    } else throw fail('未知接入管理操作');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      let result;
      if (input.action === 'app') result = this.manageApp(input, app);
      else if (input.action === 'binding') result = this.manageBinding(user, input, app);
      else {
        this.db.prepare('DELETE FROM channel_sessions WHERE hash=?').run(input.id);
        result = {ok: true};
      }
      const audit = {...input};
      // Binding metadata is auditable; supplied credential values are never accepted or recorded.
      this.auth.audit(user.id, 'channel:' + input.action, JSON.stringify(audit));
      this.db.exec('UPDATE record_epoch SET value=value+1');
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (/UNIQUE constraint failed/.test(error.message)) throw fail('该外部应用已登记', 409);
      throw error;
    }
  }

  manageApp(input, old) {
    const allowed = new Set(['action','id','name','channel','tenant_id','brand_id','store_id','external_app_id','secret_env','audience','enabled']);
    if (Object.keys(input).some(key => !allowed.has(key))) throw fail('接入配置包含不支持的字段；凭据仅通过环境变量配置');
    for (const key of ['tenant_id', 'brand_id', 'store_id', 'channel', 'external_app_id']) {
      if (old && input[key] !== undefined && (input[key] || null) !== old[key]) throw fail('接入应用的归属和外部身份不可更改，请另建应用');
    }
    const app = {...old, id: old?.id ?? randomUUID(), name: text(input.name ?? old?.name, '名称', 80),
      channel: input.channel ?? old?.channel, tenant_id: input.tenant_id ?? old?.tenant_id,
      brand_id: input.brand_id ?? old?.brand_id ?? null, store_id: input.store_id ?? old?.store_id ?? null,
      external_app_id: input.external_app_id ?? old?.external_app_id ?? null,
      secret_env: input.secret_env ?? old?.secret_env ?? null,
      audience: input.audience ?? old?.audience ?? 'staff', enabled: flag(input.enabled, old?.enabled ?? 0)};
    if (!channels.has(app.channel) || app.audience !== 'staff') throw fail('仅支持员工专用的 miniapp/wecom/agent 接入');
    this.organization.tenant(app.tenant_id);
    if (app.store_id) {
      const location = this.organization.location(app.tenant_id, app.store_id);
      if (app.brand_id && location.brand_id !== app.brand_id) throw fail('门店不属于所选品牌');
      app.brand_id = location.brand_id;
    }
    if (app.brand_id) this.organization.brand(app.tenant_id, app.brand_id);
    if (app.external_app_id !== null) app.external_app_id = text(app.external_app_id, '外部应用标识');
    if (app.channel === 'miniapp' && app.external_app_id !== null && !/^wx[a-zA-Z0-9]{8,64}$/.test(app.external_app_id)) throw fail('微信小程序 AppID 无效');
    if (app.secret_env !== null && (typeof app.secret_env !== 'string' || !/^[A-Z][A-Z0-9_]{2,127}$/.test(app.secret_env))) throw fail('secret_env 必须是环境变量名称');
    if (app.enabled && !this.publicApp(app).configured) throw fail('请先在服务端配置应用凭据再启用', 409);
    this.db.prepare(`INSERT INTO channel_apps VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id)
      DO UPDATE SET name=excluded.name,secret_env=excluded.secret_env,enabled=excluded.enabled`)
      .run(app.id,app.name,app.channel,app.tenant_id,app.brand_id,app.store_id,app.external_app_id,app.secret_env,app.audience,app.enabled);
    if (old && (!app.enabled || old.secret_env !== app.secret_env)) this.db.prepare('DELETE FROM channel_sessions WHERE app_id=?').run(app.id);
    return this.publicApp(app);
  }

  manageBinding(user, input, app) {
    const allowed = new Set(['action','app_id','external_id','user_id','verified','active']);
    if (Object.keys(input).some(key => !allowed.has(key))) throw fail('员工绑定包含不支持的字段');
    const externalId = text(input.external_id, '外部员工标识', 256);
    const active = flag(input.active, 1);
    const old = this.db.prepare('SELECT * FROM channel_bindings WHERE app_id=? AND external_id=?').get(app.id, externalId);
    const userId = input.user_id ?? old?.user_id;
    if ((active || !old) && (!this.currentUser(userId) || !this.organization.membership(userId, app.tenant_id))) throw fail('请选择本公司已审核且在职的员工');
    if (!active && old && userId !== old.user_id) throw fail('停用绑定时不能更换员工');
    if (active && input.verified !== true) throw fail('请先核实外部身份属于该员工，再显式 verified:true');
    const result = {app_id: app.id, external_id: externalId, user_id: userId, active,
      verified_by: user.id, verified_at: new Date().toISOString()};
    this.db.prepare(`INSERT INTO channel_bindings VALUES(?,?,?,?,?,?) ON CONFLICT(app_id,external_id)
      DO UPDATE SET user_id=excluded.user_id,active=excluded.active,verified_by=excluded.verified_by,verified_at=excluded.verified_at`)
      .run(result.app_id,result.external_id,result.user_id,result.active,result.verified_by,result.verified_at);
    this.db.prepare('DELETE FROM channel_sessions WHERE app_id=? AND external_id=?').run(app.id,externalId);
    return result;
  }

  resolve(appId, externalId) {
    const app = this.activeApp(appId);
    const binding = this.db.prepare(`SELECT * FROM channel_bindings WHERE app_id=? AND external_id=? AND active=1`)
      .get(app.id, text(externalId, '外部员工标识', 256));
    const user = binding && this.currentUser(binding.user_id);
    if (!user || !this.organization.membership(user.id, app.tenant_id)) throw fail('此身份尚未绑定本公司获准使用的员工', 403);
    return {app, user, binding};
  }

  issue(appId, externalId) {
    externalId = text(externalId,'外部员工标识',256);
    const {app,user,binding} = this.resolve(appId,externalId);
    const token = 'kbch_' + randomBytes(32).toString('base64url');
    this.db.prepare('DELETE FROM channel_sessions WHERE expires<=?').run(Date.now());
    this.db.prepare('INSERT INTO channel_sessions VALUES(?,?,?,?,?,?)')
      .run(digest(token),app.id,externalId,user.id,Date.now()+lifetime*1000,new Date().toISOString());
    return {token,expires_in:lifetime,identity_verified_at:binding.verified_at,user:{id:user.id,name:user.name},app:this.publicApp(app)};
  }

  authenticate(token) {
    if (typeof token !== 'string' || !/^kbch_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const session = this.db.prepare('SELECT * FROM channel_sessions WHERE hash=? AND expires>?').get(digest(token),Date.now());
    if (!session) return null;
    try {
      const {app,user} = this.resolve(session.app_id,session.external_id);
      if (user.id !== session.user_id) return null;
      return {app,user:{...user,channel_app_id:app.id,channel_session_hash:session.hash},session_hash:session.hash,token_type:'channel'};
    } catch {
      this.db.prepare('DELETE FROM channel_sessions WHERE hash=?').run(session.hash);
      return null;
    }
  }

  revoke(token) {
    if (typeof token === 'string') this.db.prepare('DELETE FROM channel_sessions WHERE hash=?').run(digest(token));
    return {ok:true};
  }

  bridge(appId, bearer, externalId) {
    const app = this.activeApp(appId);
    if (!['wecom','agent'].includes(app.channel)) throw fail('此应用不支持服务端桥接登录',403);
    const expected = app.secret_env && process.env[app.secret_env];
    if (!expected || expected.length<24 || typeof bearer!=='string' ||
      !timingSafeEqual(Buffer.from(digest(expected)),Buffer.from(digest(bearer)))) throw fail('接入桥接凭据无效',401);
    return this.issue(app.id,text(externalId,'外部员工标识',256));
  }

  async login(code, appId) {
    const app = this.activeApp(appId);
    if (app.channel !== 'miniapp') throw fail('此应用不支持小程序登录',403);
    const secret = app.secret_env && process.env[app.secret_env];
    if (!secret || !app.external_app_id) throw fail('小程序登录尚未配置',503);
    const requestCode = text(code,'微信临时登录凭证',256);
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.search = new URLSearchParams({appid:app.external_app_id,secret,js_code:requestCode,grant_type:'authorization_code'});
    let data;
    try {
      const response = await this.fetch(url, {method:'GET',redirect:'error',signal:AbortSignal.timeout(15000)});
      if (!response.ok) throw new Error('upstream');
      data = await response.json();
    } catch { throw fail('微信登录服务暂时不可用，请重试',502); }
    if (!data || typeof data !== 'object' || data.errcode || typeof data.openid!=='string' || !data.openid || data.openid.length>256) throw fail('微信登录凭证无效或已过期',401);
    // session_key/unionid never become employee authorization or leave this method.
    return this.issue(app.id,data.openid);
  }
}
