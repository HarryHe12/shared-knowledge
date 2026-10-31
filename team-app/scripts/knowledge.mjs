#!/usr/bin/env node
import {credential,profile,saveProfile} from './session.mjs';
// All service operations live in the project; the Skill only invokes this client.
import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {randomUUID} from 'node:crypto';

function primaryTenantId(scopes = []) {
 const counts = new Map();
 for (const s of scopes) if (s?.tenant_id) counts.set(s.tenant_id, (counts.get(s.tenant_id) ?? 0) + 1);
 let best = null, max = 0;
 for (const [id, n] of counts) if (n > max) { best = id; max = n; }
 return best;
}

function pickDefaultScope(scopes = []) {
 const active = scopes.filter(s => s && ['writer', 'reader'].includes(s.role));
 const mainTenant = primaryTenantId(active);
 const inMain = mainTenant ? active.filter(s => s.tenant_id === mainTenant) : active;
 return inMain.find(s => s.tenant_id && s.role === 'writer' && s.level !== 'executive')
  ?? inMain.find(s => s.tenant_id && s.role === 'writer')
  ?? inMain.find(s => s.tenant_id)
  ?? active.find(s => s.role === 'writer')
  ?? active[0] ?? null;
}

export async function run(args=process.argv.slice(2),env=process.env,deps={}){
 const fetchImpl=deps.fetch??globalThis.fetch;
 const cred=deps.credential??credential;
 const readProfile=deps.profile??profile;
 const writeProfile=deps.saveProfile??saveProfile;
 const sleep=deps.sleep??(ms=>new Promise(r=>setTimeout(r,ms)));
 const log=deps.log??console.log;
 const platform=deps.platform??process.platform;
 const {values,positionals}=parseArgs({args,allowPositionals:true,options:{
  scope:{type:'string'},id:{type:'string'},version:{type:'string'},query:{type:'string'},ids:{type:'string'},limit:{type:'string'},depth:{type:'string'},strategy:{type:'string'},url:{type:'string'},'token-file':{type:'string'},file:{type:'string'},text:{type:'string'},question:{type:'string'},reply:{type:'string'},
  'clarification-id':{type:'string'},item:{type:'string'},'changes-file':{type:'string'},'occurred-at':{type:'string'},idempotency:{type:'string'},wait:{type:'boolean'},all:{type:'boolean'},
 }});
 const [command]=positionals;
 if(!command||command==='help'){log('knowledge.mjs login [--url URL] [--wait]|whoami|use-scope --scope ID|logout|search-all --query TEXT [--limit 15]|chat-save (--text TEXT|--file FILE) [--idempotency KEY]|records|items|snapshot|timeline --item ID|save (--file FILE|--text TEXT) [--changes-file FILE] [--idempotency KEY]|extract (--file FILE|--text TEXT)|search --query TEXT [--all] [--strategy hybrid|exact] [--limit 15] [--depth 1]|get --ids ID,ID|state|history --id ID|correct --id ID --version N (--file FILE|--text TEXT) [--changes-file FILE]|withdraw|restore|purge --id ID --version N');return;}
 const saved=await readProfile();
 const url=new URL(values.url??env.TEAM_KB_URL??saved.url??'http://127.0.0.1:5181');
 if(url.username||url.password)throw new Error('服务地址不可包含凭证');
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw new Error('远程知识服务必须使用 HTTPS');
 const service='shared-knowledge:'+url.origin;
 const authRequest=async(path,body,token)=>{const r=await fetchImpl(new URL('/api/'+path,url),{method:body?'POST':'GET',redirect:'error',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});const data=await r.json();if(!r.ok)throw new Error(data.error??'认证失败');return data;};
 const finishLogin=async(token)=>{
  await cred(service,token);await cred(service+':pending',null);
  let nextScope=saved.scope;
  try{
   const me=await authRequest('auth/me',undefined,token);
   if(!nextScope||!me.scopes?.some(s=>s.id===nextScope))nextScope=pickDefaultScope(me.scopes)?.id;
  }catch{}
  await writeProfile({...saved,url:url.origin,...(nextScope?{scope:nextScope}:{})});
  log('登录成功'+(nextScope?'（已自动设置默认知识范围）':''));
 };
 if(command==='login'||command==='register'){
  let pending=await cred(service+':pending');
  if(pending){
   try{
    const result=await authRequest('auth/device-poll',{device_token:pending});
    if(result.token){await finishLogin(result.token);return;}
    if(result.status==='rejected'||result.status==='disabled'){log('申请状态：'+result.status);return;}
    if(!values.wait){
     if(result.code)log('请打开 '+new URL('/account?code='+result.code,url).href+' 并核对设备码 '+result.code);
     log('申请状态：'+result.status+'；如果已绑定设备，请等待审批后再次运行 login。');return;
    }
    if(result.code)log('请打开 '+new URL('/account?code='+result.code,url).href+' 登录并确认设备码 '+result.code+'（正在等待浏览器确认…）');
   }catch(e){if(!e.message.includes('过期'))throw e;await cred(service+':pending',null);pending='';}
  }
  if(!pending){
   const device=await authRequest('auth/device-start',{});pending=device.device_token;
   await cred(service+':pending',pending);await writeProfile({...saved,url:url.origin});
   log('请打开 '+new URL('/account?code='+device.code,url).href+' 注册或登录，并确认设备码 '+device.code+(values.wait?'（正在等待浏览器确认，最长5分钟…）':'。完成审批后再次运行 login。设备码10分钟有效，过期可重新登录，账号无需重注册。'));
   if(!values.wait)return;
  }
  for(let i=0;i<100;i++){
   await sleep(3000);
   const result=await authRequest('auth/device-poll',{device_token:pending});
   if(result.token){await finishLogin(result.token);return;}
   if(result.status==='rejected'||result.status==='disabled'){log('申请状态：'+result.status);return;}
  }
  throw new Error('等待浏览器确认超时，请确认后重新执行 login');
 }
 if(command==='logout'){const current=await cred(service);if(current)await authRequest('auth/logout',{},current);await cred(service,null);await cred(service+':pending',null);log('已退出');return;}
 if(command==='use-scope'){const current=await cred(service);const me=await authRequest('auth/me',undefined,current);if(!me.scopes.some(s=>s.id===values.scope))throw new Error('无此范围权限');await writeProfile({...saved,url:url.origin,scope:values.scope});log('已选择知识范围');return;}
 if(command==='whoami'){log(JSON.stringify(await authRequest('auth/me',undefined,await cred(service)),null,2));return;}
 const tokenFile=values['token-file']??env.TEAM_KB_TOKEN_FILE??new URL('../.data/token',import.meta.url);
 const explicitToken=env.TEAM_KB_TOKEN??(await readFile(tokenFile,'utf8').catch(error=>{if(error.code==='ENOENT'&&!values['token-file']&&!env.TEAM_KB_TOKEN_FILE)return '';throw error;})).trim();
 const storedToken=explicitToken?'':(['darwin','win32'].includes(platform)?await cred(service):'');
 const token=explicitToken||storedToken;
 const required=key=>{if(!values[key])throw new Error('缺少 --'+key);return values[key];};
 const v1=async(path,body)=>{
  const r=await fetchImpl(new URL('/api/v1/'+path,url),{method:body?'POST':'GET',redirect:'error',headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(240000)});
  const data=await r.json();const err=new Error('HTTP '+r.status+': '+(data.error??'请求失败'));err.status=r.status;if(!r.ok)throw err;return data;
 };
 let activeScope=values.scope??saved.scope;
 if(!activeScope&&storedToken){
  try{
   const me=await v1('me');const picked=pickDefaultScope(me.scopes);
   if(picked){activeScope=picked.id;await writeProfile({...saved,url:url.origin,scope:activeScope});}
  }catch{}
 }
 const request=async(path,body)=>{
  const response=await fetchImpl(new URL('/api/'+path,url),{method:body?'POST':'GET',redirect:'error',headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json',...(activeScope?{'X-Knowledge-Scope':activeScope}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(240000)});
  const result=await response.json();if(!response.ok)throw new Error('HTTP '+response.status+': '+(result.error??'请求失败'));return result;
 };
 const readBodyText=async()=>{
  if(values.text!==undefined){if(!values.text.trim())throw new Error('缺少内容');return values.text;}
  return readFile(required('file'),'utf8');
 };
 let result;
 if(command==='search-all'||(command==='search'&&values.all)){
  const me=await v1('me');
  const allScopes=me.scopes??[];
  const preferredTenant=allScopes.find(s=>s.id===activeScope)?.tenant_id??primaryTenantId(allScopes);
  const companyScopes=preferredTenant?allScopes.filter(s=>s.tenant_id===preferredTenant):[];
  const scopeIds=(companyScopes.length?companyScopes:allScopes.slice(0,1)).map(s=>s.id).slice(0,40);
  if(!scopeIds.length)throw new Error('当前账号尚未开通任何知识范围');
  result=await v1('search',{scope_ids:scopeIds,query:required('query'),...(values.limit?{limit:Number(values.limit)}:{}),...(values.depth?{depth:Number(values.depth)}:{}),...(values.strategy?{strategy:values.strategy}:{})});
 }else if(command==='chat-save'){
  const text=await readBodyText();
  const me=await v1('me');
  const allScopes=me.scopes??[];
  const preferredTenant=allScopes.find(s=>s.id===activeScope&&s.tenant_id)?.tenant_id??primaryTenantId(allScopes.filter(s=>s.role==='writer'&&s.level!=='executive'));
  const writable=preferredTenant?allScopes.filter(s=>s.tenant_id===preferredTenant&&s.role==='writer'&&s.level!=='executive'):[];
  const fallbackWritable=allScopes.filter(s=>!s.tenant_id&&s.role==='writer'&&s.level!=='executive').slice(0,1);
  const scopeIds=(writable.length?writable:fallbackWritable).map(s=>s.id).slice(0,40);
  if(!scopeIds.length)throw new Error('当前账号没有可写入的知识范围');
  const scopeKey=scopeIds.join(',');
  const idempotencyKey=values.idempotency??('agent-save:'+randomUUID());
  const payload={text,intent:'save',idempotency_key:idempotencyKey,...(values['occurred-at']?{occurred_at:values['occurred-at']}:{})};
  let convId=saved.agent_conversation_id&&saved.agent_conversation_scopes===scopeKey?saved.agent_conversation_id:'';
  const createConv=async()=>{
   const conv=await v1('conversations',{scope_ids:scopeIds,title:'Agent 录入'});
   convId=conv.id;
   await writeProfile({...(await readProfile()),url:url.origin,...(activeScope?{scope:activeScope}:{}),agent_conversation_id:convId,agent_conversation_scopes:scopeKey});
  };
  if(!convId)await createConv();
  try{
   result=await v1('conversations/'+encodeURIComponent(convId)+'/messages',payload);
  }catch(e){
   if(e.status!==404&&e.status!==403)throw e;
   await createConv();
   result=await v1('conversations/'+encodeURIComponent(convId)+'/messages',payload);
  }
 }else if(command==='snapshot')result={records:await request('records'),items:await request('items')};
 else if(command==='search')result=await request('search',{query:required('query'),...(values.limit?{limit:Number(values.limit)}:{}),...(values.depth?{depth:Number(values.depth)}:{}),...(values.strategy?{strategy:values.strategy}:{})});
 else if(command==='get')result=await request('get-records',{ids:required('ids').split(',')});
 else if(command==='history')result=await request('record-history?id='+encodeURIComponent(required('id')));
 else if(['correct','withdraw','restore','purge'].includes(command)){
  const body={id:required('id'),version:Number(required('version'))};
  if(command==='correct'){body.text=await readBodyText();if(values['changes-file'])body.changes=JSON.parse(await readFile(values['changes-file'],'utf8'));if(values['occurred-at'])body.occurred_at=values['occurred-at'];}
  result=await request(command,body);
 }
 else if(command==='state')result=await request('state');
 else if(['records','items'].includes(command))result=await request(command);
 else if(command==='timeline')result=await request('timeline?item='+encodeURIComponent(required('item')));
 else if(command==='ask')result=await request('ask',{question:required('question')});
 else if(command==='reply')result=await request('ask',{clarification_id:required('clarification-id'),reply:required('reply')});
 else if(command==='save'||command==='extract'){
  const text=await readBodyText();
  const body={text};
  if(command==='save'){
   body.changes=values['changes-file']?JSON.parse(await readFile(values['changes-file'],'utf8')):[];
   if(values['occurred-at'])body.occurred_at=values['occurred-at'];
   if(values.idempotency)body.idempotency=values.idempotency;
  }
  result=await request(command==='save'?'records':'extract',body);
 }else throw new Error('未知命令；运行 help 查看用法');
 log(JSON.stringify(result,null,2));
 return result;
}
import {pathToFileURL} from 'node:url';
if(import.meta.url===pathToFileURL(process.argv[1]??'').href)run().catch(error=>{console.error(error.message);process.exitCode=1;});
