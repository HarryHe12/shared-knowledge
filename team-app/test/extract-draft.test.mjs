import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {extractDraft} from '../src/extract-draft.mjs';

test('提取发送有限相关事项给模型，只返回待确认草稿且不写入状态',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const user=store.user('员工','draft-test'),scope=store.project(user,'门店');
  for(let batch=0;batch<4;batch++)store.add(user,scope.id,{text:'事项批次'+batch,changes:Array.from({length:30},(_,i)=>({title:'事项'+(batch*30+i),status:'open'}))});
  let calls=0;
  const chat={epoch:()=>store.db.prepare('SELECT value FROM record_epoch').get().value,callModel:async(id,_system,input)=>{
    calls++;assert.equal(id,user.id);assert.equal(input.items.length,100);assert.equal(input.items[0].title,'事项119');
    return JSON.stringify({changes:[{title:'事项119',status:'done'}],ambiguities:[]});
  }};
  const result=await extractDraft(store,chat,user,scope.id,'事项119完成了');
  assert.equal(calls,1);assert.equal(result.requires_confirmation,true);assert.equal(result.coverage.truncated,true);
  assert.equal(store.items(user,scope.id).find(x=>x.title==='事项119').status,'open');
});

test('模型等待期间状态变化时草稿失效，超大或畸形事项元数据不能入库',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const user=store.user('员工','draft-stale'),scope=store.project(user,'门店');
  for(const change of [{title:'x'.repeat(501),status:'open'},{title:'维修',status:'open',owner:{name:'非字符串'}},{title:'维修',status:'open',deadline:'x'.repeat(101)}]){
    assert.throws(()=>store.add(user,scope.id,{text:'维修',changes:[change]}),{status:400});
  }
  assert.equal(store.records(user,scope.id).length,0);
  const chat={epoch:()=>store.db.prepare('SELECT value FROM record_epoch').get().value,callModel:async()=>{
    store.add(user,scope.id,{text:'最新进展'});return '{"changes":[],"ambiguities":[]}';
  }};
  await assert.rejects(extractDraft(store,chat,user,scope.id,'维修完成'),{status:409});
});
