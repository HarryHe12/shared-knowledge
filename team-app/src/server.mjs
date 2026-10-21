import {mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {Store} from './store.mjs';
import {createModel} from './intelligence.mjs';
import {createKnowledgeServer} from './http.mjs';

import {databaseFile} from './paths.mjs';
const file=await databaseFile();
await mkdir(dirname(file),{recursive:true,mode:0o700});
const store=new Store(file);
try {
 const project=store.defaultProject(process.env.TEAM_DEFAULT_PROJECT_ID);
 if(process.argv[2]==='create-user'){
  const token=process.env.TEAM_USER_TOKEN;
  if(!token||token.length<24)throw new Error('TEAM_USER_TOKEN 至少24字符');
  const user=store.user(process.argv[3]??'管理员',token);store.grant(project.id,user.id);
  console.log(JSON.stringify({...user,project}));store.close();
 }else if(process.argv[2]==='grant'){
  const [, , ,projectId,userId]=process.argv;
  if(projectId!==project.id)throw new Error('只能授权默认知识库');
  store.grant(project.id,userId);store.close();console.log('已授权');
 }else{
  let loadedModel;
  const model=async(...args)=>{loadedModel??=createModel();return (await loadedModel)(...args);};
  const server=createKnowledgeServer(store,model,project,{authRequired:process.env.TEAM_AUTH_REQUIRED==='1',legacyAsk:process.env.TEAM_LEGACY_ASK==='1'});
  server.listen(Number(process.env.TEAM_PORT??5181),'127.0.0.1',()=>console.log('知识服务 http://127.0.0.1:'+(process.env.TEAM_PORT??5181)));
  const shutdown=()=>server.close(()=>{store.close();process.exit(0);});
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
 }
}catch(error){store.close();throw error;}
