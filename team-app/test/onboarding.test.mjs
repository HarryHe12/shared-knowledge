import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {Auth} from '../src/auth.mjs';
import {Onboarding} from '../src/onboarding.mjs';

function fixture() {
  const store = new Store(':memory:'), project = store.defaultProject(), auth = new Auth(store, project), org = auth.organization;
  const user = (name, status = 'approved', admin = false) => {
    const person = store.user(name, randomUUID());
    store.db.prepare('INSERT INTO accounts(user_id,email,department,reason,password,status,admin) VALUES(?,?,?,?,?,?,?)')
      .run(person.id, randomUUID() + '@example.test', '部门', '申请', 'unused', status, admin ? 1 : 0);
    return {...person, status, admin: admin ? 1 : 0};
  };
  const admin = user('平台管理员', 'approved', true);
  const manage = input => org.manage(admin, input);
  const tenant = manage({action: 'tenant', name: '公司甲'}), otherTenant = manage({action: 'tenant', name: '公司乙'});
  const brand = manage({action: 'brand', tenant_id: tenant.id, name: '品牌甲'});
  const otherBrand = manage({action: 'brand', tenant_id: tenant.id, name: '品牌乙'});
  const customerBrand = manage({action: 'brand', tenant_id: otherTenant.id, name: '客户品牌'});
  const shop = manage({action: 'store', tenant_id: tenant.id, brand_id: brand.id, name: '甲店'});
  const secondShop = manage({action: 'store', tenant_id: tenant.id, brand_id: brand.id, name: '甲二店'});
  const otherShop = manage({action: 'store', tenant_id: tenant.id, brand_id: otherBrand.id, name: '乙店'});
  const customerShop = manage({action: 'store', tenant_id: otherTenant.id, brand_id: customerBrand.id, name: '客户店'});
  const employee = (name, role, target = {}, company = tenant) => {
    const person = user(name);
    manage({action: 'member', tenant_id: company.id, user_id: person.id, role: role === 'owner' ? 'owner' : 'member'});
    if (role !== 'owner') manage({action: 'assignment', tenant_id: company.id, user_id: person.id, role, ...target});
    return person;
  };
  const owner = employee('老板', 'owner'), brandManager = employee('品牌主管', 'brand_manager', {brand_id: brand.id});
  const manager = employee('甲店店长', 'store_manager', {store_id: shop.id});
  const secondManager = employee('甲二店店长', 'store_manager', {store_id: secondShop.id});
  const otherManager = employee('乙品牌主管', 'brand_manager', {brand_id: otherBrand.id});
  const customerOwner = employee('客户老板', 'owner', {}, otherTenant);
  const onboarding = new Onboarding(store, auth);
  const invite = (actor = manager, input = {}) => onboarding.createInvitation(actor,
    {tenant_id: tenant.id, store_id: shop.id, roles: ['staff'], ...input});
  const apply = (person, invitation, input = {}) => onboarding.apply(person, {invitation: invitation.token, role: 'staff', ...input});
  return {store, auth, org, onboarding, user, manage, tenant, otherTenant, brand, otherBrand, customerBrand, shop,
    secondShop, otherShop, customerShop, owner, brandManager, manager, secondManager, otherManager, customerOwner, admin, employee, invite, apply};
}

const status = expected => error => error.status === expected;

test('pending employees gain no privileges until their own store manager approves', () => {
  const f = fixture();
  try {
    const candidate = f.user('新店员', 'pending'), invitation = f.invite();
    const scope = f.manage({action: 'scope', tenant_id: f.tenant.id, store_id: f.shop.id, name: '本店工作', level: 'staff'});
    const management = f.manage({action: 'scope', tenant_id: f.tenant.id, store_id: f.shop.id, name: '本店管理', level: 'management'});
    const tree = f.onboarding.context(candidate, {invitation: invitation.token});
    assert.equal(tree.tenant.id, f.tenant.id); assert.deepEqual(tree.stores.map(s => s.id), [f.shop.id]);
    const application = f.apply(candidate, invitation, {note: '请核实入职'});
    assert.equal(application.name, candidate.name); assert.equal(application.status, 'pending');
    assert.equal(f.store.db.prepare('SELECT 1 FROM org_memberships WHERE user_id=?').get(candidate.id), undefined);
    assert.throws(() => f.auth.authorize(candidate, scope.id), status(403));
    assert.deepEqual(f.onboarding.pending(f.secondManager), []);
    assert.throws(() => f.onboarding.review(f.secondManager, application.id, {decision: 'approved'}), status(404));
    const epoch = f.store.db.prepare('SELECT value FROM record_epoch').get().value;
    const approved = f.onboarding.review(f.manager, application.id, {decision: 'approved', note: '已核实'});
    assert.equal(approved.status, 'approved'); assert.equal(approved.reviewer_name, f.manager.name);
    assert.equal(approved.review_note, '已核实');
    assert.equal(f.store.db.prepare('SELECT status FROM accounts WHERE user_id=?').get(candidate.id).status, 'approved');
    f.auth.authorize(candidate, scope.id, true);
    assert.throws(() => f.auth.authorize(candidate, management.id), status(403));
    assert.ok(f.store.db.prepare('SELECT value FROM record_epoch').get().value > epoch);
    assert.equal(f.onboarding.mine(candidate)[0].id, application.id);
    assert.throws(() => f.onboarding.review(f.manager, application.id, {decision: 'approved'}), status(409));
  } finally { f.store.close(); }
});

