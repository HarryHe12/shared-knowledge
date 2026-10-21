import {Auth} from './auth.mjs';
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
 if(process.argv[2]==='bootstrap-admin'){
  const auth=new Auth(store,project);
  if(store.db.prepare('SELECT 1 FROM accounts WHERE admin=1').get())throw new Error('管理员已初始化');
  if(!process.stdin.isTTY)throw new Error('请在管理员本机交互终端初始化');
  const {createInterface}=await import('node:readline/promises');const rl=createInterface({input:process.stdin,output:process.stdout});
  const name=await rl.question('管理员姓名：'),email=await rl.question('管理员邮箱：');
  rl.close();process.stdout.write('管理员密码（至少12字符，不回显）：');
  const password=await new Promise(resolve=>{let text='';process.stdin.setRawMode(true);process.stdin.resume();const onData=chunk=>{for(const c of chunk.toString()){if(c==='\r'||c==='\n'){process.stdin.off('data',onData);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');resolve(text);return;}if(c==='\u0003')process.exit(130);if(c==='\u007f')text=text.slice(0,-1);else text+=c;}};process.stdin.on('data',onData);});
  const account=await auth.register({name,email,password,department:'系统管理',reason:'首次初始化'},true);console.log(JSON.stringify(account));store.close();
 }else if(process.argv[2]==='create-user'){
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
  const server=createKnowledgeServer(store,model,project,{authRequired:process.env.TEAM_LOCAL_VALIDATION!=='1',legacyAsk:process.env.TEAM_LEGACY_ASK==='1'});
  if(process.env.TEAM_LOCAL_VALIDATION==='1'&&process.env.TEAM_HOST&&process.env.TEAM_HOST!=='127.0.0.1')throw new Error('免鉴权验证模式只允许监听本机');
  if(process.env.TEAM_HOST&&process.env.TEAM_HOST!=='127.0.0.1'&&!process.env.TEAM_PUBLIC_URL?.startsWith('https://'))throw new Error('远程部署必须设置 HTTPS 的 TEAM_PUBLIC_URL 并配置反向代理');
  server.listen(Number(process.env.TEAM_PORT??5181),process.env.TEAM_HOST??'127.0.0.1',()=>console.log('知识服务 http://127.0.0.1:'+(process.env.TEAM_PORT??5181)));
  const shutdown=()=>server.close(()=>{store.close();process.exit(0);});
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
 }
}catch(error){store.close();throw error;}
