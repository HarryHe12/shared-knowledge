import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {ChatService} from '../src/chat.mjs';

const error = (message, status) => Object.assign(new Error(message), {status});
function fixture(t, model) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const user = store.user('店长甲', 'chat-one'), other = store.user('店员乙', 'chat-two');
  const project = store.project(user, '胡叨叨一店'), allowed = new Set([project.id]), writable = new Set([project.id]);
  const auth = {authorize(actor, scope, write = false) {
    store.access(actor, scope);
    if (!allowed.has(scope) || write && !writable.has(scope)) throw error('权限已撤回', 403);
  }};
  const reply = model ?? (async (_system, input) => JSON.stringify({action: 'answer', answer: '一店已完成盘点。',
    quality: 'supported', citations: [input.evidence[0].id]}));
  const chat = new ChatService(store, reply, auth);
  const create = (context = {}) => chat.create(user, {scope_id: project.id}, context);
  return {store, user, other, project, auth, chat, create, allowed, writable};
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}
const message = (text, intent, idempotency_key) => ({text, intent, idempotency_key});

test('明确保存持久化来源和确认事项，重试不重复写入，消息不复制原文', async t => {
  const f = fixture(t, async () => { throw Error('保存不应调用模型'); }), conversation = f.create();
  const input = {...message('一店完成盘点，库存20箱', 'save', 'daily-one'),
    author_id: f.other.id, occurred_at: '2026-10-24T15:00:00+08:00',
    changes: [{title: '盘点', status: 'done', kind: 'reported'}]};
  const first = await f.chat.send(f.user, conversation.id, input);
  const second = await f.chat.send(f.user, conversation.id, input);
  assert.equal(first.status, 'completed');
  assert.equal(first.result.kind, 'saved');
  assert.equal(first.result.record.id, second.result.record.id);
  assert.equal(first.result.record.author, f.user.name);
  assert.equal(first.result.record.version, 1);
  assert.equal(first.result.record.occurred_at, '2026-10-24T07:00:00.000Z');
  assert.equal(f.store.records(f.user, f.project.id).length, 1);
  assert.equal(f.store.records(f.user, f.project.id)[0].author_id, f.user.id);
  assert.equal(f.store.items(f.user, f.project.id)[0].status, 'done');
  assert.equal(f.chat.messages(f.user, conversation.id).messages[0].text, input.text);
  assert.equal(f.store.db.prepare('SELECT text FROM chat_messages WHERE role=?').get('user').text, null);
  assert.equal(f.store.db.prepare('SELECT payload FROM chat_requests').get().payload, null);
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT result FROM chat_requests').get()).includes(input.text));
  await assert.rejects(f.chat.send(f.user, conversation.id, {...input, text: '另一条记录'}), {status: 409});
  await assert.rejects(f.chat.send(f.user, conversation.id, {...input, changes: []}), {status: 409});
});

test('查询只读且返回版本化来源，模型没有保存权限也可以回答', async t => {
  const f = fixture(t), conversation = f.create();
  const record = f.store.add(f.user, f.project.id, {text: '一店已完成盘点'});
  f.writable.clear();
  const result = await f.chat.send(f.user, conversation.id, message('盘点情况', 'query', 'q-one'));
  assert.equal(result.result.status, 'answered');
  assert.deepEqual(result.result.citations.map(row => row.id), [record.id]);
  assert.equal(result.result.citations[0].author, f.user.name);
  assert.equal(result.result.citations[0].scope_id, f.project.id);
  assert.equal(result.result.citations[0].version, 1);
  assert.equal(result.result.coverage.exhaustive, false);
  assert.equal(f.store.records(f.user, f.project.id).length, 1);
  assert.equal(result.messages.length, 2);
  await assert.rejects(f.chat.send(f.user, conversation.id, message('试图保存', 'save', 'not-allowed')), {status: 403});
});

