import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {parseModelChain, runModelChain} from '../src/intelligence.mjs';
import {Store} from '../src/store.mjs';
import {Auth} from '../src/auth.mjs';
import {createKnowledgeServer} from '../src/http.mjs';
import {run as runCli} from '../scripts/knowledge.mjs';

test('parseModelChain parses ordered provider/model pairs and falls back to TEAM_PROVIDER/TEAM_MODEL', () => {
  assert.deepEqual(parseModelChain({}), [{provider: 'kimi-coding', model: 'k3'}]);
  assert.deepEqual(parseModelChain({TEAM_PROVIDER: 'deepseek', TEAM_MODEL: 'deepseek-v4-flash'}), [
    {provider: 'deepseek', model: 'deepseek-v4-flash'},
  ]);
  assert.deepEqual(
    parseModelChain({
      TEAM_MODEL_CHAIN: ' minimax-plan/MiniMax-M3.1-Flash , mimo-plan/mimo-v2.6-flash , deepseek/deepseek-v4-flash ',
      TEAM_PROVIDER: 'ignored',
      TEAM_MODEL: 'ignored',
    }),
    [
      {provider: 'minimax-plan', model: 'MiniMax-M3.1-Flash'},
      {provider: 'mimo-plan', model: 'mimo-v2.6-flash'},
      {provider: 'deepseek', model: 'deepseek-v4-flash'},
    ],
  );
  assert.throws(() => parseModelChain({TEAM_MODEL_CHAIN: 'missing-slash'}), /无效模型链配置/);
  assert.throws(() => parseModelChain({TEAM_MODEL_CHAIN: 'provider/'}), /无效模型链配置/);
});

test('runModelChain falls through failed or empty providers to the backup model', async () => {
  const chain = [
    {provider: 'minimax-plan', model: 'MiniMax-M3.1-Flash'},
    {provider: 'mimo-plan', model: 'mimo-v2.6-flash'},
    {provider: 'deepseek', model: 'deepseek-v4-flash'},
  ];
  const warnings = [];
  const logger = {warn: msg => warnings.push(msg)};

  // Primary succeeds immediately
  let calls = [];
  const primaryOut = await runModelChain(chain, async (item, isLast) => {
    calls.push({item, isLast});
    return '主模型直接回复';
  }, logger);
  assert.equal(primaryOut, '主模型直接回复');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].isLast, false);
  assert.equal(warnings.length, 0);

  // Primary throws, secondary returns empty, tertiary DeepSeek succeeds
  calls = [];
  const fallbackOut = await runModelChain(chain, async (item, isLast) => {
    calls.push({id: `${item.provider}/${item.model}`, isLast});
    if (item.provider === 'minimax-plan') throw new Error('quota exhausted');
    if (item.provider === 'mimo-plan') return '   ';
    return '保底DeepSeek回复';
  }, logger);
  assert.equal(fallbackOut, '保底DeepSeek回复');
  assert.deepEqual(calls, [
    {id: 'minimax-plan/MiniMax-M3.1-Flash', isLast: false},
    {id: 'mimo-plan/mimo-v2.6-flash', isLast: false},
    {id: 'deepseek/deepseek-v4-flash', isLast: true},
  ]);
  assert.equal(warnings.length, 2);

  // All fail -> rethrows last error
  await assert.rejects(
    runModelChain(chain, async item => { throw new Error('down:' + item.provider); }, {warn() {}}),
    /down:deepseek/,
  );
});

