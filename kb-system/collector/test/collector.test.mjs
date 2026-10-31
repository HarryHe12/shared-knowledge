import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync, rmSync, existsSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCollector, splitReply} from '../src/server.mjs';
import {KnowledgeBase} from '../src/kb.mjs';
import {DurableInbox} from '../src/inbox.mjs';
import {WxCrypto, xmlField, DEV_TOKEN, DEV_ENCODING_AES_KEY, DEV_CORP_ID} from '../src/wxcrypto.mjs';

const env = {WECOM_TOKEN: DEV_TOKEN, WECOM_ENCODING_AES_KEY: DEV_ENCODING_AES_KEY, WECOM_CORP_ID: DEV_CORP_ID,
  WECOM_AGENT_ID: '7', KB_CHANNEL_APP_ID: 'company-wecom', KB_CHANNEL_BRIDGE_KEY: 'bridge-key-with-at-least-24-chars', KB_URL: 'http://127.0.0.1:5181'};
const wx = new WxCrypto(DEV_TOKEN, DEV_ENCODING_AES_KEY, DEV_CORP_ID);
const scopes = [{id: 'store-a', name: '甲门店工作', tenant_id: 'company', role: 'writer'}];

function coreMock() {
  const calls = [], records = new Map(), sessions = new Map(), conversations = new Map(), requests = new Map();
  let serial = 0;
  const state = {calls, records, scopes: {alice: scopes, bob: [{id: 'store-b', name: '乙门店', tenant_id: 'company', role: 'writer'}]}, bound: true,
    verifiedAt: '2026-01-01T00:00:00.000Z', dropAfterSave: false, afterMessage: null, beforeMessage: null, stale: false};
  const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {'Content-Type': 'application/json'}});
  state.fetch = async (url, options) => {
    const path = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : null;
    const token = options.headers.Authorization?.replace(/^Bearer /, '');
    calls.push({path, body, token, scope: options.headers['X-Knowledge-Scope'], redirect: options.redirect});
    if (path.endsWith('/bridge')) {
      assert.equal(token, env.KB_CHANNEL_BRIDGE_KEY);
      if (!state.bound) return json({error: 'not bound'}, 403);
    const user = state.boundUser ?? body.external_id;
      const session = 'employee-' + ++serial;
      sessions.set(session, user);
      return json({token: session, user: {id: user, name: user}, identity_verified_at: state.verifiedAt});
    }
    // Test tokens represent an employee's preexisting desktop login.
    const user = token === 'desktop-alice' ? 'alice' : sessions.get(token);
    if (!user) return json({error: '请登录员工'}, 401);
    if (path === '/api/v1/me') return json({user: {id: user, name: user}, scopes: state.scopes[user] ?? []});
    if (path === '/api/v1/logout') { sessions.delete(token); return json({ok: true}); }
    if (path === '/api/v1/conversations') {
      assert.ok(body.scope_ids.every(id => state.scopes[user].some(s => s.id === id)));
      const id = 'conversation-' + ++serial;
      conversations.set(id, {user, scopes: body.scope_ids});
      return json({id, scope_ids: body.scope_ids});
    }
    if (/\/conversations\/[^/]+\/requests\/[^/]+$/.test(path)) {
      const requestId = decodeURIComponent(path.split('/').at(-1)), request = requests.get(requestId);
      assert.equal(request.user, user);
      return json({status: 'completed', request_id: requestId, result: state.stale
        ? {kind: 'stale', answer: '来源已经变化'} : request.result});
    }
    if (/\/conversations\/[^/]+\/messages$/.test(path)) {
      const id = path.split('/')[4], conversation = conversations.get(id);
      assert.equal(conversation.user, user);
      await state.beforeMessage?.(user, body);
      const key = id + ':' + body.idempotency_key;
      let result = records.get(key);
      if (!result) {
        const save = body.intent === 'save' || body.intent === 'auto' && !body.text.includes('？');
        result = save && conversation.scopes.length > 1
          ? {kind: 'needs_clarification', answer: '请选择保存范围', clarification: {scope_ids: conversation.scopes}, citations: []}
          : save ? {kind: 'saved', answer: '已保存工作记录 #record01', record: {id: 'record01'}, citations: []}
            : {kind: 'answer', answer: '项目正在推进', citations: [{id: 'record01', scope_id: conversation.scopes[0]}]};
        records.set(key, result);
      }
      state.afterMessage?.();
      if (state.dropAfterSave) { state.dropAfterSave = false; throw new Error('response lost after commit'); }
      const requestId = 'request-' + key;
      requests.set(requestId, {user, result});
      return json({status: 'completed', request_id: requestId, result});
    }
    if (path === '/api/v1/records') {
      const key = user + ':' + body.scope_id + ':' + body.idempotency_key;
      if (!records.has(key)) records.set(key, {id: 'desktop-record', text: body.text});
      return json(records.get(key));
    }
    if (path === '/api/v1/search') return json({results: [{records: [{id: 'r', text: '获准证据', project_id: body.scope_id}]}], coverage: {exhaustive: false}});
    throw new Error('unexpected ' + path);
  };
  return state;
}