test('自动意图解析失败或问题被误判保存时询问用户，不产生知识记录', async t => {
  const f = fixture(t, async () => 'not valid JSON'), conversation = f.create();
  const first = await f.chat.send(f.user, conversation.id, message('盘点完成了', 'auto', 'ambiguous'));
  assert.equal(first.result.kind, 'needs_clarification');
  f.chat.model = async () => JSON.stringify({intent: 'save'});
  const second = await f.chat.send(f.user, conversation.id, message('盘点情况怎么样？', 'auto', 'question'));
  assert.equal(second.result.kind, 'needs_clarification');
  assert.equal(f.store.records(f.user, f.project.id).length, 0);
  const third = await f.chat.send(f.user, conversation.id, message('记录：一店今天已完成盘点', 'auto', 'fact'));
  assert.equal(third.result.kind, 'saved');
  assert.equal(f.store.items(f.user, f.project.id).length, 0);
});

test('同一幂等请求并发只生成一次，完成后可查询处理结果', async t => {
  const started = deferred(), finish = deferred();
  let calls = 0;
  const f = fixture(t, async (_system, input) => {
    calls++; started.resolve(); await finish.promise;
    return JSON.stringify({answer: '一店完成盘点。', citations: [input.evidence[0].id]});
  });
  f.store.add(f.user, f.project.id, {text: '一店完成盘点'});
  const conversation = f.create(), input = message('盘点', 'query', 'concurrent');
  const pending = f.chat.send(f.user, conversation.id, input);
  await started.promise;
  const duplicate = await f.chat.send(f.user, conversation.id, input);
  assert.equal(duplicate.status, 'processing');
  assert.equal(f.chat.request(f.user, conversation.id, duplicate.request_id).status, 'processing');
  finish.resolve();
  const result = await pending;
  assert.equal(result.request_id, duplicate.request_id);
  assert.equal(calls, 1);
  assert.equal(f.chat.request(f.user, conversation.id, duplicate.request_id).status, 'completed');
  assert.equal(f.chat.messages(f.user, conversation.id).messages.length, 2);
});

test('同一员工并发处理有上限，模型超时后原请求可恢复', async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, async (_system, input) => {
    entered.resolve(); await release.promise;
    return JSON.stringify({answer: '完成盘点', citations: [input.evidence[0].id]});
  });
  f.chat.maxConcurrentPerUser = 1;
  f.store.add(f.user, f.project.id, {text: '完成盘点'});
  const conversation = f.create();
  const pending = f.chat.send(f.user, conversation.id, message('盘点', 'query', 'concurrency-one'));
  await entered.promise;
  await assert.rejects(f.chat.send(f.user, conversation.id, message('盘点', 'query', 'concurrency-two')), {status: 429});
  release.resolve(); await pending;
  assert.equal((await f.chat.send(f.user, conversation.id, message('盘点', 'query', 'concurrency-two'))).status, 'completed');
  f.chat.modelTimeoutMs = 5;
  const late = deferred();
  f.chat.model = async () => late.promise;
  const input = message('盘点', 'query', 'timeout');
  await assert.rejects(f.chat.send(f.user, conversation.id, input), {status: 503});
  assert.equal(f.chat.activeByUser.get(f.user.id), 1);
  await assert.rejects(f.chat.send(f.user, conversation.id, input), {status: 429});
  const request = f.store.db.prepare('SELECT * FROM chat_requests WHERE idempotency_key=?').get('timeout');
  late.resolve(JSON.stringify({answer: '迟到答案', citations: [f.store.records(f.user, f.project.id)[0].id]}));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.chat.activeByUser.size, 0);
  assert.equal(f.chat.request(f.user, conversation.id, request.id).status, 'failed');
  assert.equal(f.chat.request(f.user, conversation.id, request.id).messages.length, 0);
  f.chat.model = async (_system, input) => JSON.stringify({answer: '完成盘点', citations: [input.evidence[0].id]});
  assert.equal((await f.chat.send(f.user, conversation.id, input)).status, 'completed');
});