test('invitations and approvals follow store, brand and company hierarchy with no platform-admin shortcut', () => {
  const f = fixture();
  try {
    assert.throws(() => f.invite(f.manager, {roles: ['store_manager']}), status(403));
    assert.throws(() => f.invite(f.manager, {store_id: f.secondShop.id}), status(403));
    assert.throws(() => f.invite(f.brandManager, {store_id: f.otherShop.id}), status(403));
    assert.throws(() => f.invite(f.brandManager, {store_id: null, brand_id: f.brand.id, roles: ['brand_manager']}), status(403));
    assert.throws(() => f.invite(f.admin), status(403));
    assert.throws(() => f.invite(f.owner, {roles: ['owner']}), status(400));
    const storeManagerInvite = f.invite(f.brandManager, {roles: ['store_manager']});
    const nextManager = f.user('下一任店长', 'pending');
    const managerApplication = f.apply(nextManager, storeManagerInvite, {role: 'store_manager'});
    for (const actor of [f.manager, f.otherManager, f.customerOwner]) assert.throws(() => f.onboarding.review(actor, managerApplication.id, {decision: 'approved'}), status(404));
    f.onboarding.review(f.brandManager, managerApplication.id, {decision: 'approved'});
    const brandInvite = f.invite(f.owner, {store_id: null, brand_id: f.brand.id, roles: ['brand_manager']});
    const nextBrand = f.user('新品牌负责人', 'pending'), brandApplication = f.apply(nextBrand, brandInvite, {role: 'brand_manager'});
    assert.throws(() => f.onboarding.review(f.brandManager, brandApplication.id, {decision: 'approved'}), status(404));
    f.onboarding.review(f.owner, brandApplication.id, {decision: 'approved'});
    assert.equal(f.store.db.prepare('SELECT role FROM org_assignments WHERE user_id=?').get(nextBrand.id).role, 'brand_manager');
    assert.deepEqual(f.onboarding.reviewContext(f.manager).stores.map(s => s.id), [f.shop.id]);
    assert.deepEqual(f.onboarding.reviewContext(f.brandManager).stores.map(s => s.id).sort(), [f.shop.id, f.secondShop.id].sort());
    assert.ok(f.onboarding.invitations(f.manager).every(i => i.store_id === f.shop.id && i.roles.every(role => role === 'staff')));
    assert.throws(() => f.onboarding.revokeInvitation(f.customerOwner, storeManagerInvite.id), status(404));
  } finally { f.store.close(); }
});

test('invitation secrets are hashed, bounded, revocable, and depend on live issuer authority', () => {
  const f = fixture();
  try {
    const candidate = f.user('申请人', 'pending'), invitation = f.invite();
    assert.ok(invitation.token.length > 40);
    assert.equal(invitation.usable, true);
    const stored = f.store.db.prepare('SELECT * FROM onboarding_invitations WHERE id=?').get(invitation.id);
    assert.notEqual(stored.token_hash, invitation.token);
    assert.ok(!JSON.stringify(f.onboarding.invitations(f.manager)).includes(invitation.token));
    assert.throws(() => f.invite(f.manager, {expires_in_days: 31}), status(400));
    assert.throws(() => f.invite(f.manager, {expires_in_days: 0}), status(400));
    const application = f.apply(candidate, invitation);
    f.onboarding.revokeInvitation(f.manager, invitation.id);
    assert.equal(f.onboarding.invitations(f.owner).find(row => row.id === invitation.id).usable, false);
    assert.throws(() => f.onboarding.context(candidate, {invitation: invitation.token}), status(404));
    f.onboarding.review(f.manager, application.id, {decision: 'approved'});
    const expires = f.invite();
    f.store.db.prepare('UPDATE onboarding_invitations SET expires_at=? WHERE id=?').run(Date.now() - 1, expires.id);
    assert.throws(() => f.onboarding.context(candidate, {invitation: expires.token}), status(404));
    assert.equal(f.onboarding.invitations(f.owner).find(row => row.id === expires.id).usable, false);
    const live = f.invite();
    f.manage({action: 'assignment', tenant_id: f.tenant.id, user_id: f.manager.id, role: 'store_manager', store_id: f.shop.id, active: false});
    assert.throws(() => f.onboarding.context(candidate, {invitation: live.token}), status(404));
    assert.throws(() => f.apply(candidate, live), status(404));
    assert.equal(f.onboarding.invitations(f.owner).find(row => row.id === live.id).usable, false);
    const audit = JSON.stringify(f.store.db.prepare("SELECT * FROM access_audit WHERE action LIKE 'onboarding:%'").all());
    assert.ok(!audit.includes(invitation.token)); assert.ok(!audit.includes(candidate.email ?? '@example.test'));
  } finally { f.store.close(); }
});