async function fixture({configuration = env, inbox = new DurableInbox(':memory:'), core = coreMock()} = {}) {
  const sent = [];
  const wecom = {configured: true, async sendText(user, text) { sent.push({user, text}); }};
  const app = createCollector({env: configuration, inbox, fetchImpl: core.fetch, wecom, logger: {error() {}}});
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = 'http://127.0.0.1:' + app.server.address().port;
  return {...app, base, core, sent, wecom};
}

function callback(base, {user = 'alice', id = '101', text = '记录：甲店今天完成培训', signature = true, type = 'text', agentId = '7'} = {}) {
  const message = `<xml><ToUserName>${DEV_CORP_ID}</ToUserName><FromUserName>${user}</FromUserName><CreateTime>1800000000</CreateTime><MsgType>${type}</MsgType><Content><![CDATA[${text}]]></Content><MsgId>${id}</MsgId>${agentId ? '<AgentID>' + agentId + '</AgentID>' : ''}</xml>`;
  const encrypted = wx.encrypt(message), timestamp = String(Math.floor(Date.now() / 1000)), nonce = 'test';
  const q = new URLSearchParams({timestamp, nonce, msg_signature: signature ? wx.signature(timestamp, nonce, encrypted) : 'bad'});
  return fetch(base + '/wecom/callback?' + q, {method: 'POST', body: '<xml><Encrypt><![CDATA[' + encrypted + ']]></Encrypt></xml>'});
}

function passive(xml) { return xmlField(wx.decrypt(xmlField(xml, 'Encrypt')).message, 'Content'); }

test('signed callbacks are durably queued before acknowledgement and run under separate employee identities', async () => {
  const f = await fixture();
  try {
    const response = await callback(f.base);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
    assert.equal(f.core.calls.length, 0);
    assert.equal(f.inbox.db.prepare('SELECT count(*) AS n FROM collector_inbox').get().n, 1);
    await f.worker.runOnce();
    assert.match(f.sent[0].text, /已保存工作记录/);
    await callback(f.base); await f.worker.runOnce();
    assert.equal(f.sent.length, 1);
    await callback(f.base, {user: 'bob', id: '102', text: '问：本店进展'}); await f.worker.runOnce();
    assert.equal(f.sent[1].user, 'bob');
    assert.ok(!/来源：/.test(f.sent[1].text));
    assert.deepEqual(f.core.calls.filter(c => c.path === '/api/v1/conversations').map(c => c.body.scope_ids), [['store-a'], ['store-b']]);
    assert.ok(f.core.calls.every(c => c.redirect === 'error'));
    const completed = f.inbox.db.prepare('SELECT text,input,output,status FROM collector_inbox ORDER BY seq').all();
    assert.ok(completed.every(j => j.status === 'done' && j.text === null && j.input === null && j.output === null));
  } finally { await f.close(); }
});

test('unconfigured, unsigned, unbound and unsupported callbacks cannot silently enter the global knowledge library', async () => {
  const f = await fixture({configuration: {...env, KB_CHANNEL_BRIDGE_KEY: ''}});
  try {
    assert.match(passive(await (await callback(f.base)).text()), /尚未入库/);
    assert.equal(f.inbox.db.prepare('SELECT count(*) AS n FROM collector_inbox').get().n, 0);
    assert.equal((await callback(f.base, {signature: false})).status, 403);
    assert.equal((await callback(f.base, {user: '@all'})).status, 400);
    assert.equal((await callback(f.base, {agentId: ''})).status, 403);
  } finally { await f.close(); }
  const g = await fixture();
  try {
    g.core.bound = false;
    await callback(g.base); await g.worker.runOnce();
    assert.match(g.sent[0].text, /还没绑定/);
    assert.equal(g.core.calls.filter(c => c.path.includes('conversations')).length, 0);
    assert.match(passive(await (await callback(g.base, {id: '2', type: 'image'})).text()), /尚未入库/);
  } finally { await g.close(); }
});