test('模型并发总量按进程限制，其他员工和新服务实例不能绕过', async t => {
  const entered = deferred(), release = deferred();
  let calls = 0;
  const f = fixture(t, async (_system, input) => {
    calls++; if (calls === 2) entered.resolve(); await release.promise;
    return JSON.stringify({answer: '完成盘点', citations: [input.evidence[0].id]});
  });
  const third = f.store.user('第三人', 'chat-three');
  for (const user of [f.other, third]) f.store.grant(f.project.id, user.id);
  f.store.add(f.user, f.project.id, {text: '完成盘点'});
  assert.equal(f.chat.maxConcurrentModels, 16);
  f.chat.maxConcurrentModels = 2;
  const users = [f.user, f.other, third], conversations = users.map(user => f.chat.create(user, {scope_id: f.project.id}));
  const first = f.chat.send(users[0], conversations[0].id, message('盘点', 'query', 'global-one'));
  const second = f.chat.send(users[1], conversations[1].id, message('盘点', 'query', 'global-two'));
  await entered.promise;
  const another = new ChatService(f.store, f.chat.model, f.auth);
  another.maxConcurrentModels = 2;
  await assert.rejects(another.send(users[2], conversations[2].id, message('盘点', 'query', 'global-three')), {status: 429});
  release.resolve(); await Promise.all([first, second]);
  assert.equal((await another.send(users[2], conversations[2].id, message('盘点', 'query', 'global-three'))).status, 'completed');
  assert.equal(calls, 3);
});

test('提取路线可复用同一个模型闸门，超时后上游拒绝不会触发未处理异常', async t => {
  const late = deferred(), f = fixture(t, async () => late.promise);
  f.chat.modelTimeoutMs = 5;
  f.chat.maxConcurrentPerUser = 1;
  await assert.rejects(f.chat.callModel(f.user.id, 'extract', {text: '盘点完成'}), {status: 503});
  await assert.rejects(f.chat.callModel(f.user.id, 'extract', {text: '再试'}), {status: 429});
  late.resolve(Promise.reject(Error('late-provider-secret')));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.chat.activeByUser.size, 0);
  f.chat.model = async () => '{"changes":[]}';
  assert.equal(await f.chat.callModel(f.user.id, 'extract', {text: '重试'}), '{"changes":[]}');
});

test('模型失败不泄漏服务内部错误，原幂等请求可在新实例恢复', async t => {
  const f = fixture(t, async () => { throw error('secret-provider-token', 401); });
  f.store.add(f.user, f.project.id, {text: '一店完成盘点'});
  const conversation = f.create(), input = message('盘点', 'query', 'retry');
  await assert.rejects(f.chat.send(f.user, conversation.id, input), e => e.status === 503 && !e.message.includes('secret-provider-token'));
  const request = f.store.db.prepare('SELECT * FROM chat_requests').get();
  assert.equal(request.status, 'failed');
  assert.ok(!JSON.stringify(request).includes('secret-provider-token'));
  assert.equal(f.chat.messages(f.user, conversation.id).messages.length, 0);
  const restarted = new ChatService(f.store, async (_system, input) => JSON.stringify({answer: '完成盘点', citations: [input.evidence[0].id]}), f.auth);
  f.store.db.prepare("UPDATE chat_requests SET status='processing',lease_until=? WHERE id=?").run(Date.now() + 100000, request.id);
  assert.equal((await restarted.send(f.user, conversation.id, input)).status, 'processing');
  f.store.db.prepare('UPDATE chat_requests SET lease_until=0 WHERE id=?').run(request.id);
  assert.equal((await restarted.send(f.user, conversation.id, input)).status, 'completed');
});

