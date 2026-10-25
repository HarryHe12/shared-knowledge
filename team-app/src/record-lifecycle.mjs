import {terms} from './store.mjs';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export function setup(db){db.exec(`
 CREATE TABLE IF NOT EXISTS record_epoch(value INTEGER NOT NULL);
 INSERT INTO record_epoch SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM record_epoch);
 CREATE TABLE IF NOT EXISTS record_lifecycle(record_id TEXT PRIMARY KEY,version INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS record_revisions(record_id TEXT NOT NULL,version INTEGER NOT NULL,snapshot TEXT NOT NULL,changed_at TEXT NOT NULL,action TEXT NOT NULL,PRIMARY KEY(record_id,version));
 CREATE TABLE IF NOT EXISTS erased_writes(author_id TEXT NOT NULL,key_hash TEXT NOT NULL,PRIMARY KEY(author_id,key_hash));
 `);}
export function history(store,user,project,id){
 store.access(user,project);
 const record=store.db.prepare('SELECT * FROM records WHERE id=? AND project_id=?').get(id,project);
 if(!record)throw fail('记录不存在或不可访问',404);
 return {record:{...record,version:1,deleted:0,...store.db.prepare('SELECT version,deleted FROM record_lifecycle WHERE record_id=?').get(id)},revisions:store.db.prepare('SELECT * FROM record_revisions WHERE record_id=? ORDER BY version').all(id).map(r=>({...r,snapshot:JSON.parse(r.snapshot)}))};
}
export function mutate(store,user,project,input,action,hash){
 store.access(user,project);
 if(store.organization?.isManaged(project))store.organization.authorize(user,project,true);
 if(typeof input.id!=='string'||!Number.isInteger(input.version)||input.version<1)throw fail('需要记录id和当前version');
 const db=store.db;db.exec('BEGIN IMMEDIATE');
 try{
 const record=db.prepare('SELECT * FROM records WHERE id=? AND project_id=?').get(input.id,project);
 if(!record)throw fail('记录不存在或不可访问',404);
 if(record.author_id!==user.id)throw fail('仅记录作者可更改或删除',403);
 const meta=db.prepare('SELECT version,deleted FROM record_lifecycle WHERE record_id=?').get(record.id)??{version:1,deleted:0};
 if(meta.version!==input.version)throw fail('版本已变化，请重新读取后决定',409);
 if(action==='restore'&&!meta.deleted||action==='correct'&&meta.deleted||action==='withdraw'&&meta.deleted)throw fail('当前记录状态不允许此操作',409);
 const events=db.prepare('SELECT e.*,i.title FROM events e JOIN items i ON i.id=e.item_id WHERE record_id=?').all(record.id);
 let at=record.occurred_at;
 if(action==='correct'){
  if(typeof input.text!=='string'||!input.text.trim()||input.text.length>20000)throw fail('记录须为1—20000字符');
  const date=new Date(input.occurred_at??record.occurred_at);if(!Number.isFinite(date.valueOf()))throw fail('无效发生时间');at=date.toISOString();
  if(events.length&&input.changes===undefined)throw fail('原记录含事项，请显式提供完整changes（可为空数组以撤销）');
  store.validateChanges(user,project,input.changes??[]);
 }
 if(action==='purge'){
  if(record.idempotency)db.prepare('INSERT OR IGNORE INTO erased_writes VALUES(?,?)').run(record.author_id,hash(record.idempotency));
  db.prepare('DELETE FROM events WHERE record_id=?').run(record.id);
  db.prepare('DELETE FROM record_revisions WHERE record_id=?').run(record.id);
  db.prepare('DELETE FROM record_lifecycle WHERE record_id=?').run(record.id);
  db.prepare('DELETE FROM record_search WHERE id=?').run(record.id);
  db.prepare('DELETE FROM records WHERE id=?').run(record.id);
  db.prepare('DELETE FROM items WHERE project_id=? AND NOT EXISTS(SELECT 1 FROM events WHERE item_id=items.id)').run(project);
 }else{
  db.prepare('INSERT INTO record_revisions VALUES(?,?,?,?,?)').run(record.id,meta.version,JSON.stringify({record,events,deleted:meta.deleted}),new Date().toISOString(),action);
  if(action==='correct'){
   db.prepare('UPDATE records SET text=?,occurred_at=? WHERE id=?').run(input.text,at,record.id);
   db.prepare('DELETE FROM events WHERE record_id=?').run(record.id);
   store.insertChanges(project,record.id,input.changes??[]);
  }
  const deleted=action==='withdraw'?1:0;
  db.prepare('INSERT OR REPLACE INTO record_lifecycle VALUES(?,?,?)').run(record.id,meta.version+1,deleted);
  db.prepare('DELETE FROM record_search WHERE id=?').run(record.id);
  if(!deleted)db.prepare('INSERT INTO record_search VALUES(?,?)').run(record.id,terms(action==='correct'?input.text:record.text).join(' '));
 }
 // Cache keys are text hashes without a record mapping; clear rather than retain stale material.
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='embeddings'").get())db.exec('DELETE FROM embeddings');
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='query_clarifications'").get())db.prepare('DELETE FROM query_clarifications WHERE project_id=?').run(project);
 db.exec('UPDATE record_epoch SET value=value+1');
 db.exec('COMMIT');
 return {id:record.id,version:meta.version+1,action,deleted:action==='withdraw'||action==='purge',purged:action==='purge'};
 }catch(error){db.exec('ROLLBACK');throw error;}
}
