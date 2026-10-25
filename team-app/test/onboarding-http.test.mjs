import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {Store} from '../src/store.mjs';
import {Auth} from '../src/auth.mjs';
import {Channels} from '../src/channels.mjs';
import {createKnowledgeServer} from '../src/http.mjs';
import {KnowledgeClient} from '../client/knowledge-client.mjs';

async function fixture(t) {
  const store = new Store(':memory:'), project = store.defaultProject(), auth = new Auth(store, project);
  const org = auth.organization, channels = new Channels(store, auth), password = 'onboarding-test-password-123';
  async function account(name, status = 'approved', admin = false) {
    const email = name + '@example.test';
    const {id} = await auth.register({name, email, department: '门店', reason: '内部协作', password}, admin);
    if (!admin && status === 'approved') store.db.prepare("UPDATE accounts SET status='approved' WHERE user_id=?").run(id);
    const {token} = await auth.login({email, password});
    return {id, token, user: auth.user(token)};
  }
  const admin = await account('platform', 'approved', true), owner = await account('owner');
  const brandManager = await account('brand-manager'), manager = await account('first-manager'), otherManager = await account('second-manager');
  const employee = await account('new-employee', 'pending'), another = await account('another-employee', 'pending');
  const company = org.manage(admin.user, {action: 'tenant', name: '试点公司'});
  const foreign = org.manage(admin.user, {action: 'tenant', name: '另一家公司'});
  org.manage(admin.user, {action: 'member', tenant_id: company.id, user_id: owner.id, role: 'owner'});
  const brand = org.manage(owner.user, {action: 'brand', tenant_id: company.id, name: '胡叨叨'});
  const otherBrand = org.manage(owner.user, {action: 'brand', tenant_id: company.id, name: '另一品牌'});
  const firstStore = org.manage(owner.user, {action: 'store', tenant_id: company.id, brand_id: brand.id, name: '一店'});
  const secondStore = org.manage(owner.user, {action: 'store', tenant_id: company.id, brand_id: brand.id, name: '二店'});
  const scope = (name, location, level = 'staff') => org.manage(owner.user, {action: 'scope', tenant_id: company.id,
    brand_id: brand.id, store_id: location.id, name, level});
  const first = scope('一店员工', firstStore), management = scope('一店管理', firstStore, 'management'), second = scope('二店员工', secondStore);
  for (const [actor, role, location] of [[brandManager, 'brand_manager'], [manager, 'store_manager', firstStore], [otherManager, 'store_manager', secondStore]]) {
    org.manage(owner.user, {action: 'member', tenant_id: company.id, user_id: actor.id, role: 'member'});
    org.manage(owner.user, {action: 'assignment', tenant_id: company.id, user_id: actor.id, role,
      ...(location ? {store_id: location.id} : {brand_id: brand.id})});
  }
  const envName = 'ONBOARDING_HTTP_BRIDGE_SECRET', previous = process.env[envName];
  process.env[envName] = 'onboarding-test-bridge-private-secret-123';
  t.after(() => { if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous; });
  const app = channels.manage(owner.user, {action: 'app', name: '胡叨叨入口', channel: 'wecom', tenant_id: company.id,
    brand_id: brand.id, secret_env: envName, enabled: true});
  channels.manage(owner.user, {action: 'binding', app_id: app.id, external_id: 'verified-owner', user_id: owner.id, verified: true});
  const server = createKnowledgeServer(store, async () => { throw new Error('入职流程不应调用模型'); }, project);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const client = actor => new KnowledgeClient({baseUrl, token: actor.token});
  const request = async (path, {method = 'GET', body, token = owner.token} = {}) => {
    const response = await fetch(baseUrl + '/api/v1/' + path, {method,
      headers: {Accept: 'application/json', ...(token ? {Authorization: 'Bearer ' + token} : {}), ...(body !== undefined ? {'Content-Type': 'application/json'} : {})},
      body: body === undefined ? undefined : JSON.stringify(body)});
    return {status: response.status, data: await response.json()};
  };
  return {store, auth, org, channels, owner, admin, brandManager, manager, otherManager, employee, another,
    company, foreign, brand, otherBrand, firstStore, secondStore, first, management, second, app, client, request};
}

