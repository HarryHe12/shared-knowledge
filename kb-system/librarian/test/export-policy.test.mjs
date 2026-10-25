import test from 'node:test';
import assert from 'node:assert/strict';
import {allowLegacyExport} from '../scripts/export-policy.mjs';

test('平面 Wiki 和静态推送默认停用，显式开启也不能导出组织知识范围', async()=>{
  const kb={scope:'scope-one',me:async()=>({scopes:[{id:'scope-one',tenant_id:'company-one'}]})};
  assert.equal(await allowLegacyExport({me:()=>{throw Error('不应读取任何数据');}},''),false);
  await assert.rejects(allowLegacyExport(kb,'1'),{status:403});
  await assert.rejects(allowLegacyExport({...kb,scope:'not-allowed'},'1'),{status:403});
  assert.equal(await allowLegacyExport({scope:'old-private',me:async()=>({scopes:[{id:'old-private'}]})},'1'),true);
});
