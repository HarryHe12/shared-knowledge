import test from 'node:test';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {Store} from '../src/store.mjs';
import {databaseFile} from '../src/paths.mjs';
import {mkdir} from 'node:fs/promises';
import {createKnowledgeServer} from '../src/http.mjs';

test('default selection reuses a single project, persists, and refuses ambiguous data',()=>{
 const store=new Store(':memory:');
 try{
  const user=store.user('u','test-token');const a=store.project(user,'a');const b=store.project(user,'b');
  assert.throws(()=>store.defaultProject(),/多个旧项目/);
  assert.equal(store.defaultProject(a.id).id,a.id);
  assert.equal(store.defaultProject().id,a.id);
  assert.throws(()=>store.defaultProject(b.id),/已固定/);
  assert.throws(()=>store.defaultProject('missing'),/已固定/);
 }finally{store.close();}
 const single=new Store(':memory:');try{const u=single.user('u','t');const p=single.project(u,'old');assert.equal(single.defaultProject().id,p.id);}finally{single.close();}
});

test('headless HTTP and repository client save/read, deny unauthorized and non-default access',async()=>{
 const store=new Store(':memory:');const p=store.defaultProject();const token='disposable-default-service-token';
 const user=store.user('tester',token);store.grant(p.id,user.id);
 const outsider=store.user('outsider','outsider');const other=store.project(user,'other');
 let calls=0;const model=async()=>{calls++;return JSON.stringify({action:'answer',answer:'本轮证据不足',quality:'insufficient',citations:[]});};
 const server=createKnowledgeServer(store,model,p,{allowLegacyTokens:true});
 server.listen(0,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+server.address().port;
 const dir=await mkdtemp(join(tmpdir(),'knowledge-client-'));
 const request=(path,body,auth=token)=>fetch(url+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 try{
  assert.equal((await request('/')).status,404);
  assert.equal((await request('/api/records',null,'bad')).status,401);
  assert.equal((await request('/api/records',null,'outsider')).status,403);
  assert.equal((await request('/api/projects/'+other.id+'/records')).status,404);
  assert.equal((await request('/api/projects',{name:'new'})).status,404);
  assert.deepEqual(await (await request('/api/projects')).json(),[p]);
  assert.equal((await request('/api/records',{text:''})).status,400);
  assert.equal((await request('/api/records',[])).status,400);
  const text='中文原文，待用户确认事项。';const file=join(dir,'record.txt');await writeFile(file,text);
  const client=(...args)=>new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/knowledge.mjs', import.meta.url)),...args],{env:{...process.env,TEAM_KB_TOKEN:token,TEAM_KB_URL:url},stdio:['ignore','pipe','pipe']});
   let out='',err='';child.stdout.on('data',s=>out+=s);child.stderr.on('data',s=>err+=s);child.on('error',reject);child.on('exit',code=>code===0?resolve(JSON.parse(out)):reject(new Error(err)));
  });
  const saved=await client('save','--file',file,'--idempotency','same-save');
  assert.equal((await client('save','--file',file,'--idempotency','same-save')).id,saved.id);
  const snapshot=await client('snapshot');assert.equal(snapshot.records.length,1);assert.equal(snapshot.records[0].text,text);assert.deepEqual(snapshot.items,[]);
  assert.equal(calls,0);
  assert.equal((await request('/api/projects/'+p.id+'/records')).status,200);
  const response=await client('search','--query','中文原文');assert.equal(response.records[0].id,saved.id);
  assert.equal((await client('get','--ids',saved.id)).records[0].text,text);
  assert.deepEqual((await client('state')).items,[]);
  assert.equal((await request('/api/ask',{question:'总结进展'})).status,410);assert.equal(calls,0);
  await writeFile(file,'更正后的原文');
  assert.equal((await client('correct','--id',saved.id,'--version','1','--file',file)).version,2);
  assert.equal((await client('history','--id',saved.id)).revisions.length,1);
  await client('withdraw','--id',saved.id,'--version','2');assert.equal((await client('get','--ids',saved.id)).records.length,0);
  await client('restore','--id',saved.id,'--version','3');assert.equal((await client('get','--ids',saved.id)).records[0].text,'更正后的原文');
  await client('purge','--id',saved.id,'--version','4');assert.equal((await client('get','--ids',saved.id)).records.length,0);
 }finally{await new Promise(r=>server.close(r));store.close();await rm(dir,{recursive:true,force:true});}
});

test('database path reuses one existing file and refuses multiple candidates',async()=>{
 const root=await mkdtemp(join(tmpdir(),'knowledge-path-'));
 try{
  assert.equal(await databaseFile(root,''),join(root,'.data/team.sqlite'));
  await mkdir(join(root,'.data'));await writeFile(join(root,'.data/demo.sqlite'),'');
  assert.equal(await databaseFile(root,''),join(root,'.data/demo.sqlite'));
  await writeFile(join(root,'.data/another.sqlite'),'');
  await assert.rejects(databaseFile(root,''),/多个本地数据库/);
  assert.equal(await databaseFile(root,'.data/demo.sqlite'),join(root,'.data/demo.sqlite'));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('local validation accepts tokenless writes and keeps one author across server restarts',async()=>{
 const store=new Store(':memory:');const p=store.defaultProject();
 const other=store.project(store.user('other','other-token'),'other');
 let saved;
 try{
  for(let i=0;i<2;i++){
   const server=createKnowledgeServer(store,async()=>{},p,{authRequired:false});
   server.listen(0,'127.0.0.1');await once(server,'listening');
   const url='http://127.0.0.1:'+server.address().port;
   try{
    const response=await fetch(url+'/api/records',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'验证原文',idempotency:'stable'})});
    assert.equal(response.status,200);const record=await response.json();
    if(saved)assert.equal(record.id,saved.id);saved=record;
    const snapshot=await new Promise((resolve,reject)=>{
     const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/knowledge.mjs', import.meta.url)),'snapshot'],{env:{...process.env,TEAM_KB_TOKEN:'',TEAM_KB_URL:url},stdio:['ignore','pipe','pipe']});
     let out='',err='';child.stdout.on('data',s=>out+=s);child.stderr.on('data',s=>err+=s);child.on('error',reject);child.on('exit',code=>code===0?resolve(JSON.parse(out)):reject(new Error(err)));
    });
    assert.equal(snapshot.records.length,1);
    assert.equal((await fetch(url+'/api/projects/'+other.id+'/records')).status,404);
    assert.equal((await fetch(url+'/api/records',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"text":""}'})).status,400);
    assert.equal((await fetch(url+'/api/records',{headers:{Origin:'https://example.com'}})).status,403);
   }finally{await new Promise(r=>server.close(r));}
  }
  assert.equal(saved.author_id,'local-validation-user');
 }finally{store.close();}
});
