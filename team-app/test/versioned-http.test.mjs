import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {Script} from 'node:vm';
import {Store} from '../src/store.mjs';
import {Auth} from '../src/auth.mjs';
import {Channels} from '../src/channels.mjs';
import {createKnowledgeServer} from '../src/http.mjs';
import {organizationPage} from '../src/organization-page.mjs';
import {KnowledgeClient} from '../client/knowledge-client.mjs';

async function fixture(t, model) {
  const store = new Store(':memory:'), project = store.defaultProject(), auth = new Auth(store, project);
  const channels = new Channels(store, auth), org = auth.organization;
  const password = 'integration-password-123';
  async function account(name, admin = false) {
    const id = (await auth.register({name, email: name+'@example.test', department:'门店', reason:'内部协作', password}, admin)).id;
    if (!admin) store.db.prepare("UPDATE accounts SET status='approved' WHERE user_id=?").run(id);
    const token = (await auth.login({email:name+'@example.test',password})).token;
    return {id,token,user:auth.user(token)};
  }
  const owner=await account('owner',true),staff=await account('staff'),manager=await account('manager');
  const company=org.manage(owner.user,{action:'tenant',name:'试点公司'});
  const other=org.manage(owner.user,{action:'tenant',name:'其他公司'});
  for (const a of [owner,staff,manager]) org.manage(owner.user,{action:'member',tenant_id:company.id,user_id:a.id,role:a===owner?'owner':'member'});
  org.manage(owner.user,{action:'member',tenant_id:other.id,user_id:owner.id,role:'owner'});
  const brand=org.manage(owner.user,{action:'brand',tenant_id:company.id,name:'胡叨叨'});
  const secondBrand=org.manage(owner.user,{action:'brand',tenant_id:company.id,name:'其他品牌'});
  const stores=[];
  for (const name of ['一店','二店']) stores.push(org.manage(owner.user,{action:'store',tenant_id:company.id,brand_id:brand.id,name}));
  const scope=(name,store,level='staff',brand_id=brand.id,tenant_id=company.id)=>org.manage(owner.user,{action:'scope',tenant_id,brand_id,...(store?{store_id:store.id}:{}),name,level});
  const first=scope('一店员工',stores[0]),management=scope('一店管理',stores[0],'management'),second=scope('二店员工',stores[1]);
  const foreignBrand=scope('其他品牌',null,'staff',secondBrand.id),foreign=org.manage(owner.user,{action:'scope',tenant_id:other.id,name:'公司乙',level:'staff'});
  for (const [a,role] of [[staff,'staff'],[manager,'store_manager']]) org.manage(owner.user,{action:'assignment',tenant_id:company.id,user_id:a.id,store_id:stores[0].id,role});
  process.env.HTTP_TEST_BRIDGE_KEY='a-dedicated-test-bridge-secret-012345';
  t.after(()=>delete process.env.HTTP_TEST_BRIDGE_KEY);
  const app=channels.manage(owner.user,{action:'app',name:'胡叨叨微信',channel:'wecom',tenant_id:company.id,brand_id:brand.id,secret_env:'HTTP_TEST_BRIDGE_KEY',enabled:true});
  for (const a of [owner,staff,manager]) channels.manage(owner.user,{action:'binding',app_id:app.id,external_id:a.id,user_id:a.id,verified:true});
  const server=createKnowledgeServer(store,model??(async (_system,input)=>JSON.stringify({action:'answer',answer:'盘点已完成。',quality:'supported',citations:[input.evidence[0].id]})),project);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();});
  const base='http://127.0.0.1:'+server.address().port;
  async function request(path,body,token=owner.token,scopeId) {
    const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(scopeId?{'X-Knowledge-Scope':scopeId}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    const data=await response.json();return {status:response.status,data};
  }
  return {store,auth,channels,org,owner,staff,manager,company,other,brand,stores,first,management,second,foreignBrand,foreign,app,request,base};
}

test('所有入口统一限制本店、管理层、品牌和公司，旧接口同样受约束',async t=>{
  const f=await fixture(t),{request:r}=f;
  assert.equal((await r('/api/v1/me',undefined,null)).status,401);
  const me=await r('/api/v1/me',undefined,f.staff.token);
  assert.deepEqual(me.data.scopes.map(s=>s.id),[f.first.id]);
  for (const id of [f.management.id,f.second.id,f.foreignBrand.id,f.foreign.id]) {
    assert.equal((await r('/api/v1/records?scope_id='+id,undefined,f.staff.token)).status,403);
    assert.equal((await r('/api/records',undefined,f.staff.token,id)).status,403);
  }
  assert.equal((await r('/api/v1/records?scope_id='+f.management.id,undefined,f.manager.token)).status,200);
  const bridged=await r('/api/v1/channels/'+f.app.id+'/bridge',{external_id:f.owner.id},process.env.HTTP_TEST_BRIDGE_KEY);
  assert.equal(bridged.status,200);const token=bridged.data.token;
  assert.ok((await r('/api/v1/me',undefined,token)).data.scopes.every(s=>s.brand_id===f.brand.id));
  for (const id of [f.foreignBrand.id,f.foreign.id]) for(const path of ['/api/v1/records','/api/records']) assert.equal((await r(path,undefined,token,id)).status,403);
  for (const path of ['/api/admin','/api/v1/admin/organization','/api/v1/admin/channels']) assert.equal((await r(path,undefined,token)).status,403);
  const device=f.auth.start();assert.equal((await r('/api/auth/device-bind',{code:device.code},token)).status,401);
  assert.equal(f.auth.poll(device.device_token).status,'waiting');
});

