#!/usr/bin/env node
import {credential,profile,saveProfile} from './session.mjs';
// All service operations live in the project; the Skill only invokes this client.
import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';

export async function run(args=process.argv.slice(2),env=process.env){
 const {values,positionals}=parseArgs({args,allowPositionals:true,options:{
  scope:{type:'string'},id:{type:'string'},version:{type:'string'},query:{type:'string'},ids:{type:'string'},limit:{type:'string'},depth:{type:'string'},strategy:{type:'string'},url:{type:'string'},'token-file':{type:'string'},file:{type:'string'},question:{type:'string'},reply:{type:'string'},
  'clarification-id':{type:'string'},item:{type:'string'},'changes-file':{type:'string'},'occurred-at':{type:'string'},idempotency:{type:'string'},
 }});
 const [command]=positionals;
 if(!command||command==='help'){console.log('knowledge.mjs login|register [--url URL]|whoami|use-scope --scope ID|logout|records|items|snapshot|timeline --item ID|save --file FILE [--changes-file FILE] [--idempotency KEY]|extract --file FILE|search --query TEXT [--strategy hybrid|exact] [--limit 15] [--depth 1]|get --ids ID,ID|state|history --id ID|correct --id ID --version N --file FILE [--changes-file FILE]|withdraw|restore|purge --id ID --version N');return;}
 const saved=await profile();
 const url=new URL(values.url??env.TEAM_KB_URL??saved.url??'http://127.0.0.1:5181');
 if(url.username||url.password)throw new Error('服务地址不可包含凭证');
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw new Error('远程知识服务必须使用 HTTPS');
 const service='shared-knowledge:'+url.origin;
 const authRequest=async(path,body,token)=>{const r=await fetch(new URL('/api/'+path,url),{method:body?'POST':'GET',redirect:'error',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});const data=await r.json();if(!r.ok)throw new Error(data.error??'认证失败');return data;};
 if(command==='login'||command==='register'){
  let pending=await credential(service+':pending');
  if(pending){try{const result=await authRequest('auth/device-poll',{device_token:pending});if(result.token){await credential(service,result.token);await credential(service+':pending',null);await saveProfile({...saved,url:url.origin});console.log('登录成功');return;}if(result.status==='rejected'||result.status==='disabled'){console.log('申请状态：'+result.status);return;}if(result.code)console.log('请打开 '+new URL('/account?code='+result.code,url).href+' 并核对设备码 '+result.code);console.log('申请状态：'+result.status+'；如果已绑定设备，请等待审批后再次运行 login。');return;}catch(e){if(!e.message.includes('过期'))throw e;await credential(service+':pending',null);}}
  const device=await authRequest('auth/device-start',{});await credential(service+':pending',device.device_token);await saveProfile({...saved,url:url.origin});console.log('请打开 '+new URL('/account?code='+device.code,url).href+' 注册或登录，并确认设备码 '+device.code+'。完成审批后再次运行 login。设备码10分钟有效，过期可重新登录，账号无需重注册。');return;
 }
 if(command==='logout'){const current=await credential(service);if(current)await authRequest('auth/logout',{},current);await credential(service,null);await credential(service+':pending',null);console.log('已退出');return;}
 if(command==='use-scope'){const current=await credential(service);const me=await authRequest('auth/me',undefined,current);if(!me.scopes.some(s=>s.id===values.scope))throw new Error('无此范围权限');await saveProfile({...saved,url:url.origin,scope:values.scope});console.log('已选择知识范围');return;}
 if(command==='whoami'){console.log(JSON.stringify(await authRequest('auth/me',undefined,await credential(service)),null,2));return;}
 const tokenFile=values['token-file']??env.TEAM_KB_TOKEN_FILE??new URL('../.data/token',import.meta.url);
 const token=(env.TEAM_KB_TOKEN??(await readFile(tokenFile,'utf8').catch(error=>{if(error.code==='ENOENT'&&!values['token-file']&&!env.TEAM_KB_TOKEN_FILE)return '';throw error;})).trim())|| (process.platform==='darwin'?await credential(service):'');
 const required=key=>{if(!values[key])throw new Error('缺少 --'+key);return values[key];};
 const request=async(path,body)=>{
  const response=await fetch(new URL('/api/'+path,url),{method:body?'POST':'GET',redirect:'error',headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json',...((values.scope??saved.scope)?{'X-Knowledge-Scope':values.scope??saved.scope}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(240000)});
  const result=await response.json();if(!response.ok)throw new Error('HTTP '+response.status+': '+(result.error??'请求失败'));return result;
 };
 let result;
 if(command==='snapshot')result={records:await request('records'),items:await request('items')};
 else if(command==='search')result=await request('search',{query:required('query'),...(values.limit?{limit:Number(values.limit)}:{}),...(values.depth?{depth:Number(values.depth)}:{}),...(values.strategy?{strategy:values.strategy}:{})});
 else if(command==='get')result=await request('get-records',{ids:required('ids').split(',')});
 else if(command==='history')result=await request('record-history?id='+encodeURIComponent(required('id')));
 else if(['correct','withdraw','restore','purge'].includes(command)){
  const body={id:required('id'),version:Number(required('version'))};
  if(command==='correct'){body.text=await readFile(required('file'),'utf8');if(values['changes-file'])body.changes=JSON.parse(await readFile(values['changes-file'],'utf8'));if(values['occurred-at'])body.occurred_at=values['occurred-at'];}
  result=await request(command,body);
 }
 else if(command==='state')result=await request('state');
 else if(['records','items'].includes(command))result=await request(command);
 else if(command==='timeline')result=await request('timeline?item='+encodeURIComponent(required('item')));
 else if(command==='ask')result=await request('ask',{question:required('question')});
 else if(command==='reply')result=await request('ask',{clarification_id:required('clarification-id'),reply:required('reply')});
 else if(command==='save'||command==='extract'){
  const text=await readFile(required('file'),'utf8');
  const body={text};
  if(command==='save'){
   body.changes=values['changes-file']?JSON.parse(await readFile(values['changes-file'],'utf8')):[];
   if(values['occurred-at'])body.occurred_at=values['occurred-at'];
   if(values.idempotency)body.idempotency=values.idempotency;
  }
  result=await request(command==='save'?'records':'extract',body);
 }else throw new Error('未知命令；运行 help 查看用法');
 console.log(JSON.stringify(result,null,2));
}
import {pathToFileURL} from 'node:url';
if(import.meta.url===pathToFileURL(process.argv[1]??'').href)run().catch(error=>{console.error(error.message);process.exitCode=1;});
