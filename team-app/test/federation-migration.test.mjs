import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {Store} from '../src/store.mjs';
import {Auth} from '../src/auth.mjs';
import {Channels} from '../src/channels.mjs';
const script=fileURLToPath(new URL('../scripts/upgrade-federation.mjs',import.meta.url));
test('migration CLI requires explicit existing absolute database and never creates one by default',()=>{
 const dir=mkdtempSync(join(tmpdir(),'kb-federation-cli-'));
 try {
  for(const args of [[],['--db','relative.sqlite'],['--db',join(dir,'absent.sqlite')]])assert.notEqual(spawnSync(process.execPath,[script,...args],{encoding:'utf8'}).status,0);
  assert.equal(existsSync(join(dir,'absent.sqlite')),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('explicit migration CLI is repeatable and preserves prior tables and data',()=>{
 const dir=mkdtempSync(join(tmpdir(),'kb-federation-cli-')),filename=join(dir,'synthetic.sqlite');
 try {
  let store=new Store(filename),project=store.defaultProject(),auth=new Auth(store,project);new Channels(store,auth);
  store.db.exec("CREATE TABLE synthetic_sentinel(id TEXT PRIMARY KEY,value TEXT); INSERT INTO synthetic_sentinel VALUES('one','keep')");
  const before=store.db.prepare('SELECT * FROM synthetic_sentinel').all();store.close();
  for(let i=0;i<2;i++)assert.equal(spawnSync(process.execPath,[script,'--db',filename],{encoding:'utf8'}).status,0);
  store=new Store(filename);assert.deepEqual(store.db.prepare('SELECT * FROM synthetic_sentinel').all(),before);
  assert.equal(store.db.prepare('SELECT count(*) n FROM federation_identities').get().n,0);store.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
