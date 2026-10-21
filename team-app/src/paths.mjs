import {readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const projectRoot=fileURLToPath(new URL('../',import.meta.url));
export async function databaseFile(root=projectRoot,configured=process.env.TEAM_DB){
 if(configured)return resolve(root,configured);
 let files=[];try{files=(await readdir(resolve(root,'.data'))).filter(name=>name.endsWith('.sqlite'));}catch(error){if(error.code!=='ENOENT')throw error;}
 if(files.length>1)throw new Error('存在多个本地数据库，请用 TEAM_DB 明确现有数据库');
 return resolve(root,'.data',files[0]??'team.sqlite');
}
