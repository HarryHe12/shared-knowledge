import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
export class Store {
 constructor(file){this.db=new DatabaseSync(file);this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL);
 CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS members(project_id TEXT REFERENCES projects(id),user_id TEXT REFERENCES users(id),PRIMARY KEY(project_id,user_id));
 CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),author_id TEXT REFERENCES users(id),text TEXT NOT NULL,occurred_at TEXT NOT NULL,recorded_at TEXT NOT NULL,idempotency TEXT,UNIQUE(author_id,idempotency));
 CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),title TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,item_id TEXT REFERENCES items(id),record_id TEXT REFERENCES records(id),status TEXT NOT NULL,owner TEXT,deadline TEXT,kind TEXT NOT NULL);
 CREATE VIRTUAL TABLE IF NOT EXISTS record_search USING fts5(id UNINDEXED, terms);
 `);}
 defaultProject(preferred){
  this.db.exec('CREATE TABLE IF NOT EXISTS service_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const saved=this.db.prepare("SELECT value FROM service_settings WHERE key='default_project'").get()?.value;
  if(saved&&preferred&&saved!==preferred)throw new Error('默认知识库已固定，不能通过环境变量切换');
  let project;
  if(saved||preferred){project=this.db.prepare('SELECT * FROM projects WHERE id=?').get(saved??preferred);if(!project)throw new Error('默认知识库不存在');}
  else{const projects=this.db.prepare('SELECT * FROM projects').all();if(projects.length>1)throw new Error('存在多个旧项目，请用 TEAM_DEFAULT_PROJECT_ID 明确默认知识库');project=projects[0];if(!project){project={id:randomUUID(),name:'默认知识库'};this.db.prepare('INSERT INTO projects VALUES(?,?)').run(project.id,project.name);}}
  this.db.prepare("INSERT OR IGNORE INTO service_settings VALUES('default_project',?)").run(project.id);
  return project;
 }

 user(name,token){const id=randomUUID();this.db.prepare('INSERT INTO users VALUES(?,?,?)').run(id,name,hash(token));return {id,name};}
 localValidationUser(project){
  const id='local-validation-user';
  this.db.prepare('INSERT OR IGNORE INTO users VALUES(?,?,?)').run(id,'本地验证用户',hash(randomUUID()));
  this.grant(project,id);
  return this.db.prepare('SELECT id,name FROM users WHERE id=?').get(id);
 }
 authenticate(token){return this.db.prepare('SELECT id,name FROM users WHERE token_hash=?').get(hash(token));}
 project(user,name){const id=randomUUID();this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO projects VALUES(?,?)').run(id,name);this.grant(id,user.id);this.db.exec('COMMIT');return {id,name};}catch(e){this.db.exec('ROLLBACK');throw e;}}
 grant(project,user){this.db.prepare('INSERT OR IGNORE INTO members VALUES(?,?)').run(project,user);}
 access(user,project){if(!this.db.prepare('SELECT 1 FROM members WHERE project_id=? AND user_id=?').get(project,user.id))throw Object.assign(new Error('无项目访问权限'),{status:403});}
 projects(user){return this.db.prepare('SELECT p.* FROM projects p JOIN members m ON p.id=m.project_id WHERE m.user_id=?').all(user.id);}
 records(user,project){this.access(user,project);return this.db.prepare('SELECT r.*,u.name AS author FROM records r JOIN users u ON u.id=r.author_id WHERE project_id=? ORDER BY occurred_at,recorded_at,id').all(project);}
 items(user,project){this.access(user,project);return this.db.prepare(`SELECT i.*,e.status,e.owner,e.deadline,e.kind,r.occurred_at,r.recorded_at,r.id AS source_id FROM items i JOIN events e ON e.id=(SELECT e2.id FROM events e2 JOIN records r2 ON r2.id=e2.record_id WHERE e2.item_id=i.id ORDER BY r2.occurred_at DESC,r2.recorded_at DESC,r2.id DESC LIMIT 1) JOIN records r ON r.id=e.record_id WHERE i.project_id=?`).all(project);}
 timeline(user,project,item){this.access(user,project);return this.db.prepare('SELECT e.*,r.text,r.occurred_at,r.recorded_at FROM events e JOIN items i ON i.id=e.item_id JOIN records r ON r.id=e.record_id WHERE i.project_id=? AND i.id=? ORDER BY r.occurred_at,r.recorded_at,r.id').all(project,item);}
 add(user,project,input){this.access(user,project);if(typeof input.text!=='string'||!input.text.trim()||input.text.length>20000)throw Object.assign(new Error('记录须为 1—20000 字符'),{status:400});const at=new Date(input.occurred_at??Date.now());if(!Number.isFinite(at.valueOf()))throw Object.assign(new Error('无效发生时间'),{status:400});const changes=input.changes??[];if(!Array.isArray(changes)||changes.length>30)throw Object.assign(new Error('无效事项列表'),{status:400});for(const c of changes){if(!c||typeof c!=='object'||!['open','blocked','done','cancelled'].includes(c.status)||!['reported','inferred'].includes(c.kind??'reported')||typeof c.title!=='string'||!c.title.trim())throw Object.assign(new Error('无效事项变更'),{status:400});if(c.item_id&&!this.db.prepare('SELECT 1 FROM items WHERE id=? AND project_id=?').get(c.item_id,project))throw Object.assign(new Error('事项不属于当前项目'),{status:400});}
 this.db.exec('BEGIN IMMEDIATE');try{const old=input.idempotency&&this.db.prepare('SELECT * FROM records WHERE author_id=? AND idempotency=?').get(user.id,input.idempotency);if(old){if(old.project_id!==project||old.text!==input.text)throw Object.assign(new Error('幂等键已用于其他记录'),{status:409});this.db.exec('COMMIT');return old;}const record={id:randomUUID(),project_id:project,author_id:user.id,text:input.text,occurred_at:at.toISOString(),recorded_at:new Date().toISOString()};this.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').run(...Object.values(record),input.idempotency??null);this.db.prepare('INSERT INTO record_search VALUES(?,?)').run(record.id,terms(input.text).join(' '));for(const c of changes){const item=c.item_id??randomUUID();if(!c.item_id)this.db.prepare('INSERT INTO items VALUES(?,?,?)').run(item,project,c.title.trim());this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(randomUUID(),item,record.id,c.status,c.owner??null,c.deadline??null,c.kind??'reported');}this.db.exec('COMMIT');return record;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 search(user,project,query){this.access(user,project);const tokens=terms(query);if(!tokens.length)return [];return this.db.prepare(`SELECT r.*,bm25(record_search) AS score FROM record_search JOIN records r ON r.id=record_search.id WHERE record_search MATCH ? AND r.project_id=? ORDER BY score LIMIT 40`).all(tokens.map(t=>'"'+t+'"').join(' OR '),project);}
 close(){this.db.close();}
}
export const hash=t=>createHash('sha256').update(t).digest('hex');
export function terms(text){const out=[];for(const s of new Intl.Segmenter('zh',{granularity:'word'}).segment(text.toLowerCase()))if(s.isWordLike)out.push(s.segment);return [...new Set(out)];}
