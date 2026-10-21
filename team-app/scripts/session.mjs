import {execFile as exec} from 'node:child_process';
import {promisify} from 'node:util';
import {homedir} from 'node:os';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
const execFile=promisify(exec);
export async function credential(service,value){
 if(process.platform!=='darwin')throw new Error('第一版自动登录需要 macOS 系统钥匙串；尚未提供此系统的凭据适配器');
 try{if(value===null){await execFile('/usr/bin/security',['delete-generic-password','-a','shared-knowledge','-s',service]);return '';}
 if(value!==undefined){await execFile('/usr/bin/security',['add-generic-password','-U','-a','shared-knowledge','-s',service,'-w',value]);return value;}
 return (await execFile('/usr/bin/security',['find-generic-password','-a','shared-knowledge','-s',service,'-w'])).stdout.trim();
 }catch(e){if(value===undefined&&e.code===44)return '';if(value===null&&e.code===44)return '';throw new Error('系统钥匙串操作失败，请允许知识客户端访问钥匙串');}
}
export const profileFile=join(homedir(),'.config','shared-knowledge','profile.json');
export async function profile(){try{return JSON.parse(await readFile(profileFile,'utf8'));}catch(e){if(e.code==='ENOENT')return {};throw e;}}
export async function saveProfile(value){await mkdir(dirname(profileFile),{recursive:true,mode:0o700});await writeFile(profileFile,JSON.stringify(value),{mode:0o600});}
