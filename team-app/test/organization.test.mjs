import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {Auth} from '../src/auth.mjs';
import {Organization} from '../src/organization.mjs';

function fixture() {
  const store = new Store(':memory:');
  const project = store.defaultProject();
  const auth = new Auth(store, project);
  const org = new Organization(store);
  const user = (name, admin = false, status = 'approved') => {
    const person = store.user(name, randomUUID());
    store.db.prepare(`INSERT INTO accounts(user_id,email,department,reason,password,status,admin)
      VALUES(?,?,?,?,?,?,?)`).run(person.id, randomUUID() + '@example.test', '测试', '权限测试', 'unused', status, admin ? 1 : 0);
    return {...person, status, admin: admin ? 1 : 0};
  };
  const admin = user('平台管理员', true);
  const run = (action, input, actor = admin) => org.manage(actor, {action, ...input});
  const company = name => run('tenant', {name});
  const brand = (tenant, name) => run('brand', {tenant_id: tenant.id, name});
  const shop = (tenant, brand, name) => run('store', {tenant_id: tenant.id, brand_id: brand.id, name});
  const member = (tenant, person, role = 'member', active = true) => run('member', {tenant_id: tenant.id, user_id: person.id, role, active});
  const assign = (tenant, person, role, target, active = true) => run('assignment', {tenant_id: tenant.id, user_id: person.id, role, ...target, active});
  const scope = (tenant, name, level = 'staff', target = {}) => run('scope', {tenant_id: tenant.id, name, level, ...target});
  return {store, project, auth, org, user, admin, run, company, brand, shop, member, assign, scope};
}

function denied(org, person, scope, write = false) {
  assert.throws(() => org.authorize(person, scope.id, write), error => error.status === 403);
}

test('organization access separates 12 stores, management, brands and customer companies', () => {
  const f = fixture();
  try {
    const tenant = f.company('第一家公司');
    const b = f.brand(tenant, '品牌甲');
    const anotherBrand = f.brand(tenant, '品牌乙');
    const shops = Array.from({length: 12}, (_, i) => f.shop(tenant, b, `门店${i + 1}`));
    const scopes = shops.map(s => f.scope(tenant, s.name + '工作', 'staff', {store_id: s.id}));
    const management = f.scope(tenant, '门店1管理', 'management', {store_id: shops[0].id});
    const executive = f.scope(tenant, '经营决策', 'executive');
    const companyScope = f.scope(tenant, '全员制度');
    const brandScope = f.scope(tenant, '品牌甲规范', 'staff', {brand_id: b.id});
    const brandManagement = f.scope(tenant, '品牌甲管理', 'management', {brand_id: b.id});
    const otherShop = f.shop(tenant, anotherBrand, '其他品牌门店');
    const otherScope = f.scope(tenant, '其他品牌工作', 'staff', {store_id: otherShop.id});
    const owner = f.user('负责人'), employee = f.user('店员'), manager = f.user('店长'), brandManager = f.user('品牌负责人');
    for (const person of [owner, employee, manager, brandManager]) f.member(tenant, person, person === owner ? 'owner' : 'member');
    f.assign(tenant, employee, 'staff', {store_id: shops[0].id});
    f.assign(tenant, manager, 'store_manager', {store_id: shops[0].id});
    f.assign(tenant, brandManager, 'brand_manager', {brand_id: b.id});

    f.org.authorize(employee, scopes[0].id, true);
    for (const s of scopes.slice(1)) denied(f.org, employee, s);
    denied(f.org, employee, management);
    f.org.authorize(manager, management.id, true);
    denied(f.org, manager, scopes[1]);
    for (const s of scopes) {
      f.org.authorize(owner, s.id, true);
      f.org.authorize(brandManager, s.id, true);
    }
    f.org.authorize(owner, executive.id, true);
    f.org.authorize(owner, otherScope.id, true);
    denied(f.org, brandManager, otherScope);
    denied(f.org, manager, executive);
    denied(f.org, f.admin, scopes[0]);
    f.org.authorize(employee, companyScope.id);
    denied(f.org, employee, companyScope, true);
    f.org.authorize(employee, brandScope.id);
    denied(f.org, employee, brandScope, true);
    denied(f.org, manager, brandManagement);
    f.org.authorize(brandManager, brandManagement.id, true);

    const customer = f.company('第二家客户公司'), customerBrand = f.brand(customer, '品牌甲');
    const customerScope = f.scope(customer, '客户制度');
    denied(f.org, owner, customerScope);
    denied(f.org, brandManager, customerScope);
    assert.equal(f.org.scopes(employee).length, 3);
    assert.ok(f.org.scopes(owner).every(s => s.tenant_id === tenant.id));
    assert.equal(f.org.scope(scopes[0].id).brand_id, b.id);
    assert.notEqual(customerBrand.tenant_id, b.tenant_id);
  } finally { f.store.close(); }
});

