import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {queryFingerprint} from '../src/query-policy.mjs';
const [beforeMain,beforeChains,afterMain,afterChains,output]=process.argv.slice(2);
if(!output)throw Error('需要优化前后主集/多跳目录及输出目录，共5个参数');
const load=async folder=>{const run=JSON.parse(await readFile(resolve(folder,'results.json'),'utf8'));if(!run.completed_at)throw Error('试验尚未完成');return run;};
const [bm,bh,am,ah]=await Promise.all([beforeMain,beforeChains,afterMain,afterChains].map(load));
const requiredClarifications=new Set(['C01','C02','C03','C04','C05','C08','C03-repeat','C04-repeat','C08-repeat']);
const events=rows=>rows.flatMap(r=>(r.responses??[r.result]).flatMap(a=>a?.trace??[]));
function stats(main,chain){
 const rows=main.results,all=[...rows,...chain.results];
 const ordinary=rows.filter(r=>r.condition==='natural'&&!r.id.startsWith('C'));
 let duplicates=0;
 for(const r of all)for(const response of r.responses??[r.result]){const seen=new Set();for(const t of response?.trace??[]){if(t.action==='search'){const fp=queryFingerprint(t.query);if(seen.has(fp))duplicates++;seen.add(fp);}}}
 return{trials:all.length,model_calls:all.reduce((s,r)=>s+r.steps.length,0),errors:all.filter(r=>r.error).length,
   ordinary_questions:ordinary.length,unnecessary_clarifications:ordinary.filter(r=>r.responses[0].status==='needs_clarification').length,
   direct_questions:rows.filter(r=>r.condition==='natural'&&r.id.startsWith('D')).length,
   direct_questions_with_clarification:rows.filter(r=>r.condition==='natural'&&r.id.startsWith('D')&&r.responses[0].status==='needs_clarification').length,
   necessary_clarifications_preserved:rows.filter(r=>requiredClarifications.has(r.trial)&&r.responses[0].status==='needs_clarification'&&r.responses.length===2&&r.responses[1].status!=='needs_clarification').length,
   clarification_questions_total:rows.reduce((s,r)=>s+r.responses.filter(a=>a.status==='needs_clarification').length,0),
   natural_chain_correct:chain.results.filter(r=>r.result?.status==='answered'&&r.result.answer.includes(r.expected)&&r.required_ids.every(id=>r.result.citations.some(c=>c.id===id))).length,
   natural_chain_model_calls:chain.results.reduce((s,r)=>s+r.steps.length,0),
   repeated_query_bags:duplicates,search_events:events(all).filter(e=>e.action==='search').length,
   absence_guard_events:events(all).filter(e=>e.action==='absence_guard').length,
   conservative_fallbacks:rows.filter(r=>r.responses.some(a=>a.answer==='本轮检索证据不足以支持可靠结论，不能据此认定项目库不存在相关记录。')).map(r=>r.trial),
   optional_recipient_question:rows.find(r=>r.trial==='C07').responses[0].status==='needs_clarification'};
}
const key=r=>r.trial??r.id;
const b=new Map([...bm.results,...bh.results].map(r=>[key(r),r]));
const a=new Map([...am.results,...ah.results].map(r=>[key(r),r]));
if(b.size!==58||a.size!==58||[...b.keys()].some(id=>!a.has(id)))throw Error('前后案例不一致');
const comparison={before:stats(bm,bh),after:stats(am,ah),manual_absence_review:'D02/C07等缺失声明需逐题人工核对，不由被测正则自动评分。',cases:[...b.keys()].sort().map(id=>({id,question:b.get(id).question,
 before:{calls:b.get(id).steps.length,responses:(b.get(id).responses??[b.get(id).result]).map(r=>({status:r.status,answer:r.answer,clarification:r.clarification,trace:r.trace}))},
 after:{calls:a.get(id).steps.length,responses:(a.get(id).responses??[a.get(id).result]).map(r=>({status:r.status,answer:r.answer,clarification:r.clarification,trace:r.trace}))}}))};
await mkdir(output,{recursive:true});await writeFile(resolve(output,'comparison.json'),JSON.stringify(comparison,null,2));
const lines=['# 查询循环优化前后逐题对照',''];
for(const r of comparison.cases){lines.push(`## ${r.id} · ${r.question}`);for(const stage of ['before','after']){lines.push('',`${stage==='before'?'优化前':'优化后'}：${r[stage].calls}次模型调用`);for(const response of r[stage].responses){lines.push(`状态：${response.status}`);if(response.clarification)lines.push('澄清：'+response.clarification.question);if(response.answer)lines.push(response.answer);lines.push('轨迹：'+JSON.stringify(response.trace));}}lines.push('');}
await writeFile(resolve(output,'CASE-COMPARISON.md'),lines.join('\n')+'\n');console.log(JSON.stringify({before:comparison.before,after:comparison.after},null,2));
