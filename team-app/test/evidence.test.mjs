import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {searchRecords,getRecords,getState} from '../src/evidence.mjs';
test('evidence tools preserve scope, state provenance and absence uncertainty',async()=>{
 const s=new Store(':memory:');try{
 const u=s.user('member','token'),p=s.project(u,'default'),other=s.project(u,'other');
 const old=s.add(u,p.id,{text:'东港仓通过 SJ-412 联系',changes:[{title:'交接',status:'open'}],occurred_at:'2026-10-20'});
 const item=s.items(u,p.id)[0];
 const done=s.add(u,p.id,{text:'SJ-412 对应 G72，交接完成',changes:[{item_id:item.id,title:'交接',status:'done'}],occurred_at:'2026-10-21'});
 const contact=s.add(u,p.id,{text:'G72 联系人小林'});
 const hidden=s.add(u,other.id,{text:'G72 私有其他项目'});
 const result=await searchRecords(s,u,p.id,{query:'东港仓',strategy:'exact',depth:2});
 assert.deepEqual(new Set(result.records.map(r=>r.id)),new Set([old.id,done.id,contact.id]));
 assert.equal(result.records[0].author,'member');assert.equal(result.coverage.exhaustive,false);
 const limited=await searchRecords(s,u,p.id,{query:'东港仓',strategy:'exact',depth:2,limit:1});assert.equal(limited.records.length,1);assert.equal(limited.coverage.truncated,true);
 const missing=await searchRecords(s,u,p.id,{query:'ZX-999',strategy:'exact'});assert.deepEqual(missing.records,[]);assert.equal(missing.coverage.exhaustive,false);
 assert.deepEqual(getRecords(s,u,p.id,[hidden.id]).unavailable_ids,[hidden.id]);
 const state=getState(s,u,p.id);assert.equal(state.items[0].status,'done');assert.equal(state.evidence[0].id,done.id);
 await assert.rejects(searchRecords(s,u,p.id,{query:'x',limit:0}),{status:400});
 const outsider=s.user('outsider','outside');await assert.rejects(searchRecords(s,outsider,p.id,{query:'x'}),{status:403});
 }finally{s.close();}
});
