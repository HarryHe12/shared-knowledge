#!/usr/bin/env node
// All service operations live in the project; the Skill only invokes this client.
import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';

export async function run(args=process.argv.slice(2),env=process.env){
 const {values,positionals}=parseArgs({args,allowPositionals:true,options:{
  url:{type:'string'},'token-file':{type:'string'},file:{type:'string'},question:{type:'string'},reply:{type:'string'},
  'clarification-id':{type:'string'},item:{type:'string'},'changes-file':{type:'string'},'occurred-at':{type:'string'},idempotency:{type:'string'},
 }});
 const [command]=positionals;
 if(!command||command==='help'){console.log('knowledge.mjs records|items|snapshot|timeline --item ID|save --file FILE [--changes-file FILE] [--idempotency KEY]|extract --file FILE|ask --question TEXT|reply --clarification-id ID --reply TEXT');return;}
 const url=new URL(values.url??env.TEAM_KB_URL??'http://127.0.0.1:5181');
 if(url.username||url.password)throw new Error('服务地址不可包含凭证');
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('仅连接本地 HTTP 知识服务');
 const tokenFile=values['token-file']??env.TEAM_KB_TOKEN_FILE??new URL('../.data/token',import.meta.url);
 const token=env.TEAM_KB_TOKEN??(await readFile(tokenFile,'utf8').catch(error=>{if(error.code==='ENOENT'&&!values['token-file']&&!env.TEAM_KB_TOKEN_FILE)return '';throw error;})).trim();
 const required=key=>{if(!values[key])throw new Error('缺少 --'+key);return values[key];};
 const request=async(path,body)=>{
  const response=await fetch(new URL('/api/'+path,url),{method:body?'POST':'GET',redirect:'error',headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(240000)});
  const result=await response.json();if(!response.ok)throw new Error('HTTP '+response.status+': '+(result.error??'请求失败'));return result;
 };
 let result;
 if(command==='snapshot')result={records:await request('records'),items:await request('items')};
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
