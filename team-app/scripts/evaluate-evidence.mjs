import {readFile,mkdir,writeFile,copyFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {constants} from 'node:fs';
import {Store} from '../src/store.mjs';
import {searchRecords} from '../src/evidence.mjs';
const [source,output]=process.argv.slice(2);
if(!source||!output)throw Error('用法：node evaluate-evidence.mjs 基线evaluation.sqlite 输出目录');
await mkdir(output,{recursive:true});const database=resolve(output,'evidence.sqlite');
if(resolve(source)===database)throw Error('不得覆盖基线库');
await copyFile(source,database,constants.COPYFILE_EXCL);
const store=new Store(database);
try{
 const fixture=JSON.parse(await readFile(new URL('../eval/loop-scenarios/chains.json',import.meta.url),'utf8'));
 const user=store.db.prepare('SELECT id,name FROM users LIMIT 1').get(),project=store.projects(user)[0];
 const records=store.records(user,project.id),results=[];
 for(const c of fixture.cases){
  const initial=await searchRecords(store,user,project.id,{query:c.question});
  const supplemental=await searchRecords(store,user,project.id,{query:c.question,strategy:'exact',depth:2});
  const ids=new Set([...initial.records,...supplemental.records].map(r=>r.id));
  const required=c.required_records.map(key=>records.find(r=>r.text===fixture.records.find(f=>f.id===key).text)?.id);
  results.push({id:c.id,question:c.question,initial,supplemental,required,complete:required.every(id=>id&&ids.has(id))});
 }
 const report={kind:'evidence-availability; fixed two-tool sequence, not agent decision accuracy',generation_calls:0,results};
 await writeFile(resolve(output,'results.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({complete:results.filter(r=>r.complete).length,total:results.length,generation_calls:0}));
}finally{store.close();}