test('入职 SDK 映射所有接口，拒绝客户端自行指定员工、公司或审核人', async () => {
  const requests = [], baseUrl = 'https://knowledge.example.test';
  const client = new KnowledgeClient({baseUrl, token: 'normal-employee-token', transport: async input => {
    requests.push(input); return {status: 200, data: {ok: true}};
  }});
  const input = {invitation: 'private-invitation', role: 'staff', brand_id: 'brand-a', store_id: 'store-a', note: '一店新员工'};
  await client.onboardingContext(input.invitation);
  await client.myApplications();
  await client.applyMembership(input);
  await client.cancelApplication('application-a');
  await client.reviewContext();
  await client.pendingApplications();
  await client.reviewApplication('application-a', {decision: 'approved', note: '已核实'});
  await client.invitations();
  await client.createInvitation({tenant_id: 'company-a', brand_id: 'brand-a', store_id: 'store-a', roles: ['staff'], expires_in_days: 7});
  await client.revokeInvitation('invitation-a');
  assert.deepEqual(requests.map(r => [r.method, r.url.slice((baseUrl + '/api/v1/').length)]), [
    ['POST', 'onboarding/context'], ['GET', 'onboarding/applications'], ['POST', 'onboarding/applications'],
    ['DELETE', 'onboarding/applications/application-a'], ['GET', 'onboarding/review-context'], ['GET', 'onboarding/reviews'],
    ['POST', 'onboarding/reviews/application-a'], ['GET', 'onboarding/invitations'], ['POST', 'onboarding/invitations'],
    ['DELETE', 'onboarding/invitations/invitation-a'],
  ]);
  assert.deepEqual(requests[0].body, {invitation: input.invitation});
  assert.deepEqual(requests[2].body, input);
  assert.deepEqual(requests[6].body, {decision: 'approved', note: '已核实'});
  assert.equal(requests[3].body, undefined);
  assert.ok(requests.every(r => r.headers.Authorization === 'Bearer normal-employee-token'));
  for (const extra of [{user_id: 'owner'}, {tenant_id: 'other-company'}, {admin: true}, {status: 'approved'}, {reviewer_id: 'owner'}]) {
    assert.throws(() => client.applyMembership({...input, ...extra}), {status: 400});
  }
  assert.throws(() => client.reviewApplication('application-a', {decision: 'approved', user_id: 'owner'}), {status: 400});
  assert.throws(() => client.createInvitation({tenant_id: 'company-a', roles: ['staff'], token: 'chosen-secret'}), {status: 400});
  assert.throws(() => client.cancelApplication('../other-application'), {status: 400});
  assert.throws(() => client.onboardingContext('private-invitation?leak=true'), {status: 400});
  assert.equal(requests.length, 10);
});

