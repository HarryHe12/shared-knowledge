import {retrieve} from './retrieval.mjs';
import {anchoredLookup} from './query-policy.mjs';
const invalid=message=>Object.assign(new Error(message),{status:400});
export function getRecords(store,user,project,ids){
 store.access(user,project);
 if(!Array.isArray(ids)||!ids.length||ids.length>40||ids.some(id=>typeof id!=='string'||!id||id.length>100))throw invalid('ids 须为1—40个记录ID');
 const records=store.records(user,project).filter(r=>ids.includes(r.id));
 return {records,unavailable_ids:[...new Set(ids)].filter(id=>!records.some(r=>r.id===id))};
}
export async function searchRecords(store,user,project,input,options={}){
 store.access(user,project);
 if(typeof input.query!=='string'||!input.query.trim()||input.query.length>2000)throw invalid('query 须为1—2000字符');
 const limit=input.limit??15,depth=input.depth??1;
 if(!Number.isInteger(limit)||limit<1||limit>40)throw invalid('limit 须为1—40');
 if(!Number.isInteger(depth)||depth<0||depth>2)throw invalid('depth 须为0—2');
 const strategy=input.strategy??'hybrid';
 if(!['hybrid','exact'].includes(strategy))throw invalid('strategy 须为 hybrid 或 exact');

 const result=strategy==='exact'?{hits:[],mode:'exact',description:'精确实体与引用'}:await retrieve(store,user,project,input.query,{...options,topK:limit});
 const all=store.records(user,project),byId=new Map(all.map(r=>[r.id,r]));
 const anchored=anchoredLookup(store,user,project,input.query,{depth,limit:12});
 const hits=[...new Set([...result.hits,...anchored.hits].map(r=>r.id))];
 return {query:input.query,scope:{project_id:project},records:hits.slice(0,limit).map(id=>byId.get(id)),
  retrieval:{mode:result.mode,description:result.description,strategy,anchors:anchored.anchors,depth},
  coverage:{total_records:all.length,returned:Math.min(limit,hits.length),limit,truncated:hits.length>limit,corpus_not_returned:all.length-Math.min(limit,hits.length),exhaustive:false},
  meaning:'返回候选证据；零命中不证明没有记录。需要最新状态时另取 state。'};
}
export function getState(store,user,project){
 const items=store.items(user,project);
 const ids=new Set(items.map(i=>i.source_id));
 return {items,evidence:store.records(user,project).filter(r=>ids.has(r.id)),coverage:{registered_items_only:true,total_items:items.length}};
}