test('保存后进程中断仍以稳定幂等键恢复，保留一个知识来源', async t => {
  const f = fixture(t), conversation = f.create(), add = f.store.add.bind(f.store);
  let first = true;
  f.store.add = (...args) => {
    const result = add(...args);
    if (first) { first = false; throw Error('crash after committed write'); }
    return result;
  };
  const input = message('记录：一店完成盘点', 'save', 'save-crash');
  await assert.rejects(f.chat.send(f.user, conversation.id, input), {status: 503});
  assert.equal(f.store.db.prepare('SELECT payload FROM chat_requests').get().payload, null);
  const restarted = new ChatService(f.store, f.chat.model, f.auth);
  const result = await restarted.send(f.user, conversation.id, input);
  assert.equal(result.result.kind, 'saved');
  assert.equal(f.store.records(f.user, f.project.id).length, 1);
  assert.equal(restarted.messages(f.user, conversation.id).messages.length, 2);
});

test('保存提交后中断仍不留原文副本，后续删除不会被重试复活', async t => {
  const f = fixture(t), conversation = f.create(), add = f.store.add.bind(f.store);
  f.store.add = (...args) => { add(...args); throw Error('crash after commit'); };
  const input = message('库存机密879箱', 'save', 'purge-after-crash');
  await assert.rejects(f.chat.send(f.user, conversation.id, input), {status: 503});
  const record = f.store.records(f.user, f.project.id)[0];
  f.store.purge(f.user, f.project.id, {id: record.id, version: 1});
  f.store.add = add;
  await assert.rejects(f.chat.send(f.user, conversation.id, input), {status: 409});
  assert.equal(f.store.records(f.user, f.project.id).length, 0);
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM chat_requests').all()).includes(input.text));
  assert.equal(f.chat.messages(f.user, conversation.id).messages.length, 0);
});

test('对话严格绑定员工与应用，应用范围在模型和历史读取前校验', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; throw Error('不应调用'); });
  f.store.grant(f.project.id, f.other.id);
  const app = {app_id: 'staff-miniapp', authorize: () => {}}, conversation = f.create(app);
  assert.throws(() => f.chat.messages(f.other, conversation.id, {}, app), {status: 404});
  assert.throws(() => f.chat.messages(f.user, conversation.id), {status: 404});
  assert.throws(() => f.chat.messages(f.user, conversation.id, {}, {...app, app_id: 'other-miniapp'}), {status: 404});
  const denied = {...app, authorize: () => { throw error('应用不允许此范围', 403); }};
  await assert.rejects(f.chat.send(f.user, conversation.id, message('盘点', 'query', 'forbidden'), denied), {status: 403});
  assert.throws(() => f.chat.messages(f.user, conversation.id, {}, denied), {status: 403});
  assert.equal(f.chat.list(f.other, {}, app).conversations.length, 0);
  assert.equal(f.chat.list(f.user).conversations.length, 0);
  assert.equal(calls, 0);
});

test('权限在生成期间被撤销，禁止回传答案和继续读取历史', async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, async (_system, input) => {
    entered.resolve(); await release.promise;
    return JSON.stringify({answer: '秘密回答', citations: [input.evidence[0].id]});
  });
  f.store.add(f.user, f.project.id, {text: '一店完成盘点'});
  const conversation = f.create(), pending = f.chat.send(f.user, conversation.id, message('盘点', 'query', 'revoked'));
  await entered.promise; f.allowed.clear(); release.resolve();
  await assert.rejects(pending, {status: 403});
  assert.throws(() => f.chat.messages(f.user, conversation.id), {status: 403});
  assert.equal(f.chat.list(f.user).conversations.length, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM chat_messages').get().n, 0);
});