test('待审员工申请不授予权限，本店店长批准后原会话立即获得本店员工范围', async t => {
  const f = await fixture(t), manager = f.client(f.manager), employee = f.client(f.employee);
  const invitation = await manager.createInvitation({tenant_id: f.company.id, store_id: f.firstStore.id, roles: ['staff']});
  const context = await employee.onboardingContext(invitation.token);
  assert.equal(context.tenant.id, f.company.id);
  assert.deepEqual(context.brands.map(b => b.id), [f.brand.id]);
  assert.deepEqual(context.stores.map(s => s.id), [f.firstStore.id]);
  assert.deepEqual(context.roles, ['staff']);
  assert.deepEqual((await employee.me()).scopes, []);
  await assert.rejects(employee.records(f.first.id), {status: 403});
  const application = await employee.applyMembership({invitation: invitation.token, role: 'staff', store_id: f.firstStore.id, note: '已到岗，请审核'});
  assert.equal(application.status, 'pending');
  assert.equal(application.user_id, f.employee.id);
  assert.equal(f.auth.user(f.employee.token).status, 'pending');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM org_memberships WHERE user_id=?').get(f.employee.id).n, 0);
  await assert.rejects(employee.save(f.first.id, {text: '申请尚未批准', idempotency_key: 'before-approval'}), {status: 403});
  assert.deepEqual((await employee.myApplications()).applications.map(a => a.id), [application.id]);
  assert.deepEqual((await f.client(f.another).myApplications()).applications, []);
  assert.deepEqual((await f.client(f.otherManager).pendingApplications()).applications, []);
  await assert.rejects(f.client(f.otherManager).reviewApplication(application.id, {decision: 'approved'}), {status: 404});
  assert.deepEqual((await manager.pendingApplications()).applications.map(a => a.id), [application.id]);
  const approved = await manager.reviewApplication(application.id, {decision: 'approved', note: '已线下核实'});
  assert.equal(approved.status, 'approved');
  assert.equal(approved.review_note, '已线下核实');
  assert.equal((await employee.me()).user.status, 'approved');
  assert.deepEqual((await employee.me()).scopes.map(s => s.id), [f.first.id]);
  const record = await employee.save(f.first.id, {text: '一店完成开店检查', idempotency_key: 'after-approval'});
  assert.equal(record.author_id, f.employee.id);
  assert.equal((await employee.records(f.first.id)).records[0].id, record.id);
  for (const forbidden of [f.management.id, f.second.id]) await assert.rejects(employee.records(forbidden), {status: 403});
  await assert.rejects(employee.reviewApplication(application.id, {decision: 'approved'}));
  f.org.manage(f.owner.user, {action: 'store', tenant_id: f.company.id, id: f.firstStore.id, active: false});
  await assert.rejects(employee.records(f.first.id), {status: 403});
  assert.deepEqual((await employee.me()).scopes, []);
});

test('申请店长需要当前上级审核，邀请角色与组织范围不能被申请人或店长扩大', async t => {
  const f = await fixture(t), owner = f.client(f.owner), manager = f.client(f.manager), brandManager = f.client(f.brandManager);
  const review = await manager.reviewContext();
  assert.deepEqual(review.capabilities.map(c => [c.tenant_id, c.store_id, c.roles]), [[f.company.id, f.firstStore.id, ['staff']]]);
  assert.ok(!review.stores.some(s => s.id === f.secondStore.id));
  await assert.rejects(manager.createInvitation({tenant_id: f.company.id, store_id: f.secondStore.id, roles: ['staff']}));
  await assert.rejects(manager.createInvitation({tenant_id: f.company.id, store_id: f.firstStore.id, roles: ['store_manager']}));
  await assert.rejects(brandManager.createInvitation({tenant_id: f.company.id, brand_id: f.otherBrand.id, roles: ['staff']}));
  await assert.rejects(brandManager.createInvitation({tenant_id: f.company.id, brand_id: f.brand.id, roles: ['brand_manager']}));
  const invite = await owner.createInvitation({tenant_id: f.company.id, brand_id: f.brand.id, roles: ['staff', 'store_manager']});
  const employee = f.client(f.employee), application = await employee.applyMembership({invitation: invite.token, role: 'store_manager', store_id: f.firstStore.id});
  assert.equal(application.status, 'pending');
  await assert.rejects(employee.records(f.management.id), {status: 403});
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM org_assignments WHERE user_id=?').get(f.employee.id).n, 0);
  await assert.rejects(manager.reviewApplication(application.id, {decision: 'approved'}), {status: 404});
  assert.ok((await brandManager.pendingApplications()).applications.some(a => a.id === application.id));
  await owner.revokeInvitation(invite.id);
  await assert.rejects(f.client(f.another).onboardingContext(invite.token));
  const approved = await brandManager.reviewApplication(application.id, {decision: 'approved'});
  assert.equal(approved.status, 'approved');
  assert.equal((await employee.records(f.management.id)).records.length, 0);
  await assert.rejects(employee.records(f.second.id), {status: 403});
  await assert.rejects(f.client(f.admin).createInvitation({tenant_id: f.company.id, roles: ['staff']}), {status: 403});
});

