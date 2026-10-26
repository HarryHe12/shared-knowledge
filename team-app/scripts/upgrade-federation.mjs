#!/usr/bin/env node
// Explicit operator migration. There is intentionally no default database path.
import {DatabaseSync} from 'node:sqlite';
import {existsSync,lstatSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {upgradeFederation} from '../src/federation.mjs';

let db;
try {
  const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=='--db'||!isAbsolute(args[1])||!existsSync(args[1])||!lstatSync(args[1]).isFile())throw Error('explicit_existing_absolute_db_required');
  db=new DatabaseSync(args[1]);
  db.exec('PRAGMA foreign_keys=ON');
  for(const name of ['users','accounts','channel_apps','channel_bindings','org_scopes'])
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))throw Error('required_existing_schema_missing');
  if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw Error('existing_database_integrity_failed');
  upgradeFederation(db);
  if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw Error('migrated_database_integrity_failed');
  console.log(JSON.stringify({ok:true,migration:'federation-v1',tables:['federation_identities','federation_scopes','federation_requests']}));
} catch(error) {
  console.error(JSON.stringify({ok:false,error:/^[a-z_]+$/.test(error.message||'')?error.message:'federation_upgrade_failed'}));
  process.exitCode=1;
} finally {db?.close();}
