import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {Auth} from '../src/auth.mjs';
import {Organization} from '../src/organization.mjs';
import {Channels} from '../src/channels.mjs';
import {upgradeFederation} from '../src/federation.mjs';

const secret='synthetic-federation-secret-long-enough';
async function fixture(t,{migrate=true}={}) {
  const store=new Store(':memory:'), project=store.defaultProject(),auth=new Auth(store,project),org=new Organization(store);
  t.after(()=>store.close());
  const owner=await auth.register({name:'合成负责人',email:'owner@example.test',department:'test',reason:'test',password:'synthetic-password-1234'},true);
  const actor={id:owner.id,name:'合成负责人',status:'approved',admin:1};
  const tenant=org.manage(actor,{action:'tenant',name:'合成公司'});
  org.manage(actor,{action:'member',tenant_id:tenant.id,user_id:actor.id,role:'owner'});
  const brand=org.manage(actor,{action:'brand',tenant_id:tenant.id,name:'合成品牌'});
  const locations={},scopes={};
  for(const key of ['hs','qh']) {
    locations[key]=org.manage(actor,{action:'store',tenant_id:tenant.id,brand_id:brand.id,name:key});
    scopes[key]=org.manage(actor,{action:'scope',tenant_id:tenant.id,store_id:locations[key].id,level:'staff',name:key+'员工知识'});
  }
  const management=org.manage(actor,{action:'scope',tenant_id:tenant.id,store_id:locations.hs.id,level:'management',name:'管理资料'});
  const publicScope=org.manage(actor,{action:'scope',tenant_id:tenant.id,level:'staff',name:'公司资料'});
  const env={FEDERATION_TEST_SECRET:secret};
  const previous=process.env.FEDERATION_TEST_SECRET;process.env.FEDERATION_TEST_SECRET=secret;
  t.after(()=>{if(previous===undefined)delete process.env.FEDERATION_TEST_SECRET;else process.env.FEDERATION_TEST_SECRET=previous;});
  const channels=new Channels(store,auth,{organization:org,env});
  const app=channels.manage(actor,{action:'app',name:'合成独立入口',channel:'agent',tenant_id:tenant.id,brand_id:brand.id,secret_env:'FEDERATION_TEST_SECRET',enabled:true});
  const policy={company_id:'default',tenant_id:tenant.id,brand_id:brand.id,operator_user_id:actor.id,stores:{hs:scopes.hs.id,qh:scopes.qh.id}};
  env.TEAM_FEDERATION_CONFIG_JSON=JSON.stringify({apps:{[app.id]:policy}});
  if(migrate)upgradeFederation(store.db);
  const input=(patch={})=>({subject:'synthetic-person-one',company_id:'default',role:'staff',store_keys:['hs'],issued_at:Math.floor(Date.now()/1000),request_id:randomUUID(),...patch});
  const federate=(patch={})=>channels.federate(app.id,secret,input(patch));
  return {store,auth,org,actor,tenant,brand,locations,scopes,management,publicScope,channels,app,env,policy,input,federate};
}

