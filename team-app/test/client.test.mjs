import test from 'node:test';
import assert from 'node:assert/strict';
import {KnowledgeClient, KnowledgeError, createFetchTransport, createMiniappTransport} from '../client/knowledge-client.mjs';

const baseUrl='https://knowledge.example.test';
const token='employee-session-private';
const ok=data=>({status:200,data});
function fixture(respond=()=>ok({ok:true})) {
  const requests=[];
  const client=new KnowledgeClient({baseUrl,token,transport:async request=>{requests.push(request);return respond(request);}});
  return {client,requests};
}

test('SDK sends employee credentials only to an immutable HTTPS or local development origin',async()=>{
  for(const unsafe of ['http://knowledge.example.test','//knowledge.example.test','https://user:password@example.test',
    'https://example.test/path','https://example.test?url=evil','https://example.test/#x','https://example.test\\evil',
    'http://localhost.evil.test','http://127.0.0.2','https://example.test:0','https://example.test:65536','https://-invalid.test']) {
    assert.throws(()=>new KnowledgeClient({baseUrl:unsafe,transport:async()=>ok({})}),KnowledgeError);
  }
  for(const safe of [baseUrl,'https://knowledge.example.test/','http://localhost:3000','http://127.0.0.1:8080','http://[::1]:8080']) {
    const client=new KnowledgeClient({baseUrl:safe,token,transport:async()=>ok({})});
    assert.throws(()=>{client.baseUrl='http://evil.test';},TypeError);
    await client.me();
    assert.ok(!JSON.stringify(client).includes(token));
  }
});

test('miniapp login sends only an app-scoped code, then uses the returned employee bearer',async()=>{
  const requests=[];
  const client=new KnowledgeClient({baseUrl,transport:async request=>{
    requests.push(request);
    return request.url.endsWith('/login')?ok({token,user:{id:'approved-staff'},expires_in:3600}):ok({user:{id:'approved-staff'}});
  }});
  await client.capabilities();
  await client.login('registered-app','one-time-code');
  assert.deepEqual(requests[1].body,{code:'one-time-code'});
  assert.equal(requests[1].headers.Authorization,undefined);
  assert.equal(requests[1].url,baseUrl+'/api/v1/channels/registered-app/login');
  await client.me();
  assert.equal(requests[2].headers.Authorization,'Bearer '+token);
  assert.ok(!JSON.stringify(client).includes(token));
  await client.logout();
  await assert.rejects(client.me(),{status:401,code:'unauthenticated'});
});

test('conversations, scope selection, pagination, evidence and lifecycle map to the shared API',async()=>{
  const {client,requests}=fixture();
  await client.createConversation({scope_ids:['store-a','store-a','management-a'],title:'项目进展'});
  assert.deepEqual(requests.at(-1).body,{scope_ids:['store-a','management-a'],title:'项目进展'});
  await client.listConversations({limit:10,before:42,scope_id:'store-a'});
  assert.equal(new URL(requests.at(-1).url).searchParams.get('before'),'42');
  await client.sendMessage('conversation-a',{text:'目前进展如何？',intent:'query',idempotency_key:'question-1'});
  assert.equal(requests.at(-1).url,baseUrl+'/api/v1/conversations/conversation-a/messages');
  await client.getMessages('conversation-a',{limit:20,before:100});
  assert.equal(requests.at(-1).method,'GET');
  await client.getRequest('conversation-a','request-1');
  assert.equal(requests.at(-1).url,baseUrl+'/api/v1/conversations/conversation-a/requests/request-1');
  await client.deleteConversation('conversation-a');
  assert.equal(requests.at(-1).url,baseUrl+'/api/v1/conversations/conversation-a/delete');
  assert.equal(requests.at(-1).method,'POST');
  await client.search(['store-a','management-a'],{query:'项目甲',strategy:'exact',depth:1,limit:10});
  assert.deepEqual(requests.at(-1).body.scope_ids,['store-a','management-a']);
  await client.state('store-a');
  assert.deepEqual(requests.at(-1).body,{scope_id:'store-a'});
  await client.records('store-a',{after:'record-1',limit:20});
  assert.equal(requests.at(-1).headers['X-Knowledge-Scope'],'store-a');
  await client.getRecords('store-a',['record-1']);
  assert.deepEqual(requests.at(-1).body,{scope_id:'store-a',ids:['record-1']});
  await client.extract('store-a','今天完成验收');
  assert.equal(requests.at(-1).body.text,'今天完成验收');
  await client.correct('store-a',{id:'record-1',version:2,text:'更正内容',changes:[]});
  assert.deepEqual(requests.at(-1).body,{id:'record-1',version:2,text:'更正内容',changes:[],scope_id:'store-a'});
  for(const action of ['withdraw','restore','purge']) {
    await client[action]('store-a',{id:'record-1',version:3});
    assert.equal(requests.at(-1).url,baseUrl+'/api/v1/'+action);
  }
  await client.history('store-a','record-1');
  assert.equal(requests.at(-1).headers['X-Knowledge-Scope'],'store-a');
  assert.equal(new URL(requests.at(-1).url).searchParams.get('id'),'record-1');
});