test('applicants cannot post identities or escape invitations and duplicates preserve one pending application per company', () => {
  const f = fixture();
  try {
    const candidate = f.user('申请人', 'pending'), invitation = f.invite(f.owner, {store_id: null, roles: ['staff', 'store_manager']});
    const input = {store_id: f.shop.id};
    const first = f.apply(candidate, invitation, input), duplicate = f.apply(candidate, invitation, {...input, note: '重复提交'});
    assert.equal(first.id, duplicate.id); assert.equal(duplicate.note, '');
    assert.throws(() => f.apply(candidate, invitation, {store_id: f.secondShop.id}), status(409));
    for (const injected of [{user_id: f.owner.id}, {tenant_id: f.otherTenant.id}, {name: '冒名'}, {email: 'other@example.test'}, {status: 'approved'}]) {
      assert.throws(() => f.apply(candidate, invitation, {...input, ...injected}), status(400));
    }
    const narrow = f.invite();
    assert.throws(() => f.apply(candidate, narrow, {store_id: f.secondShop.id}), status(403));
    assert.throws(() => f.apply(candidate, narrow, {role: 'store_manager'}), status(403));
    assert.throws(() => f.apply(candidate, narrow, {store_id: f.customerShop.id}), status(400));
    assert.throws(() => f.onboarding.cancel(f.owner, first.id), status(404));
    assert.equal(f.onboarding.cancel(candidate, first.id).status, 'cancelled');
    assert.throws(() => f.onboarding.cancel(candidate, first.id), status(409));
    assert.ok(f.apply(candidate, invitation, {store_id: f.secondShop.id}).id);
    const otherCompany = f.invite(f.customerOwner, {tenant_id: f.otherTenant.id, store_id: f.customerShop.id});
    assert.ok(f.apply(candidate, otherCompany).id);
  } finally { f.store.close(); }
});

test('approval cannot revive disabled/rejected accounts, inactive membership, revoked reviewers or inactive parent organizations', () => {
  for (const scenario of ['disabled-target', 'rejected-target', 'inactive-member', 'disabled-reviewer', 'removed-role', 'inactive-store', 'inactive-brand', 'inactive-tenant']) {
    const f = fixture();
    try {
      const candidate = f.user('新员工', 'pending'), invitation = f.invite(), application = f.apply(candidate, invitation);
      if (scenario.endsWith('-target')) f.store.db.prepare('UPDATE accounts SET status=? WHERE user_id=?').run(scenario.split('-')[0], candidate.id);
      if (scenario === 'inactive-member') f.store.db.prepare("INSERT INTO org_memberships VALUES(?,?,'member',0)").run(f.tenant.id, candidate.id);
      if (scenario === 'disabled-reviewer') f.store.db.prepare("UPDATE accounts SET status='disabled' WHERE user_id=?").run(f.manager.id);
      if (scenario === 'removed-role') f.manage({action: 'assignment', tenant_id: f.tenant.id, user_id: f.manager.id, role: 'store_manager', store_id: f.shop.id, active: false});
      if (scenario === 'inactive-store') f.manage({action: 'store', tenant_id: f.tenant.id, id: f.shop.id, active: false});
      if (scenario === 'inactive-brand') f.manage({action: 'brand', tenant_id: f.tenant.id, id: f.brand.id, active: false});
      if (scenario === 'inactive-tenant') f.manage({action: 'tenant', id: f.tenant.id, active: false});
      assert.throws(() => f.onboarding.review(f.manager, application.id, {decision: 'approved'}), error => [403, 404, 409].includes(error.status), scenario);
      assert.equal(f.onboarding.applicationRows().find(a => a.id === application.id).status, 'pending');
      assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM org_assignments WHERE user_id=?').get(candidate.id).n, 0);
    } finally { f.store.close(); }
  }
});