test('federation requires explicit schema upgrade and leaves old startup untouched',async t=>{
 const f=await fixture(t,{migrate:false});
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'federation_%'").get().n,0);
 assert.throws(()=>f.federate(),/federation_schema_not_ready/);
 upgradeFederation(f.store.db);assert.equal(f.federate().expires_in,60);
});
test('two source subjects are independent; repeat identity stable, old sessions revoked and permissions replaced',async t=>{
 const f=await fixture(t),a=f.federate(),b=f.federate({subject:'synthetic-person-two',store_keys:['qh']});
 assert.notEqual(a.user.id,b.user.id);assert.notEqual(a.user.id,f.actor.id);
 const first=f.channels.authenticate(a.token);f.channels.assertScope(first.app,first.user,f.scopes.hs.id,true);
 assert.throws(()=>f.channels.assertScope(first.app,first.user,f.scopes.qh.id),{status:403});
 const next=f.federate({store_keys:['qh']});assert.equal(next.user.id,a.user.id);assert.equal(f.channels.authenticate(a.token),null);
 const current=f.channels.authenticate(next.token);assert.throws(()=>f.channels.assertScope(current.app,current.user,f.scopes.hs.id),{status:403});
 f.channels.assertScope(current.app,current.user,f.scopes.qh.id,true);
 assert.equal(f.store.db.prepare('SELECT role FROM org_memberships WHERE user_id=?').get(a.user.id).role,'member');
});
test('invalid roles, company, unknown stores, stale assertions and replays are rejected atomically',async t=>{
 const f=await fixture(t),before=f.store.db.prepare('SELECT count(*) n FROM users').get().n;
 for(const patch of [{company_id:'other'},{role:'admin'},{role:'staff',store_keys:['hs','qh']},{store_keys:['all']},{store_keys:['unknown']},{issued_at:Math.floor(Date.now()/1000)-100},{scope_id:f.scopes.hs.id}])
  assert.throws(()=>f.federate(patch),{status:400});
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM users').get().n,before);
 const input=f.input();f.channels.federate(f.app.id,secret,input);assert.throws(()=>f.channels.federate(f.app.id,secret,input),{status:409});
 assert.throws(()=>f.channels.federate(f.app.id,'wrong-secret',f.input()),{status:401});
});
test('manual account, membership, binding or identity disable cannot be revived by upstream login',async t=>{
 for(const field of ['account','membership','binding','identity']) {
  const f=await fixture(t),result=f.federate();
  if(field==='account')f.store.db.prepare("UPDATE accounts SET status='disabled' WHERE user_id=?").run(result.user.id);
  if(field==='membership')f.store.db.prepare('UPDATE org_memberships SET active=0 WHERE user_id=?').run(result.user.id);
  if(field==='binding')f.store.db.prepare('UPDATE channel_bindings SET active=0 WHERE user_id=?').run(result.user.id);
  if(field==='identity')f.store.db.prepare('UPDATE federation_identities SET active=0 WHERE user_id=?').run(result.user.id);
  assert.equal(f.channels.authenticate(result.token),null);
  assert.throws(()=>f.federate(),{status:403});
 }
});
test('external-only identities cannot login by password, device or ordinary session and extra grants cannot expand access',async t=>{
 const f=await fixture(t),result=f.federate(),id=result.user.id,user=f.channels.authenticate(result.token).user;
 const row=f.store.db.prepare('SELECT * FROM accounts WHERE user_id=?').get(id);
 assert.equal(row.admin,0);await assert.rejects(f.auth.login({email:row.email,password:'arbitrary'}),{status:403});
 assert.throws(()=>f.auth.session(id,'test'),{status:403});assert.throws(()=>f.auth.bind(user,f.auth.start().code),{status:403});
 f.store.db.prepare("UPDATE org_memberships SET role='owner' WHERE user_id=?").run(id);
 f.store.db.prepare("INSERT INTO scope_grants VALUES(?,?,'writer')").run(id,f.project?.id||f.store.defaultProject().id);
 for(const scope of [f.management.id,f.publicScope.id,f.scopes.qh.id])assert.throws(()=>f.org.authorize(user,scope),{status:403});
 assert.throws(()=>f.org.authorize({id},f.scopes.hs.id),{status:403});
 assert.throws(()=>f.auth.authorize(user,f.store.defaultProject().id),{status:403});
 f.store.grant(f.store.defaultProject().id,id);
 assert.throws(()=>f.store.access(user,f.store.defaultProject().id),{status:403});
});
test('scope policy requires exact active tenant, brand, store and staff level; dynamic config narrowing takes effect',async t=>{
 const f=await fixture(t),result=f.federate(),user=f.channels.authenticate(result.token).user;
 f.policy.stores.hs=f.management.id;f.env.TEAM_FEDERATION_CONFIG_JSON=JSON.stringify({apps:{[f.app.id]:f.policy}});
 assert.throws(()=>f.federate(),{status:403});assert.throws(()=>f.org.authorize(user,f.scopes.hs.id),{status:403});
});
test('migration and provisioning preserve existing users, memberships, bindings and knowledge records',async t=>{
 const f=await fixture(t);
 const before=f.store.db.prepare('SELECT * FROM users WHERE id=?').get(f.actor.id);
 const membership=f.store.db.prepare('SELECT * FROM org_memberships WHERE user_id=?').get(f.actor.id);
 f.federate();assert.deepEqual(f.store.db.prepare('SELECT * FROM users WHERE id=?').get(f.actor.id),before);
 assert.deepEqual(f.store.db.prepare('SELECT * FROM org_memberships WHERE user_id=?').get(f.actor.id),membership);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM records').get().n,0);
});
