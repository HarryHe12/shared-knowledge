import {createServer} from 'node:http';
import {extract} from './intelligence.mjs';
import {ask} from './query-loop.mjs';
import {searchRecords,getRecords,getState} from './evidence.mjs';

export function createKnowledgeServer(store, model, project, {authRequired = true, legacyAsk = false} = {}) {
 const localUser = authRequired ? null : store.localValidationUser(project.id);
 return createServer(async(req,res)=>{
  const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  try {
   const url=new URL(req.url,'http://localhost');
   if(!url.pathname.startsWith('/api/'))return send(404,{error:'仅提供知识库 API，请使用 Skill'});
   const user=localUser ?? store.authenticate((req.headers.authorization??'').replace(/^Bearer /,''));
   if(!user)return send(401,{error:'个人令牌无效'});
   if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)return send(403,{error:'来源不允许'});
   store.access(user,project.id);
   let input={};
   if(req.method==='POST'){
    const chunks=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>100000)throw Object.assign(new Error('请求过大'),{status:413});chunks.push(chunk);}
    try{input=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw Object.assign(new Error('JSON无效'),{status:400});}
    if(!input||typeof input!=='object'||Array.isArray(input))throw Object.assign(new Error('请求须为对象'),{status:400});
   }
   if(req.method==='GET'&&url.pathname==='/api/projects')return send(200,[project]);
   if(req.method==='GET'&&url.pathname==='/api/default')return send(200,project);
   const parts=url.pathname.split('/').filter(Boolean);
   let action=parts[1];
   if(action==='projects'){
    if(parts[2]!==project.id||parts.length!==4)return send(404,{error:'仅提供默认知识库'});
    action=parts[3];
   }else if(parts.length!==2)return send(404,{error:'未找到接口'});
   let result;
   if(req.method==='GET'&&action==='records')result=store.records(user,project.id);
   else if(req.method==='GET'&&action==='items')result=store.items(user,project.id);
   else if(req.method==='GET'&&action==='timeline')result=store.timeline(user,project.id,url.searchParams.get('item'));
   else if(req.method==='GET'&&action==='record-history')result=store.history(user,project.id,url.searchParams.get('id'));
   else if(req.method==='POST'&&['correct','withdraw','restore','purge'].includes(action))result=store[action](user,project.id,input);
   else if(req.method==='POST'&&action==='records')result=store.add(user,project.id,input);
   else if(req.method==='POST'&&action==='extract'){
    if(typeof input.text!=='string'||!input.text.trim()||input.text.length>20000)throw Object.assign(new Error('无效文本'),{status:400});
    result=await extract(model,input.text,store.items(user,project.id));
   }else if(req.method==='POST'&&action==='search')result=await searchRecords(store,user,project.id,input);
   else if(req.method==='POST'&&action==='get-records')result=getRecords(store,user,project.id,input.ids);
   else if(req.method==='GET'&&action==='state')result=getState(store,user,project.id);
   else if(req.method==='POST'&&action==='ask'){
    if(!legacyAsk)return send(410,{error:'服务端问答已停用；请使用 search、get-records、state，由调用方 Agent 组织回答'});
    result=await ask(store,model,user,project.id,input);
   }
   else return send(404,{error:'未找到接口'});
   send(200,result);
  }catch(error){send(error.status??500,{error:error.status?error.message:'处理失败，请检查模型或服务配置'});}
 });
}
