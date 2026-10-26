import {randomUUID} from 'node:crypto';
import {federationRole} from './federation.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), {status});
const levels = new Set(['staff', 'management', 'executive']);
const assignmentRoles = new Set(['staff', 'store_manager', 'brand_manager']);

function nameOf(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 80) throw fail('名称须为1—80字符');
  return value.trim();
}

function activeOf(value, fallback = 1) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw fail('active 须为布尔值');
  return value ? 1 : 0;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !value || value.length > 100) throw fail(label + '无效');
  return value;
}

/**
 * Company/brand/store ownership is separate from business projects and scope ACLs.
 * Legacy scopes remain unbound and retain their existing explicit grants.
 * New scopes require current employment, then an explicit grant or matching role.
 */
export class Organization {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS org_tenants (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS org_brands (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES org_tenants(id),
        name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
        UNIQUE(tenant_id,id), UNIQUE(tenant_id,name)
      );
      CREATE TABLE IF NOT EXISTS org_stores (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, brand_id TEXT NOT NULL,
        name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
        FOREIGN KEY(tenant_id,brand_id) REFERENCES org_brands(tenant_id,id),
        UNIQUE(tenant_id,id), UNIQUE(tenant_id,brand_id,id), UNIQUE(tenant_id,brand_id,name)
      );
      CREATE TABLE IF NOT EXISTS org_memberships (
        tenant_id TEXT NOT NULL REFERENCES org_tenants(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        role TEXT NOT NULL CHECK(role IN ('owner','member')),
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
        PRIMARY KEY(tenant_id,user_id)
      );
      CREATE TABLE IF NOT EXISTS org_assignments (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
        brand_id TEXT NOT NULL, store_id TEXT,
        role TEXT NOT NULL CHECK(role IN ('staff','store_manager','brand_manager')),
        FOREIGN KEY(tenant_id,user_id) REFERENCES org_memberships(tenant_id,user_id),
        FOREIGN KEY(tenant_id,brand_id) REFERENCES org_brands(tenant_id,id),
        FOREIGN KEY(tenant_id,brand_id,store_id) REFERENCES org_stores(tenant_id,brand_id,id),
        CHECK((role='brand_manager' AND store_id IS NULL) OR (role IN ('staff','store_manager') AND store_id IS NOT NULL))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS org_assignments_identity ON org_assignments(
        tenant_id,user_id,brand_id,COALESCE(store_id,''),role
      );
      CREATE TABLE IF NOT EXISTS org_scopes (
        scope_id TEXT PRIMARY KEY REFERENCES projects(id),
        tenant_id TEXT NOT NULL REFERENCES org_tenants(id), brand_id TEXT, store_id TEXT,
        level TEXT NOT NULL CHECK(level IN ('staff','management','executive')),
        audience TEXT NOT NULL DEFAULT 'staff' CHECK(audience='staff'),
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
        FOREIGN KEY(tenant_id,brand_id) REFERENCES org_brands(tenant_id,id),
        FOREIGN KEY(tenant_id,brand_id,store_id) REFERENCES org_stores(tenant_id,brand_id,id),
        CHECK(store_id IS NULL OR brand_id IS NOT NULL)
      );
      CREATE INDEX IF NOT EXISTS org_scopes_tenant ON org_scopes(tenant_id,brand_id,store_id);
      CREATE INDEX IF NOT EXISTS org_assignments_user ON org_assignments(user_id,tenant_id);
    `);
  }

  account(user) {
    if (!user?.id) return undefined;
    return this.db.prepare('SELECT status,admin FROM accounts WHERE user_id=?').get(user.id);
  }

  membership(userId, tenantId) {
    return this.db.prepare(`SELECT m.* FROM org_memberships m JOIN org_tenants t ON t.id=m.tenant_id
      WHERE m.user_id=? AND m.tenant_id=? AND m.active=1 AND t.active=1`).get(userId, tenantId);
  }

  canManage(user, tenantId) {
    if (user?.channel_app_id) return false;
    const account = this.account(user);
    if (account?.status !== 'approved') return false;
    return Boolean(account.admin || (tenantId && this.membership(user.id, tenantId)?.role === 'owner'));
  }

  requireManager(user, tenantId) {
    if (!this.canManage(user, tenantId)) throw fail('无此公司的管理权限', 403);
  }

  assertManage(user, tenantId) {
    this.requireManager(user, tenantId);
    return true;
  }

  isManaged(scopeId) {
    return Boolean(this.db.prepare('SELECT 1 FROM org_scopes WHERE scope_id=?').get(scopeId));
  }

  context(scopeId) {
    return this.db.prepare(`SELECT s.scope_id AS id,p.name,s.tenant_id,s.brand_id,s.store_id,s.level,s.audience,s.active
      FROM org_scopes s JOIN projects p ON p.id=s.scope_id WHERE s.scope_id=?`).get(scopeId);
  }

  scope(scopeId) {
    return this.context(scopeId);
  }

  scopeActive(scope) {
    const tenant = this.db.prepare('SELECT active FROM org_tenants WHERE id=?').get(scope.tenant_id);
    if (!scope.active || !tenant?.active) return false;
    if (scope.brand_id && !this.db.prepare('SELECT 1 FROM org_brands WHERE id=? AND tenant_id=? AND active=1').get(scope.brand_id, scope.tenant_id)) return false;
    if (scope.store_id && !this.db.prepare('SELECT 1 FROM org_stores WHERE id=? AND tenant_id=? AND brand_id=? AND active=1').get(scope.store_id, scope.tenant_id, scope.brand_id)) return false;
    return true;
  }

  /** Returns a role, rather than allowing platform administration to imply data access. */
  role(user, scope) {
    if (this.account(user)?.status !== 'approved' || !this.scopeActive(scope)) return null;
    const ceiling = federationRole(this.store, user, scope);
    if (ceiling !== undefined) return ceiling;
    const member = this.membership(user.id, scope.tenant_id);
    if (!member || scope.audience !== 'staff') return null;
    if (member.role === 'owner') return 'writer';
    const explicit = this.db.prepare('SELECT role FROM scope_grants WHERE user_id=? AND scope_id=?').get(user.id, scope.id);
    if (explicit) return explicit.role;
    if (scope.level === 'executive') return null;
    if (!scope.brand_id) return scope.level === 'staff' ? 'reader' : null;

    const assignments = this.db.prepare(`SELECT a.* FROM org_assignments a
      JOIN org_brands b ON b.id=a.brand_id AND b.tenant_id=a.tenant_id AND b.active=1
      LEFT JOIN org_stores s ON s.id=a.store_id AND s.tenant_id=a.tenant_id
      WHERE a.user_id=? AND a.tenant_id=? AND a.brand_id=? AND (a.store_id IS NULL OR s.active=1)`)
      .all(user.id, scope.tenant_id, scope.brand_id);
    if (assignments.some(a => a.role === 'brand_manager')) return 'writer';
    if (!scope.store_id) return scope.level === 'staff' && assignments.length ? 'reader' : null;
    const local = assignments.filter(a => a.store_id === scope.store_id);
    if (local.some(a => a.role === 'store_manager')) return 'writer';
    return scope.level === 'staff' && local.some(a => a.role === 'staff') ? 'writer' : null;
  }

  authorize(user, scopeId, write = false) {
    const scope = this.context(scopeId);
    const role = scope && this.role(user, scope);
    if (!role || (write && role !== 'writer')) throw fail('无此范围的操作权限', 403);
    return true;
  }

  scopes(user) {
    if (this.account(user)?.status !== 'approved') return [];
    return this.db.prepare(`SELECT s.scope_id AS id,p.name,s.tenant_id,s.brand_id,s.store_id,s.level,s.audience,s.active
      FROM org_scopes s JOIN projects p ON p.id=s.scope_id ORDER BY p.name,s.scope_id`).all()
      .map(scope => ({...scope, role: this.role(user, scope)})).filter(scope => scope.role);
  }

  tenant(tenantId, active = true) {
    const row = this.db.prepare('SELECT * FROM org_tenants WHERE id=?').get(tenantId);
    if (!row || (active && !row.active)) throw fail('公司不存在或已停用', 404);
    return row;
  }

  brand(tenantId, brandId, active = true) {
    const row = this.db.prepare('SELECT * FROM org_brands WHERE id=? AND tenant_id=?').get(brandId, tenantId);
    if (!row || (active && !row.active)) throw fail('品牌不存在或不属于此公司', 400);
    return row;
  }

  location(tenantId, storeId, active = true) {
    const row = this.db.prepare('SELECT * FROM org_stores WHERE id=? AND tenant_id=?').get(storeId, tenantId);
    if (!row || (active && !row.active)) throw fail('门店不存在或不属于此公司', 400);
    this.brand(tenantId, row.brand_id, active);
    return row;
  }

  audit(user, input) {
    this.db.prepare('INSERT INTO access_audit(actor,action,target,at) VALUES(?,?,?,?)')
      .run(user.id, 'organization:' + input.action, JSON.stringify(input), new Date().toISOString());
    this.db.exec('UPDATE record_epoch SET value=value+1');
  }

  revokeChannelSessions(userId, tenantId) {
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('channel_apps','channel_sessions')").all();
    if (tables.length !== 2) return;
    this.db.prepare(`DELETE FROM channel_sessions WHERE user_id=? AND app_id IN (
      SELECT id FROM channel_apps WHERE tenant_id=?)`).run(userId, tenantId);
  }

  /**
   * actions: tenant{name}, brand{tenant_id,name}, store{tenant_id,brand_id,name},
   * member{tenant_id,user_id,role,active?}, assignment{tenant_id,user_id,role,brand_id?|store_id?,active?},
   * scope{tenant_id,name,brand_id?,store_id?,level,audience?}. Entity id updates only name/active;
   * scopes cannot be rebound to another company, brand, store or clearance level.
   */
  manage(user, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('管理请求须为对象');
    const action = input.action;
    if (!['tenant', 'brand', 'store', 'member', 'assignment', 'scope'].includes(action)) throw fail('未知组织管理操作');
    for (const key of ['id', 'tenant_id', 'brand_id', 'store_id', 'user_id']) {
      if (input[key] !== undefined && input[key] !== null) identifier(input[key], key);
    }
    if (action !== 'tenant') identifier(input.tenant_id, '公司编号');
    if (['member', 'assignment'].includes(action)) identifier(input.user_id, '员工编号');
    const tenantId = action === 'tenant' ? input.id : input.tenant_id;
    this.requireManager(user, tenantId);
    if (action !== 'tenant') this.tenant(tenantId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let result;
      if (action === 'tenant') result = this.manageTenant(user, input);
      else if (action === 'brand') result = this.manageBrand(input);
      else if (action === 'store') result = this.manageStore(input);
      else if (action === 'member') result = this.manageMember(user, input);
      else if (action === 'assignment') result = this.manageAssignment(input);
      else result = this.manageScope(input);
      this.audit(user, input);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (/UNIQUE constraint failed/.test(error.message)) throw fail('同一组织中已存在相同名称或授权', 409);
      throw error;
    }
  }

  manageTenant(user, input) {
    if (!input.id) {
      if (!this.account(user)?.admin) throw fail('只有平台管理员可以创建公司', 403);
      const result = {id: randomUUID(), name: nameOf(input.name), active: activeOf(input.active)};
      this.db.prepare('INSERT INTO org_tenants VALUES(?,?,?)').run(result.id, result.name, result.active);
      return result;
    }
    const old = this.tenant(input.id, false);
    const result = {...old, name: input.name === undefined ? old.name : nameOf(input.name), active: activeOf(input.active, old.active)};
    this.db.prepare('UPDATE org_tenants SET name=?,active=? WHERE id=?').run(result.name, result.active, result.id);
    return result;
  }

  manageBrand(input) {
    if (input.id) {
      const old = this.brand(input.tenant_id, input.id, false);
      const result = {...old, name: input.name === undefined ? old.name : nameOf(input.name), active: activeOf(input.active, old.active)};
      this.db.prepare('UPDATE org_brands SET name=?,active=? WHERE id=?').run(result.name, result.active, result.id);
      return result;
    }
    const result = {id: randomUUID(), tenant_id: input.tenant_id, name: nameOf(input.name), active: activeOf(input.active)};
    this.db.prepare('INSERT INTO org_brands VALUES(?,?,?,?)').run(result.id, result.tenant_id, result.name, result.active);
    return result;
  }

  manageStore(input) {
    if (input.id) {
      const old = this.location(input.tenant_id, input.id, false);
      if (input.brand_id && input.brand_id !== old.brand_id) throw fail('门店不能直接更换所属品牌');
      const result = {...old, name: input.name === undefined ? old.name : nameOf(input.name), active: activeOf(input.active, old.active)};
      this.db.prepare('UPDATE org_stores SET name=?,active=? WHERE id=?').run(result.name, result.active, result.id);
      return result;
    }
    identifier(input.brand_id, '品牌编号');
    this.brand(input.tenant_id, input.brand_id);
    const result = {id: randomUUID(), tenant_id: input.tenant_id, brand_id: input.brand_id, name: nameOf(input.name), active: activeOf(input.active)};
    this.db.prepare('INSERT INTO org_stores VALUES(?,?,?,?,?)').run(result.id, result.tenant_id, result.brand_id, result.name, result.active);
    return result;
  }

  manageMember(user, input) {
    if (!['owner', 'member'].includes(input.role)) throw fail('公司成员角色无效');
    const active = activeOf(input.active);
    const account = this.db.prepare('SELECT status FROM accounts WHERE user_id=?').get(input.user_id);
    if (!account || (active && account.status !== 'approved')) throw fail('请选择已审核通过的员工');
    const old = this.db.prepare('SELECT * FROM org_memberships WHERE tenant_id=? AND user_id=?').get(input.tenant_id, input.user_id);
    if (old?.role === 'owner' && old.active && (!active || input.role !== 'owner')) {
      const owners = this.db.prepare("SELECT count(*) AS n FROM org_memberships WHERE tenant_id=? AND role='owner' AND active=1").get(input.tenant_id).n;
      if (owners === 1 && !this.account(user)?.admin) throw fail('不能移除公司的最后一位负责人', 409);
    }
    this.db.prepare(`INSERT INTO org_memberships VALUES(?,?,?,?) ON CONFLICT(tenant_id,user_id)
      DO UPDATE SET role=excluded.role,active=excluded.active`).run(input.tenant_id, input.user_id, input.role, active);
    if (!active) {
      this.db.prepare('DELETE FROM org_assignments WHERE tenant_id=? AND user_id=?').run(input.tenant_id, input.user_id);
      this.db.prepare('DELETE FROM scope_grants WHERE user_id=? AND scope_id IN (SELECT scope_id FROM org_scopes WHERE tenant_id=?)').run(input.user_id, input.tenant_id);
      this.db.prepare('DELETE FROM members WHERE user_id=? AND project_id IN (SELECT scope_id FROM org_scopes WHERE tenant_id=?)').run(input.user_id, input.tenant_id);
      this.revokeChannelSessions(input.user_id, input.tenant_id);
    }
    return {tenant_id: input.tenant_id, user_id: input.user_id, role: input.role, active};
  }

  manageAssignment(input) {
    if (!assignmentRoles.has(input.role)) throw fail('门店或品牌岗位无效');
    const active = activeOf(input.active);
    const member = this.membership(input.user_id, input.tenant_id);
    if (!member) throw fail('员工尚未加入此公司');
    let brandId = input.brand_id ?? null, storeId = input.store_id ?? null;
    if (input.role === 'brand_manager') {
      if (storeId) throw fail('品牌负责人岗位不指定单一门店');
      this.brand(input.tenant_id, brandId, Boolean(active));
    } else {
      const store = this.location(input.tenant_id, storeId, Boolean(active));
      if (brandId && brandId !== store.brand_id) throw fail('门店不属于指定品牌');
      brandId = store.brand_id;
    }
    const existing = this.db.prepare(`SELECT * FROM org_assignments WHERE tenant_id=? AND user_id=?
      AND brand_id=? AND COALESCE(store_id,'')=COALESCE(?,'') AND role=?`)
      .get(input.tenant_id, input.user_id, brandId, storeId, input.role);
    if (input.id && input.id !== existing?.id) throw fail('岗位授权不存在或不匹配', 404);
    if (!active) {
      if (existing) this.db.prepare('DELETE FROM org_assignments WHERE id=?').run(existing.id);
      this.revokeChannelSessions(input.user_id, input.tenant_id);
      return {...(existing ?? {tenant_id: input.tenant_id, user_id: input.user_id, brand_id: brandId, store_id: storeId, role: input.role}), active: 0};
    }
    if (existing) return {...existing, active: 1};
    const result = {id: randomUUID(), tenant_id: input.tenant_id, user_id: input.user_id, brand_id: brandId, store_id: storeId, role: input.role};
    this.db.prepare('INSERT INTO org_assignments VALUES(?,?,?,?,?,?)').run(result.id, result.tenant_id, result.user_id, result.brand_id, result.store_id, result.role);
    return {...result, active: 1};
  }

  manageScope(input) {
    if (input.id) {
      const old = this.context(input.id);
      if (!old || old.tenant_id !== input.tenant_id) throw fail('知识范围不存在或不属于此公司', 404);
      for (const key of ['brand_id', 'store_id', 'level', 'audience']) {
        if (input[key] !== undefined && input[key] !== old[key]) throw fail('已有知识范围不能更换归属、级别或受众');
      }
      const result = {...old, name: input.name === undefined ? old.name : nameOf(input.name), active: activeOf(input.active, old.active)};
      if (this.db.prepare(`SELECT 1 FROM org_scopes s JOIN projects p ON p.id=s.scope_id WHERE s.tenant_id=?
        AND COALESCE(s.brand_id,'')=COALESCE(?,'') AND COALESCE(s.store_id,'')=COALESCE(?,'') AND p.name=? AND s.scope_id<>?`)
        .get(old.tenant_id, old.brand_id, old.store_id, result.name, old.id)) throw fail('同一组织中已存在相同名称的知识范围', 409);
      this.db.prepare('UPDATE org_scopes SET active=? WHERE scope_id=?').run(result.active, old.id);
      this.db.prepare('UPDATE projects SET name=? WHERE id=?').run(result.name, old.id);
      this.db.prepare('UPDATE access_scopes SET name=? WHERE id=?').run(result.name, old.id);
      return result;
    }
    if (!levels.has(input.level) || (input.audience !== undefined && input.audience !== 'staff')) throw fail('知识范围级别或受众无效');
    let brandId = input.brand_id ?? null;
    const storeId = input.store_id ?? null;
    if (storeId) {
      const store = this.location(input.tenant_id, storeId);
      if (brandId && brandId !== store.brand_id) throw fail('门店不属于指定品牌');
      brandId = store.brand_id;
    } else if (brandId) this.brand(input.tenant_id, brandId);
    const name = nameOf(input.name);
    if (this.db.prepare(`SELECT 1 FROM org_scopes s JOIN projects p ON p.id=s.scope_id WHERE s.tenant_id=?
      AND COALESCE(s.brand_id,'')=COALESCE(?,'') AND COALESCE(s.store_id,'')=COALESCE(?,'') AND p.name=?`)
      .get(input.tenant_id, brandId, storeId, name)) throw fail('同一组织中已存在相同名称的知识范围', 409);
    const result = {id: randomUUID(), name, tenant_id: input.tenant_id, brand_id: brandId, store_id: storeId, level: input.level, audience: 'staff', active: activeOf(input.active)};
    this.db.prepare('INSERT INTO projects VALUES(?,?)').run(result.id, result.name);
    this.db.prepare('INSERT INTO access_scopes VALUES(?,?)').run(result.id, result.name);
    this.db.prepare('INSERT INTO org_scopes VALUES(?,?,?,?,?,?,?)').run(result.id, result.tenant_id, result.brand_id, result.store_id, result.level, result.audience, result.active);
    return result;
  }

  overview(user, tenantId) {
    if (user?.channel_app_id) throw fail('请通过员工账号管理页面操作', 403);
    if (tenantId) this.requireManager(user, tenantId);
    else if (!this.canManage(user)) {
      const owned = this.db.prepare("SELECT tenant_id FROM org_memberships WHERE user_id=? AND role='owner' AND active=1").all(user?.id ?? '');
      if (!owned.length || this.account(user)?.status !== 'approved') throw fail('无公司的管理权限', 403);
    }
    const allowed = tenantId ? [tenantId] : this.canManage(user)
      ? this.db.prepare('SELECT id FROM org_tenants').all().map(t => t.id)
      : this.db.prepare("SELECT m.tenant_id FROM org_memberships m JOIN org_tenants t ON t.id=m.tenant_id WHERE m.user_id=? AND m.role='owner' AND m.active=1 AND t.active=1").all(user.id).map(m => m.tenant_id);
    const allowedSet = new Set(allowed);
    const visible = rows => rows.filter(row => allowedSet.has(row.tenant_id));
    return {
      tenants: this.db.prepare('SELECT * FROM org_tenants ORDER BY name,id').all().filter(t => allowedSet.has(t.id)),
      brands: visible(this.db.prepare('SELECT * FROM org_brands ORDER BY name,id').all()),
      stores: visible(this.db.prepare('SELECT * FROM org_stores ORDER BY name,id').all()),
      memberships: visible(this.db.prepare('SELECT m.*,u.name FROM org_memberships m JOIN users u ON u.id=m.user_id ORDER BY u.name,m.user_id').all()),
      assignments: visible(this.db.prepare('SELECT * FROM org_assignments ORDER BY id').all()),
      scopes: visible(this.db.prepare('SELECT s.scope_id AS id,p.name,s.tenant_id,s.brand_id,s.store_id,s.level,s.audience,s.active FROM org_scopes s JOIN projects p ON p.id=s.scope_id ORDER BY p.name,s.scope_id').all()),
    };
  }
}