test('writes require a stable caller key and never auto-retry or accept identity overrides',async()=>{
  const {client,requests}=fixture();
  assert.throws(()=>client.save('store-a',{text:'记录'}),/idempotency_key/);
  assert.throws(()=>client.sendMessage('conversation-a',{text:'记录',intent:'save'}),/idempotency_key/);
  assert.throws(()=>client.save('store-a',{text:'记录',idempotency_key:'one',user_id:'owner'}),/身份/);
  assert.throws(()=>client.createConversation({scope_id:'store-a',app_id:'other-app'}),/身份/);
  assert.throws(()=>client.createConversation({scope_id:'store-a',scope_ids:['store-b']}),/scope_id/);
  assert.throws(()=>client.correct('store-a',{id:'record-1',text:'内容'}),/version/);
  assert.throws(()=>client.getMessages('..'),/标识/);
  assert.equal(requests.length,0);
  const input={text:'今天完成验收',idempotency_key:'daily-report-2026-10-25'};
  await client.save('store-a',input);
  await client.save('store-a',input);
  assert.equal(requests.length,2);
  assert.deepEqual(requests[0].body,requests[1].body);
  const conflict=fixture(()=>({status:409,data:{error:'版本已变化，请重新读取后决定'}}));
  await assert.rejects(conflict.client.withdraw('store-a',{id:'record-1',version:1}),{status:409});
  assert.equal(conflict.requests.length,1);
});

test('errors retain safe server status, clear revoked tokens, and sanitize transport failures',async()=>{
  let status=403;
  const {client,requests}=fixture(()=>({status,data:{error:'无此范围的操作权限'}}));
  await assert.rejects(client.me(),{status:403,code:'http_error'});
  status=401;
  await assert.rejects(client.me(),{status:401});
  await assert.rejects(client.me(),{code:'unauthenticated'});
  assert.equal(requests.length,2);
  client.setToken(token);
  const broken=new KnowledgeClient({baseUrl,token,transport:async()=>{throw new Error('leaked '+token);}});
  await assert.rejects(broken.me(),error=>error.code==='network_error'&&!error.message.includes(token));
  const malformed=new KnowledgeClient({baseUrl,token,transport:async()=>({status:200,data:'<html>error</html>'})});
  await assert.rejects(malformed.me(),{code:'invalid_response'});
});

test('default fetch adapter disables redirects and cookies and enforces timeout without exposing credentials',async()=>{
  let captured;
  const transport=createFetchTransport(async(url,input)=>{
    captured={url,input};
    return {status:200,json:async()=>({ok:true})};
  });
  const client=new KnowledgeClient({baseUrl,token,transport});
  await client.save('store-a',{text:'工作记录',idempotency_key:'write-1'});
  assert.equal(captured.input.credentials,'omit');
  assert.equal(captured.input.redirect,'error');
  assert.equal(captured.input.cache,'no-store');
  assert.equal(JSON.parse(captured.input.body).idempotency_key,'write-1');
  const aborted=createFetchTransport(async(url,input)=>{input.signal.throwIfAborted();throw new Error('request '+token);});
  await assert.rejects(aborted({url:baseUrl,method:'GET',headers:{},timeoutMs:1000}),error=>error.code==='network_error'&&!error.message.includes(token));
  const stalled=createFetchTransport((url,input)=>new Promise((resolve,reject)=>{
    input.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});
  }));
  await assert.rejects(stalled({url:baseUrl,method:'GET',headers:{},timeoutMs:1}),{code:'timeout'});
});

test('wx request adapter uses injected transport, JSON and the same employee and scope headers',async()=>{
  let options;
  const transport=createMiniappTransport(input=>{
    options=input;
    input.success({statusCode:200,data:'{"records":[]}'});
  });
  const client=new KnowledgeClient({baseUrl,token,transport,timeoutMs:30000});
  assert.deepEqual(await client.records('store-a'),{records:[]});
  assert.equal(options.header.Authorization,'Bearer '+token);
  assert.equal(options.header['X-Knowledge-Scope'],'store-a');
  assert.equal(options.timeout,30000);
  assert.equal(options.dataType,'json');
  const timedOut=createMiniappTransport(input=>input.fail({errMsg:'request:fail timeout'}));
  await assert.rejects(timedOut({timeoutMs:1000}),{code:'timeout'});
  const malformed=createMiniappTransport(input=>input.success({statusCode:502,data:'not json'}));
  await assert.rejects(malformed({timeoutMs:1000}),{code:'invalid_response'});
});
