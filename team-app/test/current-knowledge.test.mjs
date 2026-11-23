import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {CurrentKnowledge, setKnowledgeReadMode} from '../src/current-knowledge.mjs';
import {getState, searchRecords} from '../src/evidence.mjs';
import {currentWiki} from '../src/knowledge-wiki.mjs';

const now = Date.parse('2026-11-23T00:00:00Z');
const hours = (subject, field, value, date = null) => ({subject, field, qualifier: '周六', value, from: date, through: date});
const oldHours = [hours('一店', '开门时间', '9:00'), hours('一店', '关门时间', '18:00')];
const modelOutput = facts => JSON.stringify({facts});

function openStore(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const user = store.user('测试员工', 'local-test-token');
  const scope = store.project(user, '一店员工').id;
  return {store, user, scope};
}

function add({store, user, scope}, text, options = {}) {
  return store.add(user, scope, {text, ...options});
}

async function read({store, user, scope}, query = '一店周六几点开门', asOf) {
  return searchRecords(store, user, scope, {query, as_of: asOf});
}

test('录入顺序决定生效事实，部分覆盖保留其余字段，门店和日期各自生效', async t => {
  const f = openStore(t), {store, user, scope} = f;
  const older = add(f, '一店周六 9:00 开门，18:00 关门', {occurred_at: '2026-11-22'});
  const current = add(f, '一店每周六 10:00 开门', {occurred_at: '2026-11-20'});
  const dated = add(f, '一店 2026-12-05 特例 11:00 开门');
  add(f, '二店周六 8:00 开门');
  const queue = new Map([
    [older.text, oldHours], [current.text, [hours('一店', '开门时间', '10:00')]],
    [dated.text, [hours('一店', '开门时间', '11:00', '2026-12-05')]],
    ['二店周六 8:00 开门', [hours('二店', '开门时间', '8:00')]],
  ]);
  store.knowledge = new CurrentKnowledge(store, {now: () => now});
  assert.equal((await read(f)).coverage.status, 'updating');
  for (let count = 0; count < queue.size; count++) {
    assert.equal(await store.knowledge.runOnce((_uid, _system, input) => modelOutput(queue.get(input.text))), 'processed');
  }
  const result = await read(f);
  assert.equal(result.retrieval.as_of, '2026-11-28');
  assert.equal(result.records.find(row => row.id === current.id).text, '一店 开门时间（周六） 10:00');
  assert.equal(result.records.find(row => row.id === older.id).text, '一店 关门时间（周六） 18:00');
  assert.equal(result.records.find(row => row.text.includes('二店')).text, '二店 开门时间（周六） 8:00');
  assert.ok(!(await read(f)).records.some(row => row.text.includes('9:00')));
  assert.equal((await read(f, '下周六一店几点开门')).records.find(row => row.id === dated.id).text,
    '一店 开门时间（周六，2026-12-05 至 2026-12-05） 11:00');
  assert.ok(!(await read(f, '一店开门', '2026-12-05')).records.some(row => row.id === current.id));
  assert.equal(store.records(user, scope)[1].text, older.text);
  const page = currentWiki(store.knowledge, scope).pages.find(row => row.title === '一店').text;
  assert.match(page, /10:00/);
  assert.match(page, /18:00/);
  assert.doesNotMatch(page, /9:00|11:00/);
});

test('更正、撤回、恢复和彻底删除重新计算事实，重试保留提交顺序', async t => {
  const f = openStore(t), {store, user, scope} = f;
  store.knowledge = new CurrentKnowledge(store, {now: () => now});
  const older = add(f, '一店周六开门 9:00');
  const latest = add(f, '一店周六开门 10:00', {idempotency: 'same-write'});
  assert.equal(add(f, latest.text, {idempotency: 'same-write'}).id, latest.id);
  const extractTime = (_uid, _system, {text}) => modelOutput([hours('一店', '开门时间', text.split(' ').at(-1))]);
  assert.equal(await store.knowledge.runOnce(async () => { throw new Error('模型故障'); }), 'retry');
  assert.equal(await store.knowledge.runOnce(extractTime), 'processed');
  assert.equal((await read(f)).coverage.status, 'updating');
  store.knowledge.now = () => now + 3000;
  assert.equal(await store.knowledge.runOnce(extractTime), 'processed');
  assert.equal((await read(f)).records[0].id, latest.id);
  store.withdraw(user, scope, {id: latest.id, version: 1});
  assert.equal((await read(f)).records[0].id, older.id);
  store.restore(user, scope, {id: latest.id, version: 2});
  assert.equal((await read(f)).records[0].version, 3);
  store.correct(user, scope, {id: older.id, version: 1, text: '一店周六开门 10:30'});
  assert.equal((await read(f)).coverage.status, 'updating');
  assert.equal(await store.knowledge.runOnce(extractTime), 'processed');
  assert.equal((await read(f)).records[0].text, '一店 开门时间（周六） 10:30');
  assert.equal((await read(f)).records[0].version, 2);
  store.purge(user, scope, {id: older.id, version: 2});
  assert.equal((await read(f)).records[0].id, latest.id);
  assert.equal(store.db.prepare("SELECT 1 FROM knowledge_facts WHERE value='10:30'").get(), undefined);
});