test('a queued message cannot be reassigned to an employee binding created after the message', async () => {
  for (const offset of [0, 1]) {
    const f = await fixture();
    try {
      await callback(f.base);
      f.core.boundUser = 'replacement';
      f.core.scopes.replacement = scopes;
      f.core.verifiedAt = new Date(1800000000 * 1000 + offset).toISOString();
      await f.worker.runOnce();
      assert.equal(f.core.records.size, 0);
      assert.equal(f.core.calls.filter(c => c.path.includes('/conversations')).length, 0);
      assert.match(f.sent[0].text, /没存进去/);
      assert.match(f.sent[0].text, /把原文再发我一次/);
    } finally { await f.close(); }
  }
});

test('the worker pool processes other employees during a slow question and preserves each employee FIFO', async () => {
  const f = await fixture();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  try {
    assert.equal(f.workers.length, 4);
    assert.equal(f.worker, f.workers[0]);
    f.core.beforeMessage = async user => { if (user === 'alice') { entered(); await blocked; } };
    await callback(f.base, {id: '1', text: '问：较慢的问题'});
    await callback(f.base, {id: '2', text: '记录：必须在问题之后处理'});
    await callback(f.base, {id: '3', user: 'bob', text: '记录：另一家店可以先处理'});
    const runs = f.workers.map(worker => worker.runOnce());
    await started;
    await runs[1];
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0].user, 'bob');
    assert.equal(await f.workers[2].runOnce(), false);
    release(); await Promise.all(runs);
    await f.worker.runOnce();
    assert.deepEqual(f.sent.map(item => item.user), ['bob', 'alice', 'alice']);
    const aliceMessages = f.core.calls.filter(call => call.path.endsWith('/messages') &&
      (call.body.text.includes('较慢的问题') || call.body.text.includes('必须在问题之后')));
    assert.deepEqual(aliceMessages.map(call => call.body.intent), ['query', 'save']);
  } finally { release(); await f.close(); }
});

test('blank database configuration uses a persistent default and worker counts are bounded', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'collector-default-db-')), path = join(directory, 'persistent.sqlite');
  let app;
  try {
    app = createCollector({env: {...env, COLLECTOR_DB: '', COLLECTOR_CONCURRENCY: '2'}, defaultInboxPath: path,
      fetchImpl: coreMock().fetch, wecom: {configured: true, async sendText() {}}});
    assert.equal(app.workers.length, 2);
    assert.equal(existsSync(path), true);
    assert.equal(app.inbox.db.prepare('PRAGMA database_list').get().file, realpathSync(path));
    for (const value of ['0', '9', 'two']) assert.throws(() => createCollector({env: {...env, COLLECTOR_CONCURRENCY: value}}), /CONCURRENCY/);
    for (const value of [':memory:', 'file::memory:', '   ']) assert.throws(() => createCollector({env: {...env, COLLECTOR_DB: value}}), /持久化/);
  } finally { await app?.close(); rmSync(directory, {recursive: true, force: true}); }
});

test('multi-scope saves delegate scope choice to the core derivation, while questions query the authorized company union', async () => {
  const f = await fixture();
  try {
    f.core.scopes.alice = [...scopes, {id: 'store-a-managers', name: '甲门店管理', tenant_id: 'company', role: 'writer'}];
    await callback(f.base); await f.worker.runOnce();
    assert.match(f.sent.at(-1).text, /可以选：【甲门店工作】、【甲门店管理】/);
    assert.deepEqual(f.core.calls.find(c => c.path === '/api/v1/conversations').body.scope_ids, ['store-a', 'store-a-managers']);
    await callback(f.base, {id: '2', text: '问：甲店培训怎么样'}); await f.worker.runOnce();
    assert.deepEqual(f.core.calls.find(c => c.path === '/api/v1/conversations').body.scope_ids, ['store-a', 'store-a-managers']);
    await callback(f.base, {id: '3', text: '/范围 甲门店管理'}); await f.worker.runOnce();
    await callback(f.base, {id: '4', text: '记录：甲店管理会议结论'}); await f.worker.runOnce();
    assert.deepEqual(f.core.calls.filter(c => c.path === '/api/v1/conversations').at(-1).body.scope_ids, ['store-a-managers']);
    assert.match(f.sent.at(-1).text, /已保存/);
  } finally { await f.close(); }
});

