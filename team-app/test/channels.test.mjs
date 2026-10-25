import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Auth} from '../src/auth.mjs';
import {Organization} from '../src/organization.mjs';
import {Channels} from '../src/channels.mjs';

const credentialEnv = 'TEST_KB_CHANNEL_CREDENTIAL';
const credential = 'test-only-channel-credential-000000000';

async function fixture(t, fetchImpl = async () => ({ok:true,json:async()=>({openid:'wechat-staff',session_key:'must-remain-server-side'})})) {
  const store = new Store(':memory:'), project = store.defaultProject(), auth = new Auth(store,project);
  const organization = new Organization(store);
  const oldEnv = process.env[credentialEnv];
  process.env[credentialEnv] = credential;
  t.after(() => { store.close(); if(oldEnv === undefined) delete process.env[credentialEnv]; else process.env[credentialEnv] = oldEnv; });
  const users = {};
  for (const name of ['admin','owner','staff','other']) {
    const input = {name,email:name+'@example.test',department:'test',reason:'test',password:'test-password-12345'};
    const row = await auth.register(input,name==='admin');
    store.db.prepare("UPDATE accounts SET status='approved' WHERE user_id=?").run(row.id);
    users[name] = {id:row.id,name,status:'approved',admin:name==='admin'?1:0};
  }
  const tenant = organization.manage(users.admin,{action:'tenant',name:'公司甲'});
  const otherTenant = organization.manage(users.admin,{action:'tenant',name:'公司乙'});
  for (const name of ['owner','staff']) organization.manage(users.admin,{action:'member',tenant_id:tenant.id,user_id:users[name].id,role:name==='owner'?'owner':'member'});
  organization.manage(users.admin,{action:'member',tenant_id:otherTenant.id,user_id:users.other.id,role:'owner'});
  const brand = organization.manage(users.owner,{action:'brand',tenant_id:tenant.id,name:'品牌甲'});
  const brand2 = organization.manage(users.owner,{action:'brand',tenant_id:tenant.id,name:'品牌乙'});
  const location = organization.manage(users.owner,{action:'store',tenant_id:tenant.id,brand_id:brand.id,name:'A店'});
  const location2 = organization.manage(users.owner,{action:'store',tenant_id:tenant.id,brand_id:brand.id,name:'B店'});
  const location3 = organization.manage(users.owner,{action:'store',tenant_id:tenant.id,brand_id:brand2.id,name:'C店'});
  const scope = organization.manage(users.owner,{action:'scope',tenant_id:tenant.id,store_id:location.id,level:'staff',name:'A店工作'});
  const management = organization.manage(users.owner,{action:'scope',tenant_id:tenant.id,store_id:location.id,level:'management',name:'A店管理'});
  const scope2 = organization.manage(users.owner,{action:'scope',tenant_id:tenant.id,store_id:location2.id,level:'staff',name:'B店工作'});
  const scope3 = organization.manage(users.owner,{action:'scope',tenant_id:tenant.id,store_id:location3.id,level:'staff',name:'C店工作'});
  const headquarters = organization.manage(users.owner,{action:'scope',tenant_id:tenant.id,level:'staff',name:'总部员工资料'});
  organization.manage(users.owner,{action:'assignment',tenant_id:tenant.id,user_id:users.staff.id,store_id:location.id,role:'staff'});
  const service = new Channels(store,auth,{organization,fetchImpl});
  const app = service.manage(users.owner,{action:'app',name:'品牌甲员工小程序',channel:'miniapp',tenant_id:tenant.id,
    store_id:location.id,external_app_id:'wx1234567890abcdef',secret_env:credentialEnv,enabled:true});
  const bind = (who='staff',externalId='wechat-staff',appId=app.id) => service.manage(users.owner,
    {action:'binding',app_id:appId,external_id:externalId,user_id:users[who].id,verified:true});
  return {store,auth,organization,service,users,tenant,otherTenant,brand,brand2,location,location2,scope,management,scope2,scope3,headquarters,app,bind};
}

test('channel registration is staff-only, immutable, company-managed and disabled until configured',async t=>{
  const f=await fixture(t), {service,users,tenant,otherTenant,brand2,location,app}=f;
  const disabled=service.manage(users.owner,{action:'app',name:'未来接入',channel:'miniapp',tenant_id:tenant.id});
  assert.equal(disabled.enabled,0); assert.equal(disabled.configured,false);
  await assert.rejects(service.login('code',disabled.id),{status:403});
  assert.throws(()=>service.manage(users.owner,{action:'app',id:disabled.id,enabled:true}),{status:409});
  assert.throws(()=>service.manage(users.owner,{action:'app',name:'顾客入口',channel:'miniapp',tenant_id:tenant.id,audience:'customer'}),{status:400});
  assert.throws(()=>service.manage(users.owner,{action:'app',id:app.id,tenant_id:otherTenant.id}),/不可更改/);
  assert.throws(()=>service.manage(users.owner,{action:'app',name:'串门店',channel:'agent',tenant_id:tenant.id,brand_id:brand2.id,store_id:location.id}),/门店不属于/);
  assert.throws(()=>service.manage(users.owner,{action:'app',name:'越权公司',channel:'agent',tenant_id:otherTenant.id}),{status:403});
  assert.throws(()=>service.manage(users.staff,{action:'app',name:'越权员工',channel:'agent',tenant_id:tenant.id}),{status:403});
  assert.throws(()=>service.manage(users.owner,{action:'app',id:app.id,secret:'not-accepted'}),/凭据仅通过环境变量/);
  const overview=service.overview(users.owner);
  assert.ok(overview.apps.every(a=>a.tenant_id===tenant.id));
  assert.ok(!JSON.stringify(overview).includes(credential));
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM access_audit').all()).includes('not-accepted'));
});