test('explicit scope grants require active company employment and revocation takes effect immediately', () => {
  const f = fixture();
  try {
    const tenant = f.company('甲公司'), b = f.brand(tenant, '甲品牌'), s = f.shop(tenant, b, '甲门店');
    const scope = f.scope(tenant, '管理资料', 'management', {store_id: s.id});
    const employee = f.user('员工');
    assert.throws(() => f.auth.manage(f.admin, {action: 'grant', id: employee.id, scope: scope.id, role: 'writer'}), error => error.status === 403);
    // Even a stray historical grant must never bypass current company membership.
    f.store.db.prepare('INSERT INTO scope_grants(user_id,scope_id,role) VALUES(?,?,?)').run(employee.id, scope.id, 'writer');
    denied(f.org, employee, scope);
    f.member(tenant, employee);
    f.org.authorize(employee, scope.id, true);
    f.member(tenant, employee, 'member', false);
    denied(f.org, employee, scope);
    assert.equal(f.store.db.prepare('SELECT 1 FROM scope_grants WHERE user_id=? AND scope_id=?').get(employee.id, scope.id), undefined);
    f.member(tenant, employee);
    denied(f.org, employee, scope);
    f.assign(tenant, employee, 'store_manager', {store_id: s.id});
    f.org.authorize(employee, scope.id, true);
    f.assign(tenant, employee, 'store_manager', {store_id: s.id}, false);
    denied(f.org, employee, scope);
    f.assign(tenant, employee, 'store_manager', {store_id: s.id});
    f.store.db.prepare("UPDATE accounts SET status='disabled' WHERE user_id=?").run(employee.id);
    denied(f.org, employee, scope);
    assert.deepEqual(f.org.scopes(employee), []);
    f.member(tenant, employee, 'member', false);
  } finally { f.store.close(); }
});

test('organization management is tenant bounded, audited and independent of knowledge reading', () => {
  const f = fixture();
  try {
    const first = f.company('第一公司'), second = f.company('第二公司');
    const owner = f.user('负责人'), member = f.user('员工');
    f.member(first, owner, 'owner');
    f.member(first, member);
    const before = f.store.db.prepare('SELECT value FROM record_epoch').get().value;
    const b = f.run('brand', {tenant_id: first.id, name: '自有品牌'}, owner);
    assert.ok(b.id);
    assert.equal(f.org.canManage(owner, first.id), true);
    assert.equal(f.org.canManage({...owner, channel_app_id: 'miniapp-session'}, first.id), false);
    assert.equal(f.org.canManage(owner, second.id), false);
    assert.throws(() => f.run('brand', {tenant_id: second.id, name: '越权'}, owner), error => error.status === 403);
    assert.throws(() => f.run('tenant', {name: '越权创建'}, owner), error => error.status === 403);
    assert.throws(() => f.run('brand', {tenant_id: first.id, name: '越权'}, member), error => error.status === 403);
    assert.throws(() => f.run('member', {tenant_id: first.id, user_id: owner.id, role: 'member'}, owner), error => error.status === 409);
    assert.deepEqual(f.org.overview(owner).tenants.map(t => t.id), [first.id]);
    assert.throws(() => f.org.overview({...owner, channel_app_id: 'miniapp-session'}), error => error.status === 403);
    assert.throws(() => f.org.overview(owner, second.id), error => error.status === 403);
    assert.equal(f.org.overview(f.admin).tenants.length, 2);
    assert.ok(f.store.db.prepare('SELECT value FROM record_epoch').get().value > before);
    assert.ok(f.store.db.prepare("SELECT count(*) AS n FROM access_audit WHERE action LIKE 'organization:%'").get().n >= 5);
    f.store.db.prepare("UPDATE accounts SET admin=0 WHERE user_id=?").run(f.admin.id);
    assert.equal(f.org.canManage(f.admin, first.id), false);
  } finally { f.store.close(); }
});