test('已登记事项使用同一套录入顺序，事项详情仍引用提供详情的记录', async t => {
  const f = openStore(t), {store, user, scope} = f;
  const initial = add(f, '冷柜维修阻塞', {occurred_at: '2026-11-22',
    changes: [{title: '冷柜维修', status: 'blocked', owner: '值班店长'}]});
  const item = store.items(user, scope)[0];
  const fixed = add(f, '冷柜维修已完成', {occurred_at: '2026-11-21',
    changes: [{item_id: item.id, title: item.title, status: 'done', owner: '值班店长'}]});
  const reopened = add(f, '冷柜维修重新阻塞', {occurred_at: '2026-11-20'});
  store.knowledge = new CurrentKnowledge(store, {now: () => now});
  const noFacts = () => modelOutput([]);
  await store.knowledge.runOnce(noFacts);
  await store.knowledge.runOnce(noFacts);
  await store.knowledge.runOnce((_uid, _system, {candidates}) => {
    assert.ok(candidates.some(candidate => candidate.item_id === item.id));
    return modelOutput([{subject: item.title, field: '状态', value: '重新阻塞', item_id: item.id, item_status: 'blocked'}]);
  });
  const state = getState(store, user, scope);
  assert.equal(state.items[0].status, 'blocked');
  assert.equal(state.items[0].source_id, reopened.id);
  assert.equal(state.evidence.find(row => row.id === fixed.id).text, '冷柜维修，跟进人 值班店长');
  assert.equal(state.evidence.find(row => row.id === reopened.id).text, '冷柜维修 状态 阻塞');
  assert.ok(!state.evidence.some(row => row.id === initial.id));
  store.withdraw(user, scope, {id: reopened.id, version: 1});
  assert.equal(getState(store, user, scope).items[0].status, 'done');
});

test('并行处理、进程重开和更正发生在提取期间时，旧任务无法覆盖新版本', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'current-knowledge-'));
  const file = join(directory, 'test.sqlite');
  const store = new Store(file), user = store.user('测试员工', 'local-test-token');
  const scope = store.project(user, '一店员工').id;
  const second = new Store(file);
  t.after(() => {second.close();store.close();rmSync(directory, {recursive: true, force: true});});
  store.knowledge = new CurrentKnowledge(store, {now: () => now});
  second.knowledge = new CurrentKnowledge(second, {now: () => now});
  const original = add({store, user, scope}, '一店 9:00');
  let finishFirst;
  const previousRun = store.knowledge.runOnce(() => new Promise(resolve => {finishFirst = resolve;}));
  assert.equal(await second.knowledge.runOnce(() => assert.fail('同一任务不可被同时领取')), 'idle');
  second.correct(user, scope, {id: original.id, version: 1, text: '一店 10:00'});
  await second.knowledge.runOnce(() => modelOutput([hours('一店', '开门时间', '10:00')]));
  finishFirst(modelOutput([hours('一店', '开门时间', '9:00')]));
  await previousRun;
  const result = await read({store, user, scope});
  assert.equal(result.records[0].text, '一店 开门时间（周六） 10:00');
  assert.equal(result.records[0].version, 2);
});

test('旧库回填保持原读法，开启生效读取会使旧答案的版本过期', async t => {
  const f = openStore(t), {store, scope} = f;
  add(f, '一店周六 9:00');
  const newest = add(f, '一店周六 10:00');
  const epoch = () => store.db.prepare('SELECT value FROM record_epoch').get().value;
  const legacyEpoch = epoch();
  const backfill = new CurrentKnowledge(store, {now:() => now, serving:false});
  assert.equal((await read(f)).records.length, 2);
  const model = (_uid, _system, {text}) => modelOutput([hours('一店', '开门时间', text.split(' ').at(-1))]);
  await backfill.runOnce(model);
  await backfill.runOnce(model);
  assert.equal(epoch(), legacyEpoch);
  assert.equal(backfill.pending(scope), false);
  assert.equal((await read(f)).records.length, 2);
  store.knowledge = new CurrentKnowledge(store, {now:() => now});
  setKnowledgeReadMode(store.db, true);
  assert.equal(epoch(), legacyEpoch + 1);
  assert.deepEqual((await read(f)).records.map(row => row.id), [newest.id]);
  setKnowledgeReadMode(store.db, true);
  assert.equal(epoch(), legacyEpoch + 1);
});
