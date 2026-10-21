import test from 'node:test';
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
 const server=createKnowledgeServer(store,model,p);
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
   const child=spawn(process.execPath,['team-app/scripts/knowledge.mjs',...args],{env:{...process.env,TEAM_KB_TOKEN:token,TEAM_KB_URL:url},stdio:['ignore','pipe','pipe']});
   let out='',err='';child.stdout.on('data',s=>out+=s);child.stderr.on('data',s=>err+=s);child.on('error',reject);child.on('exit',code=>code===0?resolve(JSON.parse(out)):reject(new Error(err)));
  });
  const saved=await client('save','--file',file,'--idempotency','same-save');
  assert.equal((await client('save','--file',file,'--idempotency','same-save')).id,saved.id);
  const snapshot=await client('snapshot');assert.equal(snapshot.records.length,1);assert.equal(snapshot.records[0].text,text);assert.deepEqual(snapshot.items,[]);
  assert.equal(calls,0);
  assert.equal((await request('/api/projects/'+p.id+'/records')).status,200);
  const response=await client('ask','--question','总结进展');assert.equal(response.status,'insufficient');assert.ok(calls>0);
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