test('a lost core save response retries the frozen message without duplicate records and checks permission before push', async () => {
  let now = 1000;
  const f = await fixture({inbox: new DurableInbox(':memory:', {now: () => now})});
  try {
    f.core.dropAfterSave = true;
    await callback(f.base); await f.worker.runOnce();
    assert.equal(f.sent.length, 0);
    assert.equal(f.core.records.size, 1);
    now += 10000; await f.worker.runOnce();
    assert.equal(f.core.records.size, 1);
    assert.equal(f.sent.length, 1);
    const requests = f.core.calls.filter(c => c.path.endsWith('/messages'));
    assert.deepEqual(requests[0].body, requests[1].body);
    assert.equal(requests[0].path, requests[1].path);
    f.core.afterMessage = () => { f.core.scopes.alice = []; };
    await callback(f.base, {id: '2', text: '问：敏感进展'}); await f.worker.runOnce();
    assert.match(f.sent.at(-1).text, /没有对应范围的权限/);
    assert.ok(!f.sent.at(-1).text.includes('项目正在推进'));
  } finally { await f.close(); }
});

test('source invalidation before or between push chunks stops delivery of the old answer', async () => {
  for (const beforeFirstChunk of [true, false]) {
    const f = await fixture();
    try {
      f.core.afterMessage = () => {
        if (beforeFirstChunk) f.core.stale = true;
        else for (const result of f.core.records.values()) result.answer = '原始来源尚未更新的长答案。'.repeat(300);
      };
      const send = f.wecom.sendText.bind(f.wecom);
      f.wecom.sendText = async (...args) => { await send(...args); f.core.stale = true; };
      await callback(f.base, {text: '问：当前项目进度'}); await f.worker.runOnce();
      assert.equal(f.sent.length, beforeFirstChunk ? 1 : 2);
      assert.match(f.sent.at(-1).text, /来源或权限发生变化/);
      assert.ok(!f.sent.at(-1).text.includes('原始来源尚未更新的长答案'));
      assert.ok(f.core.calls.some(call => /\/requests\//.test(call.path)));
    } finally { await f.close(); }
  }
});

test('durable leases survive restart, preserve employee FIFO and stop after bounded failures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'collector-test-')), path = join(directory, 'inbox.sqlite');
  let now = 1000, queue;
  try {
    queue = new DurableInbox(path, {now: () => now, maxAttempts: 2});
    const first = queue.enqueue({appId: 'app', externalId: 'alice', msgId: '1', text: '原文', occurredAt: '2026-01-01T00:00:00Z'});
    const duplicate = queue.enqueue({appId: 'app', externalId: 'alice', msgId: '1', text: '原文', occurredAt: '2026-01-01T00:00:00Z'});
    assert.equal(first.id, duplicate.id);
    assert.throws(() => queue.enqueue({appId: 'app', externalId: 'alice', msgId: '1', text: '改变原文', occurredAt: first.occurred_at}), error => error.status === 409);
    const second = queue.enqueue({appId: 'app', externalId: 'alice', msgId: '2', text: '第二条', occurredAt: first.occurred_at});
    const originalLease = queue.claim();
    assert.equal(originalLease.id, first.id);
    assert.equal(queue.claim(), null);
    queue.close();
    now += 130000; queue = new DurableInbox(path, {now: () => now, maxAttempts: 2});
    const retry = queue.claim(); assert.equal(retry.id, first.id); assert.equal(retry.attempts, 2);
    assert.throws(() => queue.finish(originalLease), error => error.leaseLost === true);
    queue.close();
    now += 130000; queue = new DurableInbox(path, {now: () => now, maxAttempts: 2});
    assert.equal(queue.claim().id, second.id);
    assert.equal(queue.get(first.id).status, 'dead');
    assert.equal(queue.get(first.id).text, null);
  } finally { queue?.close(); rmSync(directory, {recursive: true, force: true}); }
});

test('push failures retry durable messages and unavailable core stops after the configured limit', async () => {
  let now = 1000;
  const f = await fixture({inbox: new DurableInbox(':memory:', {now: () => now, maxAttempts: 2})});
  try {
    const send = f.wecom.sendText.bind(f.wecom); let failPush = true;
    f.wecom.sendText = async (...args) => {
      if (failPush) { failPush = false; throw new Error('temporary WeCom outage'); }
      return send(...args);
    };
    await callback(f.base); await f.worker.runOnce();
    assert.equal(f.core.records.size, 1); assert.equal(f.sent.length, 0);
    now += 10000; await f.worker.runOnce();
    assert.equal(f.core.records.size, 1); assert.match(f.sent[0].text, /已保存/);
    f.worker.kb.fetch = async () => { throw new Error('core unavailable'); };
    await callback(f.base, {id: '2'}); await f.worker.runOnce();
    now += 10000; await f.worker.runOnce();
    assert.match(f.sent.at(-1).text, /我先不重试了/);
    const dead = f.inbox.db.prepare("SELECT * FROM collector_inbox WHERE status='dead'").get();
    assert.equal(dead.attempts, 2); assert.equal(dead.text, null); assert.equal(dead.input, null);
    assert.equal(await f.worker.runOnce(), false);
  } finally { await f.close(); }
});

test('Agent gateway keys never become business identity; employee bearer and authorized scope reach core v1', async () => {
  const f = await fixture({configuration: {...env, AGENT_API_KEYS: 'codex:gateway-key'}});
  try {
    let response = await fetch(f.base + '/agent/ping', {headers: {Authorization: 'Bearer gateway-key', 'X-Agent-Key': 'gateway-key'}});
    assert.equal(response.status, 401);
    const headers = {Authorization: 'Bearer desktop-alice', 'X-Agent-Key': 'gateway-key', 'X-Knowledge-Scope': 'store-a', 'Content-Type': 'application/json'};
    response = await fetch(f.base + '/agent/feed', {method: 'POST', headers, body: JSON.stringify({text: '工作进度', idempotency: 'work-1'})});
    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, 'desktop-record');
    response = await fetch(f.base + '/agent/feed', {method: 'POST', headers, body: JSON.stringify({text: '工作进度', idempotency: 'work-1'})});
    assert.equal(response.status, 200); assert.equal(f.core.records.size, 1);
    response = await fetch(f.base + '/agent/search', {method: 'POST', headers, body: JSON.stringify({query: '进度'})});
    assert.equal(response.status, 200); assert.equal((await response.json()).records[0].text, '获准证据');
    response = await fetch(f.base + '/agent/ask', {method: 'POST', headers, body: JSON.stringify({question: '项目进展'})});
    assert.equal(response.status, 200); assert.equal((await response.json()).answer, '项目正在推进');
    response = await fetch(f.base + '/agent/search', {method: 'POST', headers: {...headers, 'X-Knowledge-Scope': 'other-store'}, body: JSON.stringify({query: '进度'})});
    assert.equal(response.status, 403);
    assert.ok(f.core.calls.filter(c => c.path === '/api/v1/records').every(c => c.token === 'desktop-alice' && c.scope === 'store-a'));
  } finally { await f.close(); }
});

test('librarian clients require an explicit identity and scope; reply splitting preserves UTF-8', async () => {
  const calls = [];
  const client = new KnowledgeBase('http://127.0.0.1:5181', {token: '', scope: '', fetchImpl: async (...args) => { calls.push(args); return new Response('[]'); }});
  await assert.rejects(client.records(), error => error.status === 401);
  await assert.rejects(client.withSession('service', '').records(), error => error.status === 400);
  await client.withSession('service', 'department').records();
  assert.equal(calls[0][1].headers.Authorization, 'Bearer service');
  assert.equal(calls[0][1].headers['X-Knowledge-Scope'], 'department');
  const original = '公司🙂进展'.repeat(1000), chunks = splitReply(original);
  assert.equal(chunks.join(''), original); assert.ok(chunks.every(c => Buffer.byteLength(c) <= 1800));
});
