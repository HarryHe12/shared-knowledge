import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {getState,searchRecords} from '../src/evidence.mjs';
test('correction, withdrawal, restoration and erasure propagate to evidence and state',async()=>{
 const s=new Store(':memory:');try{
 const u=s.user('a','a'),p=s.project(u,'p');
 const r=s.add(u,p.id,{text:'库存100，盘点待查',occurred_at:'2026-10-20',idempotency:'one',changes:[{title:'盘点',status:'open'}]});
 const item=s.items(u,p.id)[0];
 const newer=s.add(u,p.id,{text:'盘点完成',occurred_at:'2026-10-21',changes:[{item_id:item.id,title:'盘点',status:'done'}]});
 assert.throws(()=>s.correct(u,p.id,{id:r.id,version:1,text:'库存10'}),{status:400});
 s.correct(u,p.id,{id:r.id,version:1,text:'库存10',changes:[]});
 assert.equal(s.history(u,p.id,r.id).revisions[0].snapshot.record.text,'库存100，盘点待查');
 assert.equal(s.records(u,p.id).find(x=>x.id===r.id).version,2);
 assert.equal(s.search(u,p.id,'100').length,0);
 assert.throws(()=>s.correct(u,p.id,{id:r.id,version:1,text:'旧写入'}),{status:409});
 assert.throws(()=>s.withdraw(s.user('b','b'),p.id,{id:r.id,version:2}),{status:403});
 const member=s.user('c','c');s.grant(p.id,member.id);assert.throws(()=>s.withdraw(member,p.id,{id:r.id,version:2}),{status:403});
 s.withdraw(u,p.id,{id:newer.id,version:1});assert.equal(getState(s,u,p.id).items.length,0);
 s.restore(u,p.id,{id:newer.id,version:2});assert.equal(getState(s,u,p.id).items[0].status,'done');
 s.db.exec('CREATE TABLE embeddings(cache_key TEXT PRIMARY KEY,vector TEXT)');s.db.prepare('INSERT INTO embeddings VALUES(?,?)').run('cache','[1]');
 s.purge(u,p.id,{id:r.id,version:2});
 assert.equal(s.db.prepare('SELECT count(*) n FROM embeddings').get().n,0);
 assert.throws(()=>s.history(u,p.id,r.id),{status:404});
 assert.throws(()=>s.add(u,p.id,{text:'库存100，盘点待查',idempotency:'one'}),{status:409});
 assert.equal((await searchRecords(s,u,p.id,{query:'库存',strategy:'exact'})).records.length,0);
 assert.equal(s.db.prepare('SELECT count(*) n FROM record_revisions WHERE record_id=?').get(r.id).n,0);
 }finally{s.close();}
});
test('withdrawal falls back by business time, correction keeps business time and rejects invalid changes atomically',()=>{
 const s=new Store(':memory:');try{
 const u=s.user('a','a'),p=s.project(u,'p');s.add(u,p.id,{text:'进行中',occurred_at:'2026-10-20',changes:[{title:'任务',status:'open'}]});const item=s.items(u,p.id)[0];
 const r=s.add(u,p.id,{text:'完成',occurred_at:'2026-10-21',changes:[{item_id:item.id,title:'任务',status:'done'}]});
 assert.throws(()=>s.correct(u,p.id,{id:r.id,version:1,text:'错误',changes:[{title:'x',status:'bad'}]}),{status:400});assert.equal(s.history(u,p.id,r.id).revisions.length,0);
 s.withdraw(u,p.id,{id:r.id,version:1});assert.equal(s.items(u,p.id)[0].status,'open');
 s.restore(u,p.id,{id:r.id,version:2});s.correct(u,p.id,{id:r.id,version:3,text:'受阻',changes:[{item_id:item.id,title:'任务',status:'blocked'}]});assert.equal(s.items(u,p.id)[0].status,'blocked');assert.equal(s.records(u,p.id).find(x=>x.id===r.id).occurred_at,r.occurred_at);
 }finally{s.close();}
});
test('in-flight vector retrieval cannot repopulate a cache or return evidence after erasure',async(t)=>{
 const {retrieve}=await import('../src/retrieval.mjs');
 const s=new Store(':memory:');try{
 const u=s.user('a','a'),p=s.project(u,'p'),r=s.add(u,p.id,{text:'secret inventory'});
 t.mock.method(globalThis,'fetch',async()=>{s.purge(u,p.id,{id:r.id,version:1});return new Response(JSON.stringify({data:[{embedding:[1,0]}]}));});
 await assert.rejects(retrieve(s,u,p.id,'inventory',{mode:'vector',embeddingUrl:'https://example.invalid/embeddings',embeddingModel:'test'}),{status:409});
 assert.equal(s.db.prepare('SELECT count(*) n FROM embeddings').get().n,0);
 }finally{s.close();}
});
