import {Auth} from './auth.mjs';
import {authPage} from './auth-page.mjs';
import {createServer} from 'node:http';
import {extractDraft} from './extract-draft.mjs';
import {ask} from './query-loop.mjs';
import {searchRecords,getRecords,getState} from './evidence.mjs';
import {Channels} from './channels.mjs';
import {ChatService} from './chat.mjs';
import {versionedHttp} from './versioned-http.mjs';
import {organizationPage} from './organization-page.mjs';

export function createKnowledgeServer(store, model, project, {authRequired = true, legacyAsk = false, allowLegacyTokens = false} = {}) {
 const auth=new Auth(store,project),defaultProject=project;
 const channels=new Channels(store,auth),chat=new ChatService(store,model,auth);
 const attempts=new Map();
 const localUser = authRequired ? null : store.localValidationUser(project.id);
 return createServer(async(req,res)=>{
  const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  try {
   const url=new URL(req.url,'http://localhost');
   if(req.method==='GET'&&['/account','/admin','/organization'].includes(url.pathname)){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});return res.end(url.pathname==='/organization'?organizationPage:authPage);}
   if(!url.pathname.startsWith('/api/'))return send(404,{error:'请使用 Skill 或 /account'});
   let project=defaultProject;
   const bearer=(req.headers.authorization??'').replace(/^Bearer /,'');
   const cookie=/kb_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie??'')?.[1];
   let sessionUser=auth.user(bearer||cookie);
   let user=sessionUser ?? (allowLegacyTokens?store.authenticate(bearer):null) ?? (authRequired?null:localUser);
   if(req.headers.origin&&req.headers.origin!==(process.env.TEAM_PUBLIC_URL?new URL(process.env.TEAM_PUBLIC_URL).origin:`http://${req.headers.host}`))return send(403,{error:'来源不允许'});

   let input={};
   if(req.method==='POST'){
    const chunks=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>100000)throw Object.assign(new Error('请求过大'),{status:413});chunks.push(chunk);}
    try{input=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw Object.assign(new Error('JSON无效'),{status:400});}
    if(!input||typeof input!=='object'||Array.isArray(input))throw Object.assign(new Error('请求须为对象'),{status:400});
   }
   sessionUser=auth.user(bearer||cookie);
   user=sessionUser ?? (allowLegacyTokens?store.authenticate(bearer):null) ?? (authRequired?null:localUser);
   if(url.pathname==='/api/v1/logout')res.setHeader('Set-Cookie','kb_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
   if(url.pathname.startsWith('/api/v1/channels/')&&req.method==='POST'){
    if(attempts.size>10000)for(const [k,v] of attempts)if(v.until<Date.now())attempts.delete(k);
    const key=req.socket.remoteAddress+':channel-'+(url.pathname.endsWith('/bridge')?'bridge':'login'),now=Date.now();
    const rate=attempts.get(key)??{count:0,until:now+60000};if(rate.until<now){rate.count=0;rate.until=now+60000;}rate.count++;attempts.set(key,rate);
    if(rate.count>(url.pathname.endsWith('/bridge')?300:20))return send(429,{error:'请求过于频繁，请稍后重试'});
   }
   if(await versionedHttp({req,url,input,send,store,model,auth,channels,chat,bearer,cookie,sessionUser}))return;
   if(url.pathname.startsWith('/api/auth/')){
    const action=url.pathname.slice(10);
    if(req.method==='POST'&&['register','login','device-start','device-poll'].includes(action)){
     const key=req.socket.remoteAddress+':'+action,now=Date.now();
     if(attempts.size>10000)for(const [k,v] of attempts)if(v.until<now)attempts.delete(k);
     const rate=attempts.get(key)??{count:0,until:now+60000};if(rate.until<now){rate.count=0;rate.until=now+60000;}rate.count++;attempts.set(key,rate);
     if(rate.count>(action==='device-poll'?60:10))return send(429,{error:'请求过于频繁，请稍后重试'});
     if(action==='register')return send(201,await auth.register(input));
     if(action==='device-start')return send(200,auth.start());
     if(action==='device-poll')return send(200,auth.poll(input.device_token));
     const result=await auth.login(input);res.setHeader('Set-Cookie','kb_session='+result.token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000'+(req.socket.encrypted||process.env.TEAM_PUBLIC_URL?.startsWith('https:')?'; Secure':''));return send(200,{ok:true});
    }
    if(!sessionUser)return send(401,{error:'请登录'});
    if(req.method==='GET'&&action==='me')return send(200,auth.me(sessionUser));
    if(req.method==='POST'&&action==='device-bind')return send(200,auth.bind(sessionUser,input.code));
    if(req.method==='POST'&&action==='logout'){auth.db.prepare('DELETE FROM auth_sessions WHERE hash=?').run(sessionUser.session_hash);res.setHeader('Set-Cookie','kb_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return send(200,{ok:true});}
    return send(404,{error:'未找到接口'});
   }
   if(url.pathname==='/api/admin'){
    auth.admin(sessionUser);
    if(req.method==='GET')return send(200,auth.overview(sessionUser));
    if(req.method==='POST')return send(200,auth.manage(sessionUser,input));
   }
   const channel=sessionUser?null:channels.authenticate(bearer);
   const businessUser=channel?.user??user;
   if(!businessUser)return send(401,{error:'请通过客户端 login 登录'});
   if(sessionUser||channel){
    const scope=req.headers['x-knowledge-scope']??defaultProject.id;
    const write=req.method==='POST'&&!['search','get-records','ask'].includes(url.pathname.split('/').at(-1));
    if(channel)channels.assertScope(channel.app,businessUser,scope,write);else auth.authorize(sessionUser,scope,write);
    project=store.db.prepare('SELECT * FROM projects WHERE id=?').get(scope);
   }
   const actor=businessUser;
   store.access(actor,project.id);
   if(req.method==='GET'&&url.pathname==='/api/projects')return send(200,[project]);
   if(req.method==='GET'&&url.pathname==='/api/default')return send(200,project);
   const parts=url.pathname.split('/').filter(Boolean);
   let action=parts[1];
   if(action==='projects'){
    if(parts[2]!==project.id||parts.length!==4)return send(404,{error:'仅提供默认知识库'});
    action=parts[3];
   }else if(parts.length!==2)return send(404,{error:'未找到接口'});
   let result;
   if(req.method==='GET'&&action==='records')result=store.records(actor,project.id);
   else if(req.method==='GET'&&action==='items')result=store.items(actor,project.id);
   else if(req.method==='GET'&&action==='timeline')result=store.timeline(actor,project.id,url.searchParams.get('item'));
   else if(req.method==='GET'&&action==='record-history')result=store.history(actor,project.id,url.searchParams.get('id'));
   else if(req.method==='POST'&&['correct','withdraw','restore','purge'].includes(action))result=store[action](actor,project.id,input);
   else if(req.method==='POST'&&action==='records')result=store.add(actor,project.id,input);
   else if(req.method==='POST'&&action==='extract'){
    if(typeof input.text!=='string'||!input.text.trim()||input.text.length>20000)throw Object.assign(new Error('无效文本'),{status:400});
    result=await extractDraft(store,chat,actor,project.id,input.text);
   }else if(req.method==='POST'&&action==='search')result=await searchRecords(store,actor,project.id,input);
   else if(req.method==='POST'&&action==='get-records')result=getRecords(store,actor,project.id,input.ids);
   else if(req.method==='GET'&&action==='state')result=getState(store,actor,project.id);
   else if(req.method==='POST'&&action==='ask'){
    if(!legacyAsk)return send(410,{error:'服务端问答已停用；请使用 search、get-records、state，由调用方 Agent 组织回答'});
    result=await ask(store,model,actor,project.id,input);
   }
   else return send(404,{error:'未找到接口'});
   if(sessionUser){const current=auth.user(bearer||cookie);auth.authorize(current,project.id,req.method==='POST'&&!['search','get-records','ask'].includes(action));}
   if(channel){const current=channels.authenticate(bearer);if(!current)throw Object.assign(new Error('会话已失效'),{status:401});channels.assertScope(current.app,current.user,project.id,req.method==='POST'&&!['search','get-records','ask'].includes(action));}
   send(200,result);
  }catch(error){send(error.status??500,{error:error.status?error.message:'处理失败，请检查模型或服务配置'});}
 });
}