test('来源更正撤回和删除使旧回答失效，保存消息跟随有效来源并可清除派生文本', async t => {
  const f = fixture(t), conversation = f.create();
  const saved = await f.chat.send(f.user, conversation.id, message('盘点发现库存999箱', 'save', 'sensitive-save'));
  const record = saved.result.record;
  f.chat.model = async (_system, input) => JSON.stringify({answer: '库存为999箱。', citations: [input.evidence[0].id]});
  const answered = await f.chat.send(f.user, conversation.id, message('库存', 'query', 'inventory'));
  assert.match(answered.result.answer, /999/);
  f.store.correct(f.user, f.project.id, {id: record.id, version: 1, text: '盘点发现库存9箱'});
  const corrected = f.chat.messages(f.user, conversation.id).messages;
  assert.equal(corrected[0].text, '盘点发现库存9箱');
  assert.equal(corrected.at(-1).result.kind, 'stale');
  assert.deepEqual(corrected.at(-1).result.citations, []);
  f.chat.invalidateDerived();
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM chat_requests').all()).includes('999箱'));
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM chat_messages').all()).includes('999箱'));
  f.store.withdraw(f.user, f.project.id, {id: record.id, version: 2});
  assert.equal(f.chat.messages(f.user, conversation.id).messages[0].unavailable, true);
  f.store.purge(f.user, f.project.id, {id: record.id, version: 3});
  assert.equal(f.chat.messages(f.user, conversation.id).messages[0].record, null);
  assert.equal((await f.chat.send(f.user, conversation.id, message('盘点发现库存999箱', 'save', 'sensitive-save'))).result.kind, 'stale');
  assert.equal(f.store.records(f.user, f.project.id).length, 0);
});

test('模型等待期间来源变化必须重新查询，不能提交过期答案', async t => {
  const f = fixture(t), conversation = f.create();
  const record = f.store.add(f.user, f.project.id, {text: '库存999箱'});
  f.chat.model = async (_system, input) => {
    f.store.purge(f.user, f.project.id, {id: record.id, version: 1});
    return JSON.stringify({answer: '库存999箱', citations: [input.evidence[0].id]});
  };
  await assert.rejects(f.chat.send(f.user, conversation.id, message('库存', 'query', 'stale-flight')), {status: 409});
  assert.equal(f.chat.messages(f.user, conversation.id).messages.length, 0);
});

test('分页使用稳定序号，新消息不造成旧页重复，删除对话清除请求和消息', async t => {
  const f = fixture(t), conversation = f.create();
  await f.chat.send(f.user, conversation.id, message('早班完成', 'save', 'early'));
  await f.chat.send(f.user, conversation.id, message('晚班完成', 'save', 'late'));
  const latest = f.chat.messages(f.user, conversation.id, {limit: '2'});
  await f.chat.send(f.user, conversation.id, message('收档完成', 'save', 'closing'));
  const older = f.chat.messages(f.user, conversation.id, {limit: 2, before: latest.next_before});
  assert.equal(latest.messages.length, 2);
  assert.equal(older.messages.length, 2);
  assert.ok(older.messages.at(-1).seq < latest.messages[0].seq);
  assert.equal(older.next_before, null);
  f.create();
  const list = f.chat.list(f.user, {limit: '1'});
  assert.ok(list.next_before);
  assert.equal(f.chat.list(f.user, {limit: 1, before: list.next_before}).conversations[0].id, conversation.id);
  f.chat.remove(f.user, conversation.id);
  assert.throws(() => f.chat.messages(f.user, conversation.id), {status: 404});
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM chat_requests').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM chat_messages').get().n, 0);
  assert.equal(f.store.records(f.user, f.project.id).length, 3);
});