test('申请可以本人撤销或被拒绝，接口拒绝伪造字段且邀请凭据不出现在列表和审计中', async t => {
  const f = await fixture(t), owner = f.client(f.owner), employee = f.client(f.employee), manager = f.client(f.manager);
  const invitation = await manager.createInvitation({tenant_id: f.company.id, store_id: f.firstStore.id, roles: ['staff'], expires_in_days: 1});
  const base = {invitation: invitation.token, role: 'staff', store_id: f.firstStore.id};
  const application = await employee.applyMembership(base);
  const duplicate = await employee.applyMembership(base);
  assert.equal(duplicate.id, application.id);
  await assert.rejects(f.client(f.another).cancelApplication(application.id), {status: 404});
  assert.equal((await employee.cancelApplication(application.id)).status, 'cancelled');
  await assert.rejects(manager.reviewApplication(application.id, {decision: 'approved'}));
  const next = await employee.applyMembership(base);
  assert.notEqual(next.id, application.id);
  assert.equal((await manager.reviewApplication(next.id, {decision: 'rejected', note: '请核实门店'})).status, 'rejected');
  assert.equal(f.auth.user(f.employee.token).status, 'pending');
  await assert.rejects(employee.records(f.first.id), {status: 403});
  for (const extra of [{user_id: f.owner.id}, {tenant_id: f.foreign.id}, {admin: true}, {status: 'approved'}]) {
    assert.equal((await f.request('onboarding/applications', {method: 'POST', token: f.employee.token, body: {...base, ...extra}})).status, 400);
  }
  assert.equal((await f.request('onboarding/reviews/' + next.id, {method: 'POST', token: f.manager.token,
    body: {decision: 'approved', user_id: f.owner.id}})).status, 400);
  assert.equal((await f.request('onboarding/invitations', {method: 'POST', body: {tenant_id: f.company.id, roles: ['staff'], token: 'chosen-secret'}})).status, 400);
  const invitations = await owner.invitations();
  assert.ok(invitations.invitations.some(i => i.id === invitation.id));
  assert.ok(!JSON.stringify(invitations).includes(invitation.token));
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM access_audit').all()).includes(invitation.token));
  assert.equal((await f.request('onboarding/applications', {token: null})).status, 401);
});

test('已绑定负责人渠道凭证仍不能调用入职、邀请和审核接口，撤职即时失去审核能力', async t => {
  const f = await fixture(t), manager = f.client(f.manager), employee = f.client(f.employee);
  const invite = await manager.createInvitation({tenant_id: f.company.id, store_id: f.firstStore.id, roles: ['staff']});
  const application = await employee.applyMembership({invitation: invite.token, role: 'staff', store_id: f.firstStore.id});
  const token = f.channels.bridge(f.app.id, process.env.ONBOARDING_HTTP_BRIDGE_SECRET, 'verified-owner').token;
  for (const [method, path, body] of [
    ['POST', 'onboarding/context', {invitation: invite.token}], ['GET', 'onboarding/applications'],
    ['POST', 'onboarding/applications', {invitation: invite.token, role: 'staff', store_id: f.firstStore.id}],
    ['DELETE', 'onboarding/applications/' + application.id], ['GET', 'onboarding/review-context'],
    ['GET', 'onboarding/reviews'], ['POST', 'onboarding/reviews/' + application.id, {decision: 'approved'}],
    ['GET', 'onboarding/invitations'], ['POST', 'onboarding/invitations', {tenant_id: f.company.id, roles: ['staff']}],
    ['DELETE', 'onboarding/invitations/' + invite.id],
  ]) assert.equal((await f.request(path, {method, body, token})).status, 403, path);
  assert.equal((await employee.myApplications()).applications[0].status, 'pending');
  f.org.manage(f.owner.user, {action: 'assignment', tenant_id: f.company.id, user_id: f.manager.id,
    store_id: f.firstStore.id, role: 'store_manager', active: false});
  await assert.rejects(manager.reviewApplication(application.id, {decision: 'approved'}));
  await assert.rejects(manager.createInvitation({tenant_id: f.company.id, store_id: f.firstStore.id, roles: ['staff']}));
  assert.equal(f.auth.user(f.employee.token).status, 'pending');
});
