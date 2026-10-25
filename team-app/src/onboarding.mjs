import {createHash, randomBytes, randomUUID} from 'node:crypto';

const fail = (message, status = 400) => Object.assign(new Error(message), {status});
const roles = ['staff', 'store_manager', 'brand_manager'];
const digest = value => createHash('sha256').update(value).digest('hex');

function object(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) {
    throw fail('请求包含无效或不允许的字段');
  }
}
function identifier(value, label) {
  if (typeof value !== 'string' || !value || value.length > 100) throw fail(label + '无效');
  return value;
}
function noteOf(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 500) throw fail('备注最多500字符');
  return value.trim();
}

/** Invitation discovery never grants employment; only a current higher-level reviewer can approve. */
export class Onboarding {
  constructor(store, auth) {
    this.store = store;
    this.db = store.db;
    this.auth = auth;
    this.organization = auth.organization;
    this.now = Date.now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS onboarding_invitations(
        id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,tenant_id TEXT NOT NULL REFERENCES org_tenants(id),
        brand_id TEXT,store_id TEXT,roles TEXT NOT NULL CHECK(json_valid(roles)),
        created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,expires_at INTEGER NOT NULL,revoked_at TEXT,
        FOREIGN KEY(tenant_id,brand_id) REFERENCES org_brands(tenant_id,id),
        FOREIGN KEY(tenant_id,brand_id,store_id) REFERENCES org_stores(tenant_id,brand_id,id),
        CHECK(store_id IS NULL OR brand_id IS NOT NULL));
      CREATE TABLE IF NOT EXISTS onboarding_applications(
        id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),invitation_id TEXT NOT NULL REFERENCES onboarding_invitations(id),
        tenant_id TEXT NOT NULL REFERENCES org_tenants(id),brand_id TEXT NOT NULL,store_id TEXT,
        role TEXT NOT NULL CHECK(role IN ('staff','store_manager','brand_manager')),note TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled')),
        created_at TEXT NOT NULL,reviewed_at TEXT,reviewer_id TEXT REFERENCES users(id),review_note TEXT NOT NULL DEFAULT '',
        FOREIGN KEY(tenant_id,brand_id) REFERENCES org_brands(tenant_id,id),
        FOREIGN KEY(tenant_id,brand_id,store_id) REFERENCES org_stores(tenant_id,brand_id,id),
        CHECK((role='brand_manager' AND store_id IS NULL) OR (role IN ('staff','store_manager') AND store_id IS NOT NULL)));
      CREATE UNIQUE INDEX IF NOT EXISTS onboarding_one_pending ON onboarding_applications(user_id,tenant_id) WHERE status='pending';
      CREATE INDEX IF NOT EXISTS onboarding_review_queue ON onboarding_applications(status,tenant_id,brand_id,store_id);
    `);
  }

  account(user, approved = false) {
    if (!user?.id || user.channel_app_id) throw fail('请通过员工账号页面登录', 403);
    const row = this.db.prepare(`SELECT a.user_id AS id,a.status,a.admin,a.email,u.name FROM accounts a
      JOIN users u ON u.id=a.user_id WHERE a.user_id=?`).get(user.id);
    if (!row || !['pending', 'approved'].includes(row.status) || approved && row.status !== 'approved') {
      throw fail('当前账号不能进行此操作', 403);
    }
    return row;
  }

  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  audit(user, action, id) {
    this.db.prepare('INSERT INTO access_audit(actor,action,target,at) VALUES(?,?,?,?)')
      .run(user.id, 'onboarding:' + action, id, new Date(this.now()).toISOString());
  }

  /** Authority is always recomputed from live employment, never from a posted role or cached session. */
  capabilities(user) {
    this.account(user, true);
    const owners = this.db.prepare(`SELECT m.tenant_id FROM org_memberships m JOIN org_tenants t ON t.id=m.tenant_id
      WHERE m.user_id=? AND m.role='owner' AND m.active=1 AND t.active=1`).all(user.id);
    const owned = new Set(owners.map(row => row.tenant_id));
    const capabilities = owners.map(row => ({tenant_id: row.tenant_id, brand_id: null, store_id: null, roles: [...roles]}));
    const assigned = this.db.prepare(`SELECT a.* FROM org_assignments a
      JOIN org_memberships m ON m.tenant_id=a.tenant_id AND m.user_id=a.user_id AND m.active=1
      JOIN org_tenants t ON t.id=a.tenant_id AND t.active=1
      JOIN org_brands b ON b.id=a.brand_id AND b.tenant_id=a.tenant_id AND b.active=1
      LEFT JOIN org_stores s ON s.id=a.store_id AND s.tenant_id=a.tenant_id AND s.brand_id=a.brand_id
      WHERE a.user_id=? AND a.role IN ('store_manager','brand_manager') AND (a.store_id IS NULL OR s.active=1)`)
      .all(user.id);
    for (const row of assigned) if (!owned.has(row.tenant_id)) capabilities.push({tenant_id: row.tenant_id,
      brand_id: row.brand_id, store_id: row.store_id, roles: row.role === 'brand_manager' ? ['staff', 'store_manager'] : ['staff']});
    return capabilities;
  }

  covers(capability, target, requestedRoles) {
    return capability.tenant_id === target.tenant_id && (!capability.brand_id || capability.brand_id === target.brand_id)
      && (!capability.store_id || capability.store_id === target.store_id) && requestedRoles.every(role => capability.roles.includes(role));
  }

  canIssue(user, target, requestedRoles) {
    try { return this.capabilities(user).some(capability => this.covers(capability, target, requestedRoles)); }
    catch (error) { if (error.status === 403) return false; throw error; }
  }

  parents(target) {
    this.organization.tenant(target.tenant_id);
    if (target.brand_id) this.organization.brand(target.tenant_id, target.brand_id);
    if (target.store_id) {
      const store = this.organization.location(target.tenant_id, target.store_id);
      if (store.brand_id !== target.brand_id) throw fail('门店与品牌不匹配');
    }
  }

  tree(capabilities) {
    const tenants = this.db.prepare('SELECT id,name FROM org_tenants WHERE active=1 ORDER BY name,id').all()
      .filter(tenant => capabilities.some(cap => cap.tenant_id === tenant.id));
    const brands = this.db.prepare('SELECT id,name,tenant_id FROM org_brands WHERE active=1 ORDER BY name,id').all()
      .filter(brand => capabilities.some(cap => cap.tenant_id === brand.tenant_id && (!cap.brand_id || cap.brand_id === brand.id)));
    const brandIds = new Set(brands.map(brand => brand.id));
    const stores = this.db.prepare('SELECT id,name,tenant_id,brand_id FROM org_stores WHERE active=1 ORDER BY name,id').all()
      .filter(store => brandIds.has(store.brand_id) && capabilities.some(cap => cap.tenant_id === store.tenant_id
        && (!cap.brand_id || cap.brand_id === store.brand_id) && (!cap.store_id || cap.store_id === store.id)));
    return {tenants, brands, stores};
  }

  validInvitation(token) {
    if (typeof token !== 'string' || !/^kbinv_[A-Za-z0-9_-]{43}$/.test(token)) throw fail('邀请链接无效或已失效', 404);
    const invitation = this.db.prepare('SELECT * FROM onboarding_invitations WHERE token_hash=?').get(digest(token));
    if (!invitation || invitation.revoked_at || invitation.expires_at <= this.now()) throw fail('邀请链接无效或已失效', 404);
    const parsed = {...invitation, roles: JSON.parse(invitation.roles)};
    try {
      this.parents(parsed);
      if (!this.canIssue({id: invitation.created_by}, parsed, parsed.roles)) throw fail('邀请链接无效或已失效', 404);
    } catch (error) { if (error.status) throw fail('邀请链接无效或已失效', 404); throw error; }
    return parsed;
  }

  context(user, input) {
    this.account(user);
    object(input, ['invitation']);
    const invitation = this.validInvitation(input.invitation);
    const tree = this.tree([invitation]);
    return {tenant: tree.tenants[0], brands: tree.brands, stores: tree.stores, roles: invitation.roles};
  }

  reviewContext(user) {
    const capabilities = this.capabilities(user);
    if (!capabilities.length) throw fail('当前没有员工审批权限', 403);
    return {...this.tree(capabilities), capabilities, roles: roles.filter(role => capabilities.some(cap => cap.roles.includes(role)))};
  }

  publicInvitation(row) {
    return {id: row.id, tenant_id: row.tenant_id, tenant_name: row.tenant_name, brand_id: row.brand_id,
      brand_name: row.brand_name, store_id: row.store_id, store_name: row.store_name,
      roles: typeof row.roles === 'string' ? JSON.parse(row.roles) : row.roles, created_by: row.created_by,
      creator_name: row.creator_name, created_at: row.created_at, expires_at: new Date(row.expires_at).toISOString(), revoked_at: row.revoked_at};
  }

  invitationRows() {
    return this.db.prepare(`SELECT i.*,t.name AS tenant_name,b.name AS brand_name,s.name AS store_name,u.name AS creator_name
      FROM onboarding_invitations i JOIN org_tenants t ON t.id=i.tenant_id
      LEFT JOIN org_brands b ON b.id=i.brand_id LEFT JOIN org_stores s ON s.id=i.store_id
      JOIN users u ON u.id=i.created_by ORDER BY i.created_at DESC,i.id`).all();
  }

  invitations(user) {
    const capabilities = this.capabilities(user);
    return this.invitationRows().filter(row => capabilities.some(cap => this.covers(cap, row, JSON.parse(row.roles))))
      .map(row => this.publicInvitation(row));
  }

  createInvitation(user, input) {
    object(input, ['tenant_id', 'brand_id', 'store_id', 'roles', 'expires_in_days']);
    this.account(user, true);
    const tenantId = identifier(input.tenant_id, '公司编号');
    let brandId = input.brand_id ?? null;
    const storeId = input.store_id ?? null;
    if (brandId !== null) identifier(brandId, '品牌编号');
    if (storeId !== null) {
      identifier(storeId, '门店编号');
      const store = this.organization.location(tenantId, storeId);
      if (brandId && brandId !== store.brand_id) throw fail('门店与品牌不匹配');
      brandId = store.brand_id;
    }
    const requestedRoles = input.roles;
    if (!Array.isArray(requestedRoles) || !requestedRoles.length || requestedRoles.length > 3
      || requestedRoles.some(role => !roles.includes(role)) || new Set(requestedRoles).size !== requestedRoles.length
      || storeId && requestedRoles.includes('brand_manager')) throw fail('邀请岗位无效');
    const days = input.expires_in_days ?? 7;
    if (!Number.isInteger(days) || days < 1 || days > 30) throw fail('邀请有效期须为1—30天');
    const target = {tenant_id: tenantId, brand_id: brandId, store_id: storeId};
    this.parents(target);
    if (!this.canIssue(user, target, requestedRoles)) throw fail('不能为此组织或岗位创建邀请', 403);
    return this.transaction(() => {
      this.account(user, true); this.parents(target);
      if (!this.canIssue(user, target, requestedRoles)) throw fail('不能为此组织或岗位创建邀请', 403);
      const id = randomUUID(), token = 'kbinv_' + randomBytes(32).toString('base64url'), now = this.now();
      this.db.prepare(`INSERT INTO onboarding_invitations(id,token_hash,tenant_id,brand_id,store_id,roles,created_by,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id, digest(token), tenantId, brandId, storeId, JSON.stringify(requestedRoles), user.id,
        new Date(now).toISOString(), now + days * 86400000);
      this.audit(user, 'create-invitation', id);
      return {...this.publicInvitation(this.invitationRows().find(row => row.id === id)), token};
    });
  }

  revokeInvitation(user, id) {
    identifier(id, '邀请编号');
    const capabilities = this.capabilities(user);
    const row = this.invitationRows().find(invitation => invitation.id === id);
    if (!row || !capabilities.some(cap => this.covers(cap, row, JSON.parse(row.roles)))) throw fail('邀请不存在或不可访问', 404);
    return this.transaction(() => {
      if (!this.canIssue(user, row, JSON.parse(row.roles))) throw fail('邀请不存在或不可访问', 404);
      if (!row.revoked_at) {
        this.db.prepare('UPDATE onboarding_invitations SET revoked_at=? WHERE id=?').run(new Date(this.now()).toISOString(), id);
        this.audit(user, 'revoke-invitation', id);
      }
      return this.publicInvitation(this.invitationRows().find(invitation => invitation.id === id));
    });
  }

  applicationRows() {
    return this.db.prepare(`SELECT a.*,u.name,c.email,c.status AS account_status,t.name AS tenant_name,b.name AS brand_name,
      s.name AS store_name,r.name AS reviewer_name FROM onboarding_applications a JOIN users u ON u.id=a.user_id
      JOIN accounts c ON c.user_id=a.user_id JOIN org_tenants t ON t.id=a.tenant_id JOIN org_brands b ON b.id=a.brand_id
      LEFT JOIN org_stores s ON s.id=a.store_id LEFT JOIN users r ON r.id=a.reviewer_id ORDER BY a.created_at DESC,a.id`).all();
  }

  targetMembership(userId, tenantId) {
    const membership = this.db.prepare('SELECT * FROM org_memberships WHERE tenant_id=? AND user_id=?').get(tenantId, userId);
    if (membership && (!membership.active || membership.role === 'owner')) throw fail('现有身份需由公司负责人通过组织管理核对，不可通过申请覆盖', 409);
    return membership;
  }

  assignmentPlan(target) {
    const existing = this.db.prepare('SELECT * FROM org_assignments WHERE tenant_id=? AND user_id=?').all(target.tenant_id, target.user_id);
    if (!existing.length) return {create: true};
    if (existing.length === 1 && existing[0].brand_id === target.brand_id && existing[0].store_id === target.store_id) {
      if (existing[0].role === target.role) return {create: false};
      if (existing[0].role === 'staff' && target.role === 'store_manager') return {create: true, replace: existing[0].id};
    }
    throw fail('现有岗位与本申请冲突，请公司负责人通过组织管理处理调店或兼岗', 409);
  }

  apply(user, input) {
    object(input, ['invitation', 'role', 'brand_id', 'store_id', 'note']);
    const account = this.account(user);
    const invitation = this.validInvitation(input.invitation);
    if (!invitation.roles.includes(input.role)) throw fail('邀请不允许申请此岗位', 403);
    let brandId = input.brand_id ?? invitation.brand_id, storeId = input.store_id ?? invitation.store_id;
    if (brandId !== null && brandId !== undefined) identifier(brandId, '品牌编号');
    if (storeId !== null && storeId !== undefined) {
      identifier(storeId, '门店编号');
      const store = this.organization.location(invitation.tenant_id, storeId);
      if (brandId && brandId !== store.brand_id) throw fail('门店与品牌不匹配');
      brandId = store.brand_id;
    }
    if (input.role === 'brand_manager' ? !brandId || storeId : !storeId) throw fail('请选择此岗位对应的品牌或门店');
    const target = {user_id: account.id, tenant_id: invitation.tenant_id, brand_id: brandId ?? null,
      store_id: storeId ?? null, role: input.role};
    if (!this.covers(invitation, target, [target.role])) throw fail('申请超出邀请允许的组织范围', 403);
    this.parents(target);
    const note = noteOf(input.note);
    return this.transaction(() => {
      this.account(user); this.validInvitation(input.invitation); this.parents(target);
      const previous = this.db.prepare("SELECT * FROM onboarding_applications WHERE user_id=? AND tenant_id=? AND status='pending'").get(user.id, target.tenant_id);
      if (previous) {
        if (previous.brand_id !== target.brand_id || previous.store_id !== target.store_id || previous.role !== target.role) throw fail('本公司已有其他待审批申请，请先取消原申请', 409);
        return this.applicationRows().find(row => row.id === previous.id);
      }
      this.targetMembership(user.id, target.tenant_id);
      this.assignmentPlan(target);
      const id = randomUUID();
      this.db.prepare(`INSERT INTO onboarding_applications(id,user_id,invitation_id,tenant_id,brand_id,store_id,role,note,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id, user.id, invitation.id, target.tenant_id, target.brand_id, target.store_id, target.role, note, new Date(this.now()).toISOString());
      this.audit(user, 'apply', id);
      return this.applicationRows().find(row => row.id === id);
    });
  }

  mine(user) {
    this.account(user);
    return this.applicationRows().filter(row => row.user_id === user.id);
  }

  cancel(user, id) {
    this.account(user); identifier(id, '申请编号');
    return this.transaction(() => {
      this.account(user);
      const row = this.db.prepare('SELECT * FROM onboarding_applications WHERE id=? AND user_id=?').get(id, user.id);
      if (!row) throw fail('申请不存在或不可访问', 404);
      if (row.status !== 'pending') throw fail('只有待审批申请可以取消', 409);
      this.db.prepare("UPDATE onboarding_applications SET status='cancelled',reviewed_at=? WHERE id=?").run(new Date(this.now()).toISOString(), id);
      this.audit(user, 'cancel', id);
      return this.applicationRows().find(application => application.id === id);
    });
  }

  visible(user, application, capabilities) {
    if (application.user_id === user.id || !capabilities.some(cap => this.covers(cap, application, [application.role]))) return false;
    try { this.parents(application); return true; }
    catch (error) { if (error.status) return false; throw error; }
  }

  pending(user) {
    const capabilities = this.capabilities(user);
    return this.applicationRows().filter(row => row.status === 'pending' && this.visible(user, row, capabilities));
  }

  review(user, id, input) {
    identifier(id, '申请编号'); object(input, ['decision', 'note']);
    if (!['approved', 'rejected'].includes(input.decision)) throw fail('审批决定无效');
    const note = noteOf(input.note);
    return this.transaction(() => {
      const capabilities = this.capabilities(user);
      const application = this.db.prepare('SELECT * FROM onboarding_applications WHERE id=?').get(id);
      if (!application || !this.visible(user, application, capabilities)) throw fail('申请不存在或不可访问', 404);
      if (application.status !== 'pending') throw fail('此申请已经处理', 409);
      if (input.decision === 'approved') {
        const account = this.db.prepare('SELECT status,admin FROM accounts WHERE user_id=?').get(application.user_id);
        if (!account || !['pending', 'approved'].includes(account.status) || account.status === 'pending' && account.admin) throw fail('申请人的账号已被停用或拒绝，不可通过此入口恢复', 409);
        const membership = this.targetMembership(application.user_id, application.tenant_id);
        const plan = this.assignmentPlan(application);
        if (account.status === 'pending') this.db.prepare("UPDATE accounts SET status='approved',review_note='已通过组织身份审批' WHERE user_id=? AND status='pending'").run(application.user_id);
        if (!membership) this.db.prepare("INSERT INTO org_memberships(tenant_id,user_id,role,active) VALUES(?,?,'member',1)").run(application.tenant_id, application.user_id);
        if (plan.replace) this.db.prepare('DELETE FROM org_assignments WHERE id=?').run(plan.replace);
        if (plan.create) this.db.prepare('INSERT INTO org_assignments(id,tenant_id,user_id,brand_id,store_id,role) VALUES(?,?,?,?,?,?)')
          .run(randomUUID(), application.tenant_id, application.user_id, application.brand_id, application.store_id, application.role);
        this.organization.revokeChannelSessions(application.user_id, application.tenant_id);
        this.db.exec('UPDATE record_epoch SET value=value+1');
      }
      this.db.prepare('UPDATE onboarding_applications SET status=?,reviewed_at=?,reviewer_id=?,review_note=? WHERE id=?')
        .run(input.decision, new Date(this.now()).toISOString(), user.id, note, id);
      this.audit(user, input.decision, id);
      return this.applicationRows().find(row => row.id === id);
    });
  }
}