test('多范围对话只允许同公司，全部授权后检索，返回逐范围覆盖情况', async t => {
  const f = fixture(t), second = f.store.project(f.user, '胡叨叨二店');
  f.allowed.add(second.id); f.writable.add(second.id);
  const tenants = new Map([[f.project.id, 'tenant-one'], [second.id, 'tenant-one']]);
  f.store.organization = {context: scope => tenants.has(scope) ? {tenant_id: tenants.get(scope)} : undefined,
    isManaged: () => false, scopes: () => []};
  const one = f.store.add(f.user, f.project.id, {text: '盘点：一店已完成'});
  const two = f.store.add(f.user, second.id, {text: '盘点：二店尚未完成'});
  let calls = 0;
  f.chat.model = async (_system, input) => {
    calls++;
    assert.equal(input.scopes.length, 2);
    assert.deepEqual(new Set(input.evidence.map(row => row.scope_id)), new Set([f.project.id, second.id]));
    return JSON.stringify({answer: '一店已完成，二店尚未完成。', quality: 'supported', citations: [one.id, two.id]});
  };
  const conversation = f.chat.create(f.user, {scope_ids: [second.id, f.project.id, second.id]});
  assert.deepEqual(conversation.scope_ids, [f.project.id, second.id].sort());
  assert.equal(conversation.scope_id, conversation.scope_ids[0]);
  const result = await f.chat.send(f.user, conversation.id, message('各店盘点情况', 'query', 'multi-query'));
  assert.equal(result.result.citations.length, 2);
  assert.equal(result.result.coverage.scopes.length, 2);
  assert.equal(result.result.coverage.exhaustive, false);
  assert.equal(result.result.coverage.registered_items_only, true);
  const before = f.store.records(f.user, f.project.id).length + f.store.records(f.user, second.id).length;
  const save = await f.chat.send(f.user, conversation.id, message('盘点全部完成', 'save', 'multi-save'));
  assert.equal(save.result.kind, 'saved');
  assert.equal(save.result.record.scope_id, conversation.scope_id);
  assert.match(save.result.answer, /已记入/);
  assert.equal(f.store.records(f.user, f.project.id).length + f.store.records(f.user, second.id).length, before + 1);
  f.allowed.delete(second.id);
  await assert.rejects(f.chat.send(f.user, conversation.id, message('盘点', 'query', 'all-scope-guard')), {status: 403});
  assert.equal(calls, 1);
  f.allowed.add(second.id); tenants.set(second.id, 'tenant-two');
  assert.throws(() => f.chat.create(f.user, {scope_ids: [f.project.id, second.id]}), {status: 400});
  tenants.delete(second.id);
  assert.throws(() => f.chat.create(f.user, {scope_ids: [f.project.id, second.id]}), {status: 400});
});

test('模型证据有长度限制，不能引用模型实际未看到的记录', async t => {
  const f = fixture(t), conversation = f.create();
  const record = f.store.add(f.user, f.project.id, {text: '盘点'.repeat(6000)});
  f.chat.model = async (_system, input) => {
    assert.equal(input.evidence[0].text.length, 8000);
    assert.equal(input.coverage.context_truncated, true);
    return JSON.stringify({answer: '盘点记录已收到。', citations: [record.id]});
  };
  assert.equal((await f.chat.send(f.user, conversation.id, message('盘点', 'query', 'bounded'))).status, 'completed');
  f.chat.model = async () => JSON.stringify({answer: '虚构回答', citations: ['not-in-evidence']});
  await assert.rejects(f.chat.send(f.user, conversation.id, message('盘点', 'query', 'fake-citation')), {status: 503});
});

test('消息参数和确认事项在写入前验证', async t => {
  const f = fixture(t), conversation = f.create();
  for (const input of [message('', 'save', 'empty'), message('a', 'bad', 'invalid'), message('a', 'save', ''),
    {...message('a', 'query', 'query-changes'), changes: []}, {...message('a', 'save', 'date'), occurred_at: null},
    {...message('a', 'save', 'bad-change'), changes: [{title: 'x', status: 'fake'}]}]) {
    await assert.rejects(f.chat.send(f.user, conversation.id, input), {status: 400});
  }
  assert.equal(f.store.records(f.user, f.project.id).length, 0);
  assert.throws(() => f.chat.messages(f.user, conversation.id, {limit: 101}), {status: 400});
  assert.throws(() => f.chat.create(f.user, {scope_id: f.project.id, scope_ids: [f.project.id]}), {status: 400});
});

