import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {Store} from '../src/store.mjs';
import {createModel} from '../src/intelligence.mjs';
import {ask} from '../src/query-loop.mjs';
import {retrieve} from '../src/retrieval.mjs';

const fixture=JSON.parse(await readFile(new URL('../eval/loop-scenarios/fixtures.json',import.meta.url),'utf8'));
const output=resolve(process.env.TEAM_LOOP_OUTPUT??'team-app/.data/loop-evaluation');
await mkdir(output,{recursive:true,mode:0o700});
const store=new Store(resolve(output,'evaluation.sqlite'));
let user=store.db.prepare('SELECT id,name FROM users LIMIT 1').get();
if(!user)user=store.user('场景评测员','synthetic-local-evaluation-token');
let project=store.projects(user).find(p=>p.name===fixture.project);
if(!project)project=store.project(user,fixture.project);
const recordIds=new Map(),itemIds=new Map();
for(const row of fixture.records){
 const changes=row.changes.map(c=>({...c,item_id:itemIds.get(c.key)}));
 const record=store.add(user,project.id,{text:row.text,occurred_at:row.occurred_at,changes,idempotency:row.id});
 recordIds.set(row.id,record.id);
 for(const c of row.changes){const item=store.items(user,project.id).find(i=>i.title===c.title);itemIds.set(c.key,item.id);}
}
let other=store.projects(user).find(p=>p.name==='北斗');if(!other)other=store.project(user,'北斗');
store.add(user,other.id,{text:'北斗项目预算为9876万元，只属于北斗项目，不应在海岬支付的回答中泄漏。',idempotency:'beidou'});
const model=await createModel();
const cases=fixture.cases.map(c=>({...c,trial:c.id,condition:'natural'}));
for(const id of ['D01','D08','D09','D14','C03','C04','C06','C08'])cases.push({...fixture.cases.find(c=>c.id===id),trial:id+'-repeat',condition:'natural-repeat'});
// Separate controlled condition: mask only the model-visible initial evidence to simulate a first retrieval miss.
// Actual model outputs and later retrievals are not mocked. Do not mix this condition into natural-query metrics.
for(const c of fixture.cases.filter(c=>c.kind==='lookup'))cases.push({...c,trial:c.id+'-masked',condition:'masked-first-evidence'});
const run={started_at:new Date().toISOString(),model:`${process.env.TEAM_PROVIDER??'kimi-coding'}/${process.env.TEAM_MODEL??'k3'}`,retrieval:'hybrid-rerank',records:fixture.records.length,unique_questions:fixture.cases.length,trials:cases.length,results:[]};
const save=()=>writeFile(resolve(output,'results.json'),JSON.stringify(run,null,2));
await retrieve(store,user,project.id,'预热工作记录索引');
let cursor=0;
async function worker(){while(cursor<cases.length){const c=cases[cursor++],steps=[],responses=[];let first=true;
 const wrapped=async(system,input)=>{const visible=structuredClone(input);if(first&&c.condition==='masked-first-evidence')visible.evidence=visible.evidence.filter(r=>r.id!==recordIds.get(c.target));first=false;
 const entry={question:visible.question,clarifications:visible.clarifications,evidence:visible.evidence.map(r=>({id:r.id,text:r.text})),remaining_searches:visible.remaining_searches};steps.push(entry);
 const started=performance.now();try{const raw=await model(system,visible);entry.raw=raw;entry.ms=Math.round(performance.now()-started);return raw;}catch(e){entry.error=e.message;throw e;}};
 const start=performance.now();let error;
 try{let result=await ask(store,wrapped,user,project.id,{question:c.question});responses.push(result);
 if(result.status==='needs_clarification'&&c.reply){result=await ask(store,wrapped,user,project.id,{clarification_id:result.clarification_id,reply:c.reply});responses.push(result);}
 }catch(e){error=e.message;}
 const row={...c,steps,responses,error:error??null,elapsed_ms:Math.round(performance.now()-start),review:'待人工核对'};run.results.push(row);await save();console.log(JSON.stringify({trial:c.trial,done:run.results.length,total:cases.length,status:responses.at(-1)?.status??'error',calls:steps.length}));
 }}
try{await Promise.all([worker(),worker()]);run.completed_at=new Date().toISOString();await save();}finally{store.close();}
