import test from 'node:test';
import assert from 'node:assert/strict';
import {suggestScope, matchScope} from '../src/scope-suggest.mjs';

const scope = (id, name, extra = {}) => ({id, name, level: 'staff', store_id: null, brand_id: null, tenant_id: 't1',
  store_name: null, brand_name: null, tenant_name: '餐创食然', ...extra});

const env = [
  scope('exec', '餐创食然 · 公司负责人', {level: 'executive'}),
  scope('pub', '餐创食然 · 公司公共'),
  scope('brandpub', '胡叨叨 · 品牌公共', {brand_id: 'b1', brand_name: '胡叨叨'}),
  scope('brandmgmt', '胡叨叨 · 品牌管理', {level: 'management', brand_id: 'b1', brand_name: '胡叨叨'}),
  scope('s1staff', '胡叨叨 · 和生汇 · 员工协作', {store_id: 's1', brand_id: 'b1', store_name: '和生汇', brand_name: '胡叨叨'}),
  scope('s1mgmt', '胡叨叨 · 和生汇 · 店长管理', {level: 'management', store_id: 's1', brand_id: 'b1', store_name: '和生汇', brand_name: '胡叨叨'}),
  scope('s2staff', '胡叨叨 · 清河万象汇 · 员工协作', {store_id: 's2', brand_id: 'b1', store_name: '清河万象汇', brand_name: '胡叨叨'}),
];

test('唯一可写范围直接用，负责人级绝不自动选中', () => {
  assert.equal(suggestScope('任何内容', [scope('only', '唯一范围')]).scope.id, 'only');
  const picked = suggestScope('任何内容', env);
  assert.notEqual(picked.scope.id, 'exec');
  assert.throws(() => suggestScope('任何内容', env.filter(s => s.id === 'exec')), /无可自动写入/);
});

test('内容提到门店进该店，管理类用词提升到店长管理', () => {
  assert.equal(suggestScope('和生汇今天客流不错', env).scope.id, 's1staff');
  assert.equal(suggestScope('和生汇做了库存盘点和排班调整', env).scope.id, 's1mgmt');
  assert.equal(suggestScope('清河万象汇冷柜故障', env).scope.id, 's2staff');
});

test('品牌与品牌公共优先，无命中走稳定兜底', () => {
  assert.equal(suggestScope('胡叨叨新菜单确定了', env).scope.id, 'brandpub');
  const fallback = suggestScope('今天一切正常', env);
  assert.equal(fallback.scope.id, 'pub');
  assert.equal(fallback.reason, 'default');
});

test('岗位归属给默认落点', () => {
  const picked = suggestScope('今天一切正常', env, {assignments: [{tenant_id: 't1', store_id: 's2', role: 'staff'}]});
  assert.equal(picked.scope.id, 's2staff');
  assert.equal(picked.reason, 'assignment');
  const manager = suggestScope('今天一切正常', env, {assignments: [{tenant_id: 't1', brand_id: 'b1', role: 'brand_manager'}]});
  assert.equal(manager.scope.id, 'brandpub');
});

test('换到目标范围：精确、部分、无命中', () => {
  assert.equal(matchScope('和生汇', env).id, 's1staff');
  assert.equal(matchScope('胡叨叨 · 清河万象汇 · 员工协作', env).id, 's2staff');
  assert.equal(matchScope('不存在的地方', env), null);
  assert.equal(matchScope('', env), null);
});