async function orgFixture(t, model) {
  const f = fixture(t, model);
  const {Organization} = await import('../src/organization.mjs');
  f.store.organization = new Organization(f.store);
  const db = f.store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS accounts(user_id TEXT PRIMARY KEY REFERENCES users(id),email TEXT UNIQUE NOT NULL,
    department TEXT NOT NULL,reason TEXT NOT NULL,password TEXT NOT NULL,status TEXT NOT NULL,
    admin INTEGER NOT NULL DEFAULT 0,review_note TEXT NOT NULL DEFAULT '')`);
  db.prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?,0,'')").run(f.user.id, 'owner@test', '餐创食然', '负责人', 'pw', 'approved');
  const T = 'tenant-1', B = 'brand-1';
  db.prepare('INSERT INTO org_tenants VALUES(?,?,1)').run(T, '餐创食然');
  db.prepare('INSERT INTO org_brands VALUES(?,?,?,1)').run(B, T, '胡叨叨');
  db.prepare('INSERT INTO org_stores VALUES(?,?,?,?,1)').run('store-1', T, B, '和生汇');
  db.prepare('INSERT INTO org_stores VALUES(?,?,?,?,1)').run('store-2', T, B, '清河万象汇');
  db.prepare('INSERT INTO org_memberships VALUES(?,?,?,1)').run(T, f.user.id, 'owner');
  db.exec('CREATE TABLE IF NOT EXISTS access_scopes(id TEXT PRIMARY KEY, name TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS scope_grants(user_id TEXT NOT NULL, scope_id TEXT NOT NULL, role TEXT NOT NULL)');
  const scope = (id, name, level, store, brand = B) => {
    db.prepare('INSERT INTO projects VALUES(?,?)').run(id, name);
    db.prepare('INSERT INTO access_scopes VALUES(?,?)').run(id, name);
    db.prepare("INSERT INTO org_scopes VALUES(?,?,?,?,?,'staff',1)").run(id, T, brand, store, level);
    f.allowed.add(id); f.writable.add(id);
  };
  scope('sc-exec', '餐创食然 · 公司负责人', 'executive', null, null);
  scope('sc-pub', '餐创食然 · 公司公共', 'staff', null, null);
  scope('sc-bpub', '胡叨叨 · 品牌公共', 'staff', null);
  scope('sc-bmgmt', '胡叨叨 · 品牌管理', 'management', null);
  scope('sc-s1staff', '胡叨叨 · 和生汇 · 员工协作', 'staff', 'store-1');
  scope('sc-s1mgmt', '胡叨叨 · 和生汇 · 店长管理', 'management', 'store-1');
  scope('sc-s2staff', '胡叨叨 · 清河万象汇 · 员工协作', 'staff', 'store-2');
  scope('sc-s2mgmt', '胡叨叨 · 清河万象汇 · 店长管理', 'management', 'store-2');
  f.scopes = {exec: 'sc-exec', pub: 'sc-pub', bpub: 'sc-bpub', bmgmt: 'sc-bmgmt',
    s1staff: 'sc-s1staff', s1mgmt: 'sc-s1mgmt', s2staff: 'sc-s2staff', s2mgmt: 'sc-s2mgmt'};
  return f;
}

test('多范围保存自动推导落点：内容关键词、管理用词提升、品牌优先、稳定兜底', async t => {
  const f = await orgFixture(t, async () => { throw Error('保存推导不调用模型'); });
  const conversation = f.chat.create(f.user, {scope_ids: Object.values(f.scopes)});
  const landed = async (text, key, scopeId) => {
    const result = await f.chat.send(f.user, conversation.id, message(text, 'save', key));
    assert.equal(result.result.kind, 'saved', text);
    assert.equal(result.result.record.scope_id, scopeId, text);
    return result.result.record;
  };
  await landed('和生汇今天客流不错', 'k1', f.scopes.s1staff);
  await landed('和生汇做了库存盘点和排班调整', 'k2', f.scopes.s1mgmt);
  await landed('清河万象汇冷柜故障已报修', 'k3', f.scopes.s2staff);
  await landed('胡叨叨新菜单确定了', 'k4', f.scopes.bpub);
  await landed('今天工作一切正常', 'k5', f.scopes.pub);
  for (const scope of Object.values(f.scopes))
    assert.ok(!f.store.records(f.user, scope).some(row => row.project_id === f.scopes.exec), '负责人级不自动写入');
  assert.match((await f.chat.send(f.user, conversation.id, message('和生汇客人表扬服务', 'save', 'k6'))).result.answer, /换/);
});

test('回复“换到XX”把最近一条记录改存到其他范围，原记录撤回有修订历史', async t => {
  const f = await orgFixture(t, async () => 'not json');
  const conversation = f.chat.create(f.user, {scope_ids: Object.values(f.scopes)});
  const first = await f.chat.send(f.user, conversation.id, message('今天工作一切正常', 'save', 'r1'));
  assert.equal(first.result.record.scope_id, f.scopes.pub);
  const moved = await f.chat.send(f.user, conversation.id, message('换到和生汇', 'auto', 'r2'));
  assert.equal(moved.result.kind, 'saved');
  assert.match(moved.result.answer, /改存到【胡叨叨 · 和生汇 · 员工协作】/);
  assert.equal(moved.result.record.scope_id, f.scopes.s1staff);
  assert.equal(f.store.records(f.user, f.scopes.s1staff)[0]?.text, '今天工作一切正常');
  assert.equal(f.store.records(f.user, f.scopes.pub).length, 0);
  assert.equal(f.store.records(f.user, f.scopes.s1staff).length, 1);
  const history = f.store.history(f.user, f.scopes.pub, first.result.record.id);
  assert.ok(history.revisions.some(row => row.action === 'withdraw'));
  const bare = await f.chat.send(f.user, conversation.id, message('换', 'auto', 'r3'));
  assert.equal(bare.result.kind, 'needs_clarification');
  assert.ok(bare.result.clarification.scope_ids.length >= 1);
  const goods = await f.chat.send(f.user, conversation.id, message('换货流程怎么操作', 'auto', 'r4'));
  assert.equal(goods.result.kind, 'needs_clarification');
  assert.match(goods.result.answer, /保存为工作记录，还是查询/);
});

test('普通店员只有一个可写范围时保存零打扰，不回执范围选择提示', async t => {
  const f = await orgFixture(t, async () => 'not json');
  const db = f.store.db;
  const clerk = f.store.user('店员丙', 'clerk-one');
  db.prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?,0,'')").run(clerk.id, 'clerk@test', '胡叨叨', '店员', 'pw', 'approved');
  db.prepare('INSERT INTO org_memberships VALUES(?,?,?,1)').run('tenant-1', clerk.id, 'member');
  db.prepare('INSERT INTO org_assignments VALUES(?,?,?,?,?,?)').run('a-1', 'tenant-1', clerk.id, 'brand-1', 'store-1', 'staff');
  for (const scope of Object.values(f.scopes)) if (scope !== 'sc-s1staff') f.writable.delete(scope);
  const conversation = f.chat.create(clerk, {scope_ids: [f.scopes.s1staff, f.scopes.bpub, f.scopes.pub]});
  const result = await f.chat.send(clerk, conversation.id, message('今天一切正常', 'save', 'c1'));
  assert.equal(result.result.kind, 'saved');
  assert.equal(result.result.record.scope_id, f.scopes.s1staff);
  assert.match(result.result.answer, /已记入【胡叨叨 · 和生汇 · 员工协作】/);
  assert.ok(!/换/.test(result.result.answer));
});
