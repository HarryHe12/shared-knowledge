import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {credential} from '../scripts/session.mjs';
test('Windows native credential store persists, replaces, isolates and deletes credentials',{skip:process.platform!=='win32'},async()=>{
 const key='shared-knowledge:test:'+randomUUID(),other=key+':pending';
 try{
  assert.equal(await credential(key),'');
  await credential(key,'测试 token " \\ $value');
  assert.equal(await credential(key),'测试 token " \\ $value');
  assert.equal(await credential(other),'');
  await credential(other,'pending-token');
  await credential(key,'replacement');
  assert.equal(await credential(key),'replacement');
  assert.equal(await credential(other),'pending-token');
  await credential(key,null);assert.equal(await credential(key),'');
  await credential(key,null);
 }finally{await credential(key,null);await credential(other,null);}
});