test('miniapp exchanges a one-time code only at the official server and issues a bound hashed session',async t=>{
  let request;
  const f=await fixture(t,async(url,options)=>{
    request={url:new URL(url),options};
    return {ok:true,json:async()=>({openid:'wechat-staff',unionid:'never-an-employee-grant',session_key:'must-remain-server-side'})};
  });
  const {service,app,bind,users,store}=f;
  assert.throws(()=>service.manage(users.owner,{action:'binding',app_id:app.id,external_id:'wechat-staff',user_id:users.staff.id}),/核实外部身份/);
  const binding=bind();
  const result=await service.login('temporary-login-code',app.id);
  assert.equal(request.url.origin,'https://api.weixin.qq.com');
  assert.equal(request.url.pathname,'/sns/jscode2session');
  assert.equal(request.url.searchParams.get('appid'),app.external_app_id);
  assert.equal(request.url.searchParams.get('secret'),credential);
  assert.equal(request.url.searchParams.get('js_code'),'temporary-login-code');
  assert.equal(request.options.redirect,'error');
  assert.equal(result.user.id,users.staff.id); assert.equal(result.expires_in,3600);
  assert.equal(result.identity_verified_at,binding.verified_at);
  assert.ok(!JSON.stringify(result).includes('must-remain-server-side'));
  assert.ok(!JSON.stringify(result).includes(credential));
  const session=service.authenticate(result.token);
  assert.equal(session.user.id,users.staff.id); assert.equal(session.app.id,app.id);
  assert.equal(session.user.channel_app_id,app.id);
  const persisted=store.db.prepare('SELECT * FROM channel_sessions').get();
  assert.notEqual(persisted.hash,result.token);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM channel_bindings').get().n,1);
});

test('valid WeChat identities do not automatically become employees or merge across applications',async t=>{
  const f=await fixture(t), {service,users,tenant,app,bind}=f;
  await assert.rejects(service.login('code',app.id),{status:403});
  assert.throws(()=>service.manage(users.owner,{action:'binding',app_id:app.id,external_id:'outsider',user_id:users.other.id,verified:true}),/本公司/);
  bind();
  const second=service.manage(users.owner,{action:'app',name:'另一品牌小程序',channel:'miniapp',tenant_id:tenant.id,
    external_app_id:'wxfedcba0987654321',secret_env:credentialEnv,enabled:true});
  await assert.rejects(service.login('another-code',second.id),{status:403});
  bind('owner','wechat-staff',second.id);
  assert.equal((await service.login('code',app.id)).user.id,users.staff.id);
  assert.equal((await service.login('code',second.id)).user.id,users.owner.id);
  assert.throws(()=>service.manage(users.admin,{action:'app',name:'重复AppID',channel:'miniapp',tenant_id:f.otherTenant.id,
    external_app_id:app.external_app_id,secret_env:credentialEnv,enabled:true}),{status:409});
});

test('application caps intersect live employee permissions, including owner and legacy-scope access',async t=>{
  const f=await fixture(t), {service,app,users,scope,management,scope2,scope3,headquarters,bind}=f;
  bind();
  const login=await service.login('code',app.id),session=service.authenticate(login.token);
  assert.equal(service.assertScope(session.app,session.user,scope.id,true).id,scope.id);
  assert.throws(()=>service.assertScope(app,session.user,management.id),{status:403});
  for(const id of [scope2.id,scope3.id,headquarters.id,f.store.defaultProject().id]) {
    assert.throws(()=>service.assertScope(app,users.owner,id),{status:403});
  }
  assert.equal(service.assertScope(app,users.owner,management.id,true).id,management.id);
  assert.throws(()=>service.overview(session.user),{status:403});
  assert.throws(()=>service.manage({...users.owner,channel_app_id:app.id},{action:'app',id:app.id,name:'不允许修改'}),{status:403});
  f.organization.manage(users.owner,{action:'store',id:f.location.id,tenant_id:f.tenant.id,active:false});
  assert.equal(service.authenticate(login.token),null);
});

