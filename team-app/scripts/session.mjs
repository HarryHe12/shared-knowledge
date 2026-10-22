import {execFile as exec} from 'node:child_process';
import {promisify} from 'node:util';
import {homedir} from 'node:os';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
const execFile=promisify(exec);
export async function credential(service,value){
 if(process.platform==='win32')return windowsCredential(service,value);
 if(process.platform!=='darwin')throw new Error('自动登录支持 macOS 和 Windows；当前系统尚无凭据适配器');
 try{if(value===null){await execFile('/usr/bin/security',['delete-generic-password','-a','shared-knowledge','-s',service]);return '';}
 if(value!==undefined){await execFile('/usr/bin/security',['add-generic-password','-U','-a','shared-knowledge','-s',service,'-w',value]);return value;}
 return (await execFile('/usr/bin/security',['find-generic-password','-a','shared-knowledge','-s',service,'-w'])).stdout.trim();
 }catch(e){if(value===undefined&&e.code===44)return '';if(value===null&&e.code===44)return '';throw new Error('系统钥匙串操作失败，请允许知识客户端访问钥匙串');}
}
export const profileFile=join(homedir(),'.config','shared-knowledge','profile.json');
export async function profile(){try{return JSON.parse(await readFile(profileFile,'utf8'));}catch(e){if(e.code==='ENOENT')return {};throw e;}}
export async function saveProfile(value){await mkdir(dirname(profileFile),{recursive:true,mode:0o700});await writeFile(profileFile,JSON.stringify(value),{mode:0o600});}

// Secrets travel over stdin, never command-line arguments or temporary files.
export async function windowsCredential(service,value){
 if(typeof service!=='string'||!service.startsWith('shared-knowledge:'))throw new Error('无效凭据目标');
 const operation=value===undefined?'read':value===null?'delete':'write';
 const executable=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const script=await readFile(new URL('./windows-credential.ps1',import.meta.url),'utf8');
 const encoded=Buffer.from(script,'utf16le').toString('base64');
 return new Promise((resolve,reject)=>{
  const failure=()=>reject(new Error('Windows 凭据管理器操作失败，请确认当前 Windows 用户可用，且系统允许运行客户端 PowerShell 脚本'));
  const child=exec(executable,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded],{windowsHide:true,timeout:30000,maxBuffer:65536,encoding:'utf8'},(error,stdout)=>{
   if(error)return failure();
   try{const result=JSON.parse(stdout.replace(/^\uFEFF/,''));if(typeof result.value!=='string')return failure();resolve(operation==='write'?value:result.value);}catch{failure();}
  });
  child.stdin.on('error',failure);
  child.stdin.end(JSON.stringify({service,operation,...(operation==='write'?{value}:{})}));
 });
}
