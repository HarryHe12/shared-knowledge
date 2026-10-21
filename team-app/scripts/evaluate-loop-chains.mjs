import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Store} from '../src/store.mjs';
import {createModel} from '../src/intelligence.mjs';
import {ask} from '../src/query-loop.mjs';
import {retrieve} from '../src/retrieval.mjs';
const fixture=JSON.parse(await readFile(new URL('../eval/loop-scenarios/chains.json',import.meta.url),'utf8'));
const output=resolve(process.env.TEAM_CHAIN_OUTPUT??'team-app/.data/chain-evaluation');await mkdir(output,{recursive:true});
const store=new Store(resolve(output,'evaluation.sqlite'));let user=store.db.prepare('SELECT id,name FROM users LIMIT 1').get();if(!user)user=store.user('链路评测员','chain-evaluation-nonproduction-token');let project=store.projects(user)[0];if(!project)project=store.project(user,fixture.project);
const ids=new Map();for(const record of fixture.records){const r=store.add(user,project.id,{text:record.text,occurred_at:'2026-10-21T09:00:00Z',idempotency:record.id});ids.set(record.id,r.id);}
const model=await createModel();const run={started_at:new Date().toISOString(),records:fixture.records.length,condition:'natural-multi-hop',results:[]};
await retrieve(store,user,project.id,'交接调度预热');let cursor=0;
async function worker(){while(cursor<fixture.cases.length){const c=fixture.cases[cursor++],steps=[];let result,error;
const wrapped=async(system,input)=>{const entry={evidence:input.evidence.map(r=>({id:r.id,text:r.text})),remaining_searches:input.remaining_searches};steps.push(entry);entry.raw=await model(system,input);return entry.raw;};
try{result=await ask(store,wrapped,user,project.id,{question:c.question});}catch(e){error=e.message;}
run.results.push({...c,required_ids:c.required_records.map(k=>ids.get(k)),steps,result,error:error??null});await writeFile(resolve(output,'results.json'),JSON.stringify(run,null,2));console.log(JSON.stringify({trial:c.id,done:run.results.length,status:result?.status,calls:steps.length}));}}
try{await Promise.all([worker(),worker()]);run.completed_at=new Date().toISOString();await writeFile(resolve(output,'results.json'),JSON.stringify(run,null,2));}finally{store.close();}