test('parent validation and database constraints prevent cross-company, cross-brand and audience mixing', () => {
  const f = fixture();
  try {
    const first = f.company('甲公司'), second = f.company('乙公司');
    const a = f.brand(first, '甲品牌'), b = f.brand(first, '乙品牌'), c = f.brand(second, '甲品牌');
    const shop = f.shop(first, a, '甲店');
    const employee = f.user('员工'); f.member(first, employee);
    assert.throws(() => f.run('store', {tenant_id: first.id, brand_id: c.id, name: '错误门店'}), error => error.status === 400);
    assert.throws(() => f.run('scope', {tenant_id: second.id, store_id: shop.id, name: '错误范围', level: 'staff'}), error => error.status === 400);
    assert.throws(() => f.run('scope', {tenant_id: first.id, brand_id: b.id, store_id: shop.id, name: '错误范围', level: 'staff'}), error => error.status === 400);
    assert.throws(() => f.run('assignment', {tenant_id: first.id, user_id: employee.id, role: 'staff', brand_id: b.id, store_id: shop.id}), error => error.status === 400);
    assert.throws(() => f.run('scope', {tenant_id: first.id, name: '顾客范围', level: 'staff', audience: 'customer'}), error => error.status === 400);
    assert.throws(() => f.run('member', {tenant_id: first.id, user_id: employee.id, role: 'admin'}), error => error.status === 400);
    assert.throws(() => f.run('store', {tenant_id: first.id, name: '缺少品牌'}), error => error.status === 400);
    assert.throws(() => f.run('tenant', {name: '甲公司'}), error => error.status === 409);
    const scope = f.scope(first, '门店资料', 'staff', {store_id: shop.id});
    const anotherScope = f.scope(first, '门店规范', 'staff', {store_id: shop.id});
    assert.throws(() => f.run('scope', {id: scope.id, tenant_id: first.id, name: anotherScope.name}), error => error.status === 409);
    assert.throws(() => f.run('scope', {id: scope.id, tenant_id: first.id, brand_id: b.id}), error => error.status === 400);
    assert.throws(() => f.store.db.prepare('UPDATE org_scopes SET tenant_id=? WHERE scope_id=?').run(second.id, scope.id), /FOREIGN KEY/);
    assert.throws(() => f.store.db.prepare('UPDATE org_scopes SET audience=? WHERE scope_id=?').run('customer', scope.id), /CHECK/);
  } finally { f.store.close(); }
});

test('scope, company, brand and store disablement revoke current access without deleting records', () => {
  const f = fixture();
  try {
    const tenant = f.company('公司'), b = f.brand(tenant, '品牌'), s = f.shop(tenant, b, '门店');
    const owner = f.user('负责人'); f.member(tenant, owner, 'owner');
    const scope = f.scope(tenant, '门店资料', 'staff', {store_id: s.id});
    f.org.authorize(owner, scope.id, true);
    for (const [action, input] of [
      ['scope', {tenant_id: tenant.id, id: scope.id}],
      ['store', {tenant_id: tenant.id, id: s.id}],
      ['brand', {tenant_id: tenant.id, id: b.id}],
      ['tenant', {id: tenant.id}],
    ]) {
      f.run(action, {...input, active: false});
      denied(f.org, owner, scope);
      f.run(action, {...input, active: true});
      f.org.authorize(owner, scope.id, true);
    }
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM projects WHERE id=?').get(scope.id).n, 1);
  } finally { f.store.close(); }
});

test('idempotent organization schema initialization preserves legacy records and grants', () => {
  const f = fixture();
  try {
    const person = f.user('旧资料作者');
    f.store.grant(f.project.id, person.id);
    const record = f.store.add(person, f.project.id, {text: '已有原始资料', changes: []});
    const org = new Organization(f.store);
    assert.equal(org.isManaged(f.project.id), false);
    assert.equal(org.context(f.project.id), undefined);
    assert.deepEqual(org.scopes(person), []);
    assert.equal(f.store.records(person, f.project.id)[0].id, record.id);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM org_tenants').get().n, 0);
  } finally { f.store.close(); }
});
