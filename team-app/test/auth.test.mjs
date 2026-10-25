import {Script} from 'node:vm';
import {authPage} from '../src/auth-page.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {Store} from '../src/store.mjs';
import {Auth} from '../src/auth.mjs';
import {createKnowledgeServer} from '../src/http.mjs';
const registration={name:'测试成员',email:'member@example.test',department:'产品',reason:'工作资料',password:'test-password-12345'};
test('approval, explicit scope grants, rejection, revocation and password hashing',async()=>{
 const store=new Store(':memory:');try{const p=store.defaultProject(),auth=new Auth(store,p);const adminId=(await auth.register({...registration,email:'admin@example.test'},true)).id;
 const admin=auth.user((await auth.login({email:'admin@example.test',password:registration.password})).token);
 const id=(await auth.register(registration)).id;assert.notEqual(store.db.prepare('SELECT password FROM accounts WHERE user_id=?').get(id).password,registration.password);
 await assert.rejects(auth.login({...registration,password:'wrong'}),/邮箱或密码错误/);
 const token=(await auth.login(registration)).token,pending=auth.user(token);assert.throws(()=>auth.authorize(pending,p.id),/尚未获准/);
 assert.throws(()=>auth.manage(pending,{action:'scope',name:'越权'}),/管理员/);
 const device=auth.start();auth.bind(pending,device.code);assert.equal(auth.poll(device.device_token).status,'pending');
 auth.manage(admin,{action:'review',id,status:'approved',note:'已人工核实邮箱和部门'});const approved=auth.user(token);assert.throws(()=>auth.authorize(approved,p.id),/无此范围/);
 auth.manage(admin,{action:'grant',id,scope:p.id,role:'reader'});auth.authorize(approved,p.id);assert.throws(()=>auth.authorize(approved,p.id,true),/操作权限/);
 const session=auth.poll(device.device_token);assert.ok(session.token);const sessionUser=auth.user(session.token);auth.db.prepare('UPDATE auth_sessions SET expires=? WHERE hash=?').run(Date.now()+1000,sessionUser.session_hash);auth.user(session.token);assert.ok(auth.db.prepare('SELECT expires FROM auth_sessions WHERE hash=?').get(sessionUser.session_hash).expires>Date.now()+86400000);assert.throws(()=>auth.poll(device.device_token),/过期/);
 auth.manage(admin,{action:'scope',name:'机密'});const scope=auth.overview(admin).scopes.find(s=>s.id!==p.id);assert.throws(()=>auth.authorize(approved,scope.id),/权限/);
 auth.manage(admin,{action:'grant',id,scope:p.id,role:'writer'});auth.authorize(approved,p.id,true);
 auth.manage(admin,{action:'grant',id,scope:p.id,role:'none'});assert.throws(()=>store.records(approved,p.id),/权限/);
 auth.manage(admin,{action:'revoke',id:auth.user(session.token).session_hash});assert.equal(auth.user(session.token),undefined);
 auth.manage(admin,{action:'review',id,status:'disabled',note:'停用'});assert.equal(auth.user(token),undefined);await assert.rejects(auth.login(registration),/停用/);
 assert.ok(auth.overview(admin).audit.length>=8);assert.throws(()=>auth.manage(admin,{action:'review',id:adminId,status:'disabled',note:''}),/管理员/);
 }finally{store.close();}
});
test('HTTP registration, browser cookie, approval, scope isolation and reader enforcement',async()=>{
 const store=new Store(':memory:'),p=store.defaultProject();const server=createKnowledgeServer(store,()=>{},p);const auth=new Auth(store,p);
 await auth.register({...registration,email:'admin@example.test'},true);const admin=auth.user((await auth.login({...registration,email:'admin@example.test'})).token);
 server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 const req=(path,body,token,scope,origin)=>fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(scope?{'X-Knowledge-Scope':scope}:{}),...(origin?{Origin:origin}:{})},body:body?JSON.stringify(body):undefined});
 try{
 assert.equal((await req('/admin')).status,200);assert.equal((await req('/api/records')).status,401);
 const registered=await req('/api/auth/register',registration);assert.equal(registered.status,201);const {id}=await registered.json();
 const login=await req('/api/auth/login',registration);assert.ok(login.headers.get('set-cookie').includes('HttpOnly'));assert.deepEqual(await login.json(),{ok:true});
 const token=(await auth.login(registration)).token;assert.equal((await req('/api/records',undefined,token)).status,403);
 assert.equal((await req('/api/admin',undefined,token)).status,403);
 assert.equal((await req('/api/auth/register',registration,undefined,undefined,'https://evil.test')).status,403);
 auth.manage(admin,{action:'review',id,status:'approved',note:'核实'});auth.manage(admin,{action:'grant',id,scope:p.id,role:'reader'});
 assert.equal((await req('/api/records',undefined,token)).status,200);assert.equal((await req('/api/records',{text:'禁止写入'},token)).status,403);
 auth.manage(admin,{action:'scope',name:'部门秘密'});const scope=auth.overview(admin).scopes.find(s=>s.id!==p.id);const author=store.user('legacy','legacy-token');store.grant(scope.id,author.id);const secret=store.add(author,scope.id,{text:'不应泄露的内容'});
 assert.equal((await req('/api/records',undefined,token,scope.id)).status,403);assert.deepEqual((await (await req('/api/get-records',{ids:[secret.id]},token)).json()).records,[]);
 assert.equal((await req('/api/record-history?id='+secret.id,undefined,token)).status,404);
 auth.manage(admin,{action:'grant',id,scope:p.id,role:'writer'});assert.equal((await req('/api/records',{text:'可写内容'},token)).status,200);
 auth.manage(admin,{action:'review',id,status:'disabled',note:'停用'});assert.equal((await req('/api/records',undefined,token)).status,401);
 }finally{await new Promise(r=>server.close(r));store.close();}
});

test('browser script compiles and password forms never fall back to GET',()=>{new Script(authPage.match(/<script>([\s\S]*)<\/script>/)[1]);assert.match(authPage,/<form id="login" method="post"/);assert.match(authPage,/<form id="register" method="post"/);});

test('hard session expiry and live admin state override cached identity objects',async()=>{
 const store=new Store(':memory:');try{
  const auth=new Auth(store,store.defaultProject());await auth.register({...registration,email:'expiry-admin@example.test'},true);
  const token=(await auth.login({email:'expiry-admin@example.test',password:registration.password})).token,cached=auth.user(token);
  auth.db.prepare('UPDATE auth_sessions SET expires=?,hard_expires=? WHERE hash=?').run(Date.now()+86400000,Date.now()-1,cached.session_hash);
  assert.equal(auth.user(token),undefined);
  auth.db.prepare("UPDATE accounts SET status='disabled' WHERE user_id=?").run(cached.id);
  assert.throws(()=>auth.manage(cached,{action:'scope',name:'缓存身份越权'}),{status:403});
 }finally{store.close();}
});