test('真实 HTTP 与 SDK 完成保存、幂等重试、分页、引用问答、纠错和会话删除',async t=>{
  const f=await fixture(t),sdk=new KnowledgeClient({baseUrl:f.base,token:f.staff.token});
  const c=await sdk.createConversation({scope_id:f.first.id,title:'工作日报'});
  const input={text:'一店盘点已完成',intent:'save',idempotency_key:'mobile-submit-1'};
  const saved=await sdk.sendMessage(c.id,input),again=await sdk.sendMessage(c.id,input);
  assert.equal(saved.result.record.id,again.result.record.id);
  assert.equal(f.store.records(f.staff.user,f.first.id).length,1);
  await assert.rejects(sdk.sendMessage(c.id,{...input,text:'另一个内容'}),{status:409});
  const response=await sdk.sendMessage(c.id,{text:'盘点情况',intent:'query',idempotency_key:'mobile-query-1'});
  assert.equal(response.result.citations[0].id,saved.result.record.id);
  assert.equal((await sdk.getRequest(c.id,response.request_id)).status,'completed');
  const latest=await sdk.getMessages(c.id,{limit:2});assert.equal(latest.messages.length,2);assert.ok(latest.next_before);
  assert.equal((await sdk.getMessages(c.id,{limit:2,before:latest.next_before})).messages.length,2);
  assert.equal((await sdk.listConversations({limit:1})).conversations[0].id,c.id);
  await sdk.correct(f.first.id,{id:saved.result.record.id,version:1,text:'一店盘点仍有差异'});
  const messages=await sdk.getMessages(c.id);assert.equal(messages.messages.at(-1).result.kind,'stale');
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM chat_messages WHERE role=?').all('assistant')).includes('盘点已完成'));
  await sdk.deleteConversation(c.id);await assert.rejects(sdk.getMessages(c.id),{status:404});
  assert.equal(f.store.records(f.staff.user,f.first.id).length,1);
});

test('授权汇总只能在同公司，保存自动推导落点；读者不能从存储层写入',async t=>{
  const f=await fixture(t),r=f.request;
  assert.equal((await r('/api/v1/conversations',{scope_ids:[f.first.id,f.foreign.id]})).status,400);
  const c=await r('/api/v1/conversations',{scope_ids:[f.first.id,f.second.id]});assert.equal(c.status,200);
  const save=await r('/api/v1/conversations/'+c.data.id+'/messages',{text:'各店完成',intent:'save',idempotency_key:'ambiguous'});
  assert.equal(save.data.result.kind,'saved');
  assert.match(save.data.result.answer,/已存入/);
  assert.equal(f.store.records(f.owner.user,f.first.id).length+f.store.records(f.owner.user,f.second.id).length,1);
  assert.equal([f.first.id,f.second.id].includes(save.data.result.record.scope_id),true);
  f.auth.manage(f.owner.user,{action:'grant',id:f.staff.id,scope:f.first.id,role:'reader'});
  assert.throws(()=>f.store.add(f.staff.user,f.first.id,{text:'不允许的写入'}),{status:403});
  assert.equal((await r('/api/v1/records',{text:'不允许的写入',scope_id:f.first.id,idempotency_key:'reader'},f.staff.token)).status,403);
  assert.equal((await r('/api/v1/search',{scope_ids:[f.first.id,f.second.id],query:'盘点'},f.staff.token)).status,403);
});

test('停用账号并重新批准不会恢复外部会话；直接保存要求并校验完整幂等内容',async t=>{
  const f=await fixture(t),token=f.channels.bridge(f.app.id,process.env.HTTP_TEST_BRIDGE_KEY,f.staff.id).token;
  f.auth.manage(f.owner.user,{action:'review',id:f.staff.id,status:'disabled',note:'离职'});
  f.auth.manage(f.owner.user,{action:'review',id:f.staff.id,status:'approved',note:'重新入职'});
  assert.equal((await f.request('/api/v1/me',undefined,token)).status,401);
  const base={scope_id:f.first.id,text:'盘点',idempotency_key:'direct-1',changes:[{title:'盘点',status:'open'}]};
  const first=await f.request('/api/v1/records',base),second=await f.request('/api/v1/records',base);
  assert.equal(first.data.id,second.data.id);
  assert.equal((await f.request('/api/v1/records',{...base,changes:[]})).status,409);
  assert.equal((await f.request('/api/v1/records',{scope_id:f.first.id,text:'缺少幂等键'})).status,400);
  f.store.db.exec('DELETE FROM record_write_receipts');
  assert.equal((await f.request('/api/v1/records',base)).status,409);
  assert.equal(f.store.records(f.owner.user,f.first.id).length,1);
});

test('组织配置页面脚本可执行，动态名称通过文本节点渲染',()=>{
  new Script(organizationPage.match(/<script>([\s\S]*)<\/script>/)[1]);
  assert.ok(!organizationPage.includes('innerHTML'));
  assert.match(organizationPage,/每行一家/);
});