test('CLI login --wait, auto-scope, chat-save --text idempotency, search-all and save --text work end-to-end', async t => {
  const store = new Store(':memory:'), project = store.defaultProject(), auth = new Auth(store, project);
  const org = auth.organization;
  const password = 'cli-test-password-12345';
  const ownerId = (await auth.register({name: '测试负责人', email: 'owner@example.test', department: '总部', reason: '管理', password}, true)).id;
  const ownerLogin = await auth.login({email: 'owner@example.test', password});
  const ownerUser = auth.user(ownerLogin.token);

  const company = org.manage(ownerUser, {action: 'tenant', name: '测试主公司'});
  const secondCompany = org.manage(ownerUser, {action: 'tenant', name: '测试副公司'});
  org.manage(ownerUser, {action: 'member', tenant_id: company.id, user_id: ownerId, role: 'owner'});
  org.manage(ownerUser, {action: 'member', tenant_id: secondCompany.id, user_id: ownerId, role: 'owner'});
  const brand = org.manage(ownerUser, {action: 'brand', tenant_id: company.id, name: '测试品牌'});
  const store1 = org.manage(ownerUser, {action: 'store', tenant_id: company.id, brand_id: brand.id, name: '一店'});
  const store2 = org.manage(ownerUser, {action: 'store', tenant_id: company.id, brand_id: brand.id, name: '二店'});
  const execScope = org.manage(ownerUser, {action: 'scope', tenant_id: company.id, name: '负责人机密', level: 'executive'});
  const publicScope = org.manage(ownerUser, {action: 'scope', tenant_id: company.id, name: '团队公共', level: 'staff'});
  const hsScope = org.manage(ownerUser, {action: 'scope', tenant_id: company.id, brand_id: brand.id, store_id: store1.id, name: '一店员工', level: 'staff'});
  const syScope = org.manage(ownerUser, {action: 'scope', tenant_id: company.id, brand_id: brand.id, store_id: store2.id, name: '二店员工', level: 'staff'});
  org.manage(ownerUser, {action: 'scope', tenant_id: secondCompany.id, name: '副公司资料', level: 'staff'});

  const server = createKnowledgeServer(store, async () => '{"intent":"save","reply":"收到👌"}', project);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(r => server.close(r)); store.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;

  const vault = new Map();
  let savedProfile = {};
  const logs = [];
  let pollTicks = 0;

  const deps = {
    platform: 'darwin',
    credential: async (key, value) => {
      if (value === null) { vault.delete(key); return ''; }
      if (value !== undefined) { vault.set(key, value); return value; }
      return vault.get(key) ?? '';
    },
    profile: async () => ({...savedProfile}),
    saveProfile: async next => { savedProfile = {...next}; },
    sleep: async () => {
      pollTicks++;
      if (pollTicks === 1) {
        // Simulate user clicking confirm in the browser during --wait polling
        const promptLine = logs.find(line => line.includes('?code='));
        const code = new URL(promptLine.match(/http:\/\/[^\s]+/)[0]).searchParams.get('code');
        auth.bind(ownerUser, code);
      }
    },
    log: msg => logs.push(msg),
  };

  // 1. login --wait polls, claims token, and picks a non-executive company scope automatically
  await runCli(['login', '--url', base, '--wait'], {}, deps);
  assert.ok(vault.get('shared-knowledge:' + base));
  assert.equal(vault.get('shared-knowledge:' + base + ':pending'), undefined);
  assert.notEqual(savedProfile.scope, execScope.id);
  assert.ok([publicScope.id, hsScope.id, syScope.id].includes(savedProfile.scope));

  // 2. chat-save --text auto-routes by store keyword ("二店") and is idempotent on retry
  const firstSave = await runCli(
    ['chat-save', '--text', '二店冷柜今天换了压缩机，花费1800元', '--idempotency', 'agent-save-test-1'],
    {},
    deps,
  );
  assert.equal(firstSave.status, 'completed');
  assert.equal(firstSave.result.kind, 'saved');
  assert.equal(firstSave.result.record.scope_id, syScope.id);
  const convIdAfterFirst = savedProfile.agent_conversation_id;
  assert.ok(convIdAfterFirst);

  const retrySave = await runCli(
    ['chat-save', '--text', '二店冷柜今天换了压缩机，花费1800元', '--idempotency', 'agent-save-test-1'],
    {},
    deps,
  );
  assert.equal(retrySave.result.record.id, firstSave.result.record.id);
  assert.equal(savedProfile.agent_conversation_id, convIdAfterFirst);

  // 3. save --text writes to default scope, and correct --text updates it
  const direct = await runCli(['save', '--text', '一店晚班排班表已确认', '--scope', hsScope.id, '--idempotency', 'direct-1'], {}, deps);
  assert.equal(direct.text, '一店晚班排班表已确认');
  const corrected = await runCli(['correct', '--id', direct.id, '--version', '1', '--scope', hsScope.id, '--text', '一店晚班排班表已确认（含周末）'], {}, deps);
  assert.equal(corrected.version, 2);

  // 4. search-all searches across all authorized scopes of the active company (without mixing secondCompany)
  const searchAll = await runCli(['search-all', '--query', '压缩机'], {}, deps);
  assert.ok(searchAll.coverage.scope_ids.includes(syScope.id));
  assert.ok(searchAll.coverage.scope_ids.includes(hsScope.id));
  const hitRecords = searchAll.results.flatMap(r => r.records);
  assert.ok(hitRecords.some(r => r.id === firstSave.result.record.id));

  // 5. chat message with 16-hex device code binds device directly without browser
  const devReq = auth.start();
  const bindResp = await runCli(
    ['chat-save', '--text', devReq.code, '--idempotency', 'device-bind-test-1'],
    {},
    deps,
  );
  assert.equal(bindResp.status, 'completed');
  assert.equal(bindResp.result.kind, 'chat');
  assert.match(bindResp.result.answer, /已成功绑定/);
  const polled = auth.poll(devReq.device_token);
  assert.equal(polled.status, 'approved');
  assert.ok(polled.token);

  // 6. auth.login accepts bound external_id in place of email
  store.db.prepare('INSERT INTO channel_apps(id,name,channel,tenant_id,enabled) VALUES(?,?,?,?,1)')
    .run('test-app', 'test-app', 'wecom', company.id);
  store.db.prepare('INSERT INTO channel_bindings(app_id,external_id,user_id,active,verified_by,verified_at) VALUES(?,?,?,1,?,?)')
    .run('test-app', 'test_user_alias', ownerId, ownerId, new Date().toISOString());
  const extLogin = await auth.login({email: 'test_user_alias', password});
  assert.ok(extLogin.token);
});