test('rejection affects only the application and existing approved accounts can join another company', () => {
  const f = fixture();
  try {
    const candidate = f.employee('现有员工', 'staff', {store_id: f.customerShop.id}, f.otherTenant), invitation = f.invite();
    const rejected = f.apply(candidate, invitation);
    assert.equal(f.onboarding.review(f.manager, rejected.id, {decision: 'rejected', note: '待核实'}).status, 'rejected');
    assert.equal(f.store.db.prepare('SELECT status FROM accounts WHERE user_id=?').get(candidate.id).status, 'approved');
    assert.ok(f.org.membership(candidate.id, f.otherTenant.id));
    const again = f.apply(candidate, invitation);
    f.onboarding.review(f.manager, again.id, {decision: 'approved'});
    assert.ok(f.org.membership(candidate.id, f.tenant.id));
    assert.ok(f.org.membership(candidate.id, f.otherTenant.id));
  } finally { f.store.close(); }
});

test('staff promotion replaces only the same store role and other transfers or multiple assignments require owner management', () => {
  const f = fixture();
  try {
    const person = f.employee('晋升员工', 'staff', {store_id: f.shop.id});
    const invitation = f.invite(f.brandManager, {roles: ['store_manager']});
    const application = f.apply(person, invitation, {role: 'store_manager'});
    f.onboarding.review(f.brandManager, application.id, {decision: 'approved'});
    const assignments = f.store.db.prepare('SELECT * FROM org_assignments WHERE user_id=?').all(person.id);
    assert.equal(assignments.length, 1); assert.equal(assignments[0].role, 'store_manager');
    const moving = f.employee('调店员工', 'staff', {store_id: f.secondShop.id});
    assert.throws(() => f.apply(moving, f.invite()), status(409));
    const pending = f.user('等待核实员工', 'pending'), pendingApplication = f.apply(pending, f.invite());
    f.store.db.prepare("UPDATE accounts SET status='approved' WHERE user_id=?").run(pending.id);
    f.manage({action: 'member', tenant_id: f.tenant.id, user_id: pending.id, role: 'member'});
    f.manage({action: 'assignment', tenant_id: f.tenant.id, user_id: pending.id, role: 'store_manager', store_id: f.shop.id});
    assert.throws(() => f.onboarding.review(pending, pendingApplication.id, {decision: 'approved'}), status(404));
    assert.ok(!f.onboarding.pending(pending).some(a => a.id === pendingApplication.id));
  } finally { f.store.close(); }
});

test('approval is atomic when assignment insertion fails and channel sessions cannot administer or self-enroll', () => {
  const f = fixture();
  try {
    const candidate = f.user('新员工', 'pending'), invitation = f.invite(), application = f.apply(candidate, invitation);
    const epoch = f.store.db.prepare('SELECT value FROM record_epoch').get().value;
    f.store.db.exec("CREATE TRIGGER reject_onboarding_assignment BEFORE INSERT ON org_assignments BEGIN SELECT RAISE(ABORT,'simulated disk constraint'); END");
    assert.throws(() => f.onboarding.review(f.manager, application.id, {decision: 'approved'}), /simulated disk constraint/);
    assert.equal(f.store.db.prepare('SELECT status FROM accounts WHERE user_id=?').get(candidate.id).status, 'pending');
    assert.equal(f.store.db.prepare('SELECT 1 FROM org_memberships WHERE user_id=?').get(candidate.id), undefined);
    assert.equal(f.store.db.prepare('SELECT status FROM onboarding_applications WHERE id=?').get(application.id).status, 'pending');
    assert.equal(f.store.db.prepare('SELECT value FROM record_epoch').get().value, epoch);
    const channel = {...f.owner, channel_app_id: 'miniapp'};
    for (const invoke of [() => f.onboarding.reviewContext(channel), () => f.onboarding.invitations(channel),
      () => f.invite(channel), () => f.onboarding.pending(channel), () => f.onboarding.review(channel, application.id, {decision: 'approved'}),
      () => f.onboarding.context(channel, {invitation: invitation.token}), () => f.onboarding.mine(channel), () => f.apply(channel, invitation)]) assert.throws(invoke, status(403));
    new Onboarding(f.store, f.auth);
    assert.equal(f.onboarding.mine(candidate).length, 1);
  } finally { f.store.close(); }
});