test('binding replacement, app disable, membership removal, expiry and logout revoke sessions',async t=>{
  const f=await fixture(t),{service,app,bind,users,store}=f;
  bind();
  let result=await service.login('code',app.id);
  const oldToken=result.token;
  bind('owner');
  assert.equal(service.authenticate(oldToken),null);
  result=await service.login('code',app.id);
  assert.equal(service.authenticate(result.token).user.id,users.owner.id);
  service.revoke(result.token); assert.equal(service.authenticate(result.token),null);
  assert.deepEqual(service.revoke(result.token),{ok:true});
  result=await service.login('code',app.id);
  store.db.prepare('UPDATE channel_sessions SET expires=0').run();
  assert.equal(service.authenticate(result.token),null);
  result=await service.login('code',app.id);
  service.manage(users.owner,{action:'app',id:app.id,enabled:false});
  service.manage(users.owner,{action:'app',id:app.id,enabled:true});
  assert.equal(service.authenticate(result.token),null);
  bind(); result=await service.login('code',app.id);
  f.organization.manage(users.owner,{action:'member',tenant_id:f.tenant.id,user_id:users.staff.id,role:'member',active:false});
  assert.equal(service.authenticate(result.token),null);
  service.manage(users.owner,{action:'binding',app_id:app.id,external_id:'wechat-staff',active:false});
  assert.equal(service.authenticate('not-a-channel-token'),null);
});

test('trusted bridges require a dedicated server credential and a verified employee binding',async t=>{
  const f=await fixture(t),{service,users,tenant,location,bind,app}=f;
  const bridge=service.manage(users.owner,{action:'app',name:'企微接入',channel:'wecom',tenant_id:tenant.id,
    store_id:location.id,external_app_id:'ww-test-corp',secret_env:credentialEnv,enabled:true});
  bind('staff','wecom-staff',bridge.id);
  assert.throws(()=>service.bridge(bridge.id,'wrong-secret','wecom-staff'),{status:401});
  assert.throws(()=>service.bridge(bridge.id,credential,'unbound-staff'),{status:403});
  assert.throws(()=>service.bridge(app.id,credential,'wechat-staff'),{status:403});
  const result=service.bridge(bridge.id,credential,'wecom-staff');
  assert.equal(service.authenticate(result.token).user.id,users.staff.id);
  assert.ok(!JSON.stringify(result).includes(credential));
  service.manage(users.owner,{action:'revoke',id:service.authenticate(result.token).session_hash});
  assert.equal(service.authenticate(result.token),null);
});

test('issued sessions expose the current verified binding timestamp after employee reassignment',async t=>{
  const f=await fixture(t),{service,users,tenant,location,bind}=f;
  const app=service.manage(users.owner,{action:'app',name:'身份时点测试',channel:'wecom',tenant_id:tenant.id,
    store_id:location.id,secret_env:credentialEnv,enabled:true});
  bind('staff','shared-external-id',app.id);
  // A known earlier verification time makes the generation change deterministic.
  f.store.db.prepare('UPDATE channel_bindings SET verified_at=? WHERE app_id=?')
    .run('2026-01-01T00:00:00.000Z',app.id);
  const earlier=service.bridge(app.id,credential,'shared-external-id');
  const replacement=bind('owner','shared-external-id',app.id);
  const current=service.bridge(app.id,credential,'shared-external-id');
  assert.equal(earlier.identity_verified_at,'2026-01-01T00:00:00.000Z');
  assert.equal(current.identity_verified_at,replacement.verified_at);
  assert.ok(Date.parse(current.identity_verified_at)>Date.parse(earlier.identity_verified_at));
  assert.equal(current.user.id,users.owner.id);
  assert.equal(service.authenticate(earlier.token),null);
});

test('removing and restoring membership or a store assignment never revives an old token',async t=>{
  const f=await fixture(t),{service,organization,users,tenant,location,app,bind}=f;
  bind();
  const membership={action:'member',tenant_id:tenant.id,user_id:users.staff.id,role:'member'};
  const first=await service.login('code',app.id);
  organization.manage(users.owner,{...membership,active:false});
  organization.manage(users.owner,{...membership,active:true});
  assert.equal(service.authenticate(first.token),null);
  const assignment={action:'assignment',tenant_id:tenant.id,user_id:users.staff.id,store_id:location.id,role:'staff'};
  organization.manage(users.owner,assignment);
  const second=await service.login('code',app.id);
  organization.manage(users.owner,{...assignment,active:false});
  organization.manage(users.owner,assignment);
  assert.equal(service.authenticate(second.token),null);
  assert.ok(service.authenticate((await service.login('new-code',app.id)).token));
});

test('upstream failures are sanitized and identity/app revocation during exchange is honored',async t=>{
  let behavior='network',f;
  f=await fixture(t,async()=>{
    if(behavior==='network') throw new Error('request leaked secret '+credential);
    if(behavior==='invalid') return {ok:true,json:async()=>({errcode:40029,errmsg:'secret '+credential})};
    f.service.manage(f.users.owner,{action:'app',id:f.app.id,enabled:false});
    return {ok:true,json:async()=>({openid:'wechat-staff'})};
  });
  f.bind();
  await assert.rejects(f.service.login('code',f.app.id),error=>error.status===502&&!error.message.includes(credential));
  behavior='invalid';
  await assert.rejects(f.service.login('code',f.app.id),error=>error.status===401&&!error.message.includes(credential));
  behavior='disable';
  await assert.rejects(f.service.login('code',f.app.id),{status:403});
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM channel_sessions').get().n,0);
});
