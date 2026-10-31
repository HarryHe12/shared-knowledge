import http from 'node:http';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {WxCrypto, xmlField, textReplyXml, encryptReplyXml} from './wxcrypto.mjs';
import {WeCom} from './wecom.mjs';
import {KnowledgeBase} from './kb.mjs';
import {DurableInbox} from './inbox.mjs';
import {handleAgentApi} from './agent-api.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), {status});
const HELP = '我是团队的知识助手小知 🙌 有啥直接跟我说就行：工作上的进展、决定、想法发给我，我帮你记着；想问什么也直接问，我翻翻大家记过的内容告诉你。暂时只认文字（语音可以先转成文字再发）。';

/** WeCom text messages allow 2048 UTF-8 bytes. Split by code point, with room for framing. */
export function splitReply(value, maxBytes = 1800) {
  const chunks = [];
  let current = '', size = 0;
  for (const char of String(value)) {
    const bytes = Buffer.byteLength(char);
    if (size + bytes > maxBytes && current) { chunks.push(current); current = ''; size = 0; }
    current += char; size += bytes;
  }
  if (current) chunks.push(current);
  return chunks;
}

function listScopes(scopes) {
  return '我现在管着这些范围：\n' + scopes.map((s, i) => `${i + 1}.【${s.name}】${s.role === 'writer' ? '可录入' : '只读'}`).join('\n')
    + '\n想固定在某个范围里聊，发「/范围 完整名称」；平时不用选，我会自动帮你判断存到哪。';
}

function messageIntent(text) {
  const save = /^(?:\/save\s+|(?:记录|录入|保存)\s*[:：]\s*)/i;
  const query = /^(?:\/(?:ask|q)\s+|(?:问|查询)\s*[:：]\s*)/i;
  if (save.test(text)) return {intent: 'save', text: text.replace(save, '').trim()};
  if (query.test(text)) return {intent: 'query', text: text.replace(query, '').trim()};
  return {intent: 'auto', text};
}

function failureText(error) {
  if (error.bindingChanged) return '这条消息进来的时候，你的身份还没绑定好，所以没存进去。确认绑定没问题后，把原文再发我一次就行。';
  if (error.status === 401 || error.status === 403) return '这条没处理成：你的账号还没绑定，或者没有对应范围的权限。找管理员（李任重）开通一下，再发一次就好。';
  if (error.status === 404) return '之前的对话或范围不存在了，麻烦把内容重新发我一次。';
  if (error.status === 400 || error.status === 409) return '这条没处理成：' + error.message + '。核对一下再发我；如果之前收到过保存编号，先查一下别重复存。';
  return '知识库这边暂时没处理完，我先不重试了。麻烦稍后发一句“查一下刚才那条”确认有没有存上，再决定要不要重发。';
}

/** Processes durable jobs; no model, global library token or business decision lives in this adapter. */
export class CollectorWorker {
  constructor({inbox, kb, wecom, appId, bridgeKey, logger = console}) {
    Object.assign(this, {inbox, kb, wecom, appId, bridgeKey, logger});
    this.busy = false;
  }

  async prepare(job, client, scopes) {
    if (job.input) return JSON.parse(job.input);
    const command = /^(?:\/范围|范围)(?:\s+(.*))?$/.exec(job.text.trim());
    if (/^(?:帮助|help|使用说明)$/i.test(job.text.trim())) return {reply: HELP};
    if (command) {
      const selection = command[1]?.trim();
      if (!selection) return {reply: listScopes(scopes)};
      if (selection === '全部') { this.inbox.select(job, null); return {reply: '好的，恢复全部范围。之后录入我会自动判断存到哪里，你不用管。'}; }
      const matches = scopes.filter(s => s.id === selection || s.name === selection);
      if (matches.length !== 1) return {reply: '没太确定你指的是哪个范围，看一下列表用完整名称告诉我：\n' + listScopes(scopes)};
      this.inbox.select(job, matches[0].id);
      return {reply: '好，接下来都围绕【' + matches[0].name + '】。直接把要录入的原文或问题发我就行。'};
    }
    if (/^(?:作废|删除|撤回|撤销)\s*(?:记录)?\s*#/.test(job.text)) return {reply: '撤回记录需要在知识库网页端操作（带上记录编号），我在聊天里不能替你删，免得误删。'};
    const payload = messageIntent(job.text.trim());
    if (!payload.text) return {reply: HELP};
    const selected = this.inbox.preference(job);
    if (selected && !scopes.some(s => s.id === selected)) {
      this.inbox.select(job, null);
      return {reply: '你之前选定的范围现在用不了（可能已停用），本条先没处理。\n' + listScopes(scopes)};
    }
    let chosen = selected ? scopes.filter(s => s.id === selected) : scopes;
    if (payload.intent === 'save') {
      const writers = chosen.filter(s => s.role === 'writer');
      if (!writers.length) return {reply: '你现在没有可录入的范围（都是只读），本条还没保存，请联系管理员开通录入权限。\n' + listScopes(chosen)};
      // 多个可写范围交给知识库自动推导落点，员工无需先选范围。
      chosen = writers;
    }
    if (chosen.length > 40) return {reply: '范围有点多（超过40个），先发「/范围 完整名称」锁定一个，再重发～'};
    if (new Set(chosen.map(s => s.tenant_id)).size > 1) throw fail('一次只能处理一家公司的信息，请先选择范围');
    const scopeIds = chosen.map(s => s.id).sort();
    let conversation = this.inbox.conversation(job, scopeIds);
    if (!conversation) {
      conversation = (await client.conversation(scopeIds)).id;
      if (!conversation) throw fail('知识库未返回对话编号', 502);
      this.inbox.rememberConversation(job, scopeIds, conversation);
    }
    const input = {scope_ids: scopeIds, conversation_id: conversation, message: {...payload,
      occurred_at: job.occurred_at, idempotency_key: job.id}};
    // Freeze the conversation and payload before the request: retries cannot move a save.
    this.inbox.setInput(job, input);
    return input;
  }

  async deliver(job, text, check) {
    const output = this.inbox.setOutput(job, splitReply(text));
    const chunks = JSON.parse(output.output);
    for (let i = output.sent_count; i < chunks.length; i++) {
      this.inbox.assertLease(job);
      await check?.();
      this.inbox.heartbeat(job);
      await this.wecom.sendText(job.external_id, chunks[i]);
      this.inbox.sent(job, i + 1);
    }
  }

  async runOnce() {
    if (this.busy) return false;
    this.busy = true;
    let job, client;
    try {
      job = this.inbox.claim();
      if (!job) return false;
      if (job.app_id !== this.appId) throw fail('消息所属应用配置已变化', 403);
      const session = await this.kb.bridge(job.app_id, this.bridgeKey, job.external_id);
      client = session.client;
      const verifiedAt = Date.parse(session.identity_verified_at), occurredAt = Date.parse(job.occurred_at);
      if (!Number.isFinite(verifiedAt) || !Number.isFinite(occurredAt) || occurredAt <= verifiedAt) {
        throw Object.assign(fail('员工绑定时间无法确认或晚于本条消息，请确认身份后重新发送', 403), {bindingChanged: true});
      }
      this.inbox.bind(job, session.user.id);
      const profile = await client.me();
      this.inbox.heartbeat(job);
      const scopes = (profile.scopes ?? []).filter(s => s.tenant_id && ['reader', 'writer'].includes(s.role));
      if (!scopes.length) throw fail('员工还没有可访问的公司范围', 403);
      const prepared = await this.prepare(job, client, scopes);
      let requestId;
      const check = async () => {
        const current = await client.me();
        this.inbox.heartbeat(job);
        const required = prepared.scope_ids ?? scopes.map(scope => scope.id);
        if (current.user?.id !== job.user_id || required.some(id => !(current.scopes ?? []).some(s => s.id === id))) {
          throw fail('当前范围权限已经变化', 403);
        }
        if (requestId) {
          const currentResult = await client.request('v1/conversations/' + encodeURIComponent(prepared.conversation_id)
            + '/requests/' + encodeURIComponent(requestId));
          if (currentResult.status !== 'completed' || !currentResult.result || currentResult.result.kind === 'stale') {
            throw fail('来源或权限发生变化，请重新查询当前结果', 409);
          }
        }
      };
      let reply = prepared.reply;
      if (!reply) {
        await check();
        // Core idempotency also refreshes stale results and rechecks live permissions on retries.
        const response = await client.message(prepared.conversation_id, prepared.message);
        this.inbox.heartbeat(job);
        if (response.status !== 'completed' || !response.result?.answer || typeof response.request_id !== 'string') throw fail('知识助手仍在处理', 503);
        requestId = response.request_id;
        reply = response.result.answer;
        if (response.result.kind === 'needs_clarification' && response.result.clarification?.scope_ids?.length) {
          const names = response.result.clarification.scope_ids
            .map(id => scopes.find(scope => scope.id === id)?.name).filter(Boolean);
          if (names.length) reply += '\n可以选：' + names.map(name => '【' + name + '】').join('、');
        }
        // 来源由回答本身自然带出（“小李 10 月 28 日说的”），不再在末尾追加一行来源列表。
      }
      await this.deliver(job, reply, check);
      this.inbox.finish(job);
      return true;
    } catch (error) {
      if (!job) throw error;
      if (error.leaseLost) return true;
      const terminal = [400, 401, 403, 404, 409].includes(error.status) || job.attempts >= this.inbox.maxAttempts;
      if (terminal) {
        try {
          await this.deliver(job, failureText(error));
          this.inbox.finish(job, true, String(error.status ?? 503));
        } catch {
          this.inbox.retry(job, '答复推送暂时失败');
        }
      } else this.inbox.retry(job, String(error.status ?? 503));
      this.logger.error?.('[collector] job retry/dead', job.id, error.status ?? 503);
      return true;
    } finally {
      // No employee bearer is persisted in the collector database or logs.
      if (client) await client.logout().catch(() => {});
      this.busy = false;
    }
  }
}

async function bodyOf(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw fail('请求体过大', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createCollector({env = process.env, fetchImpl = fetch, wecom, inbox, wxCrypto, logger = console,
  defaultInboxPath = fileURLToPath(new URL('../.data/inbox.sqlite', import.meta.url))} = {}) {
  const concurrency = Number(env.COLLECTOR_CONCURRENCY ?? 4);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('COLLECTOR_CONCURRENCY 须为1—8');
  const configuredDb = env.COLLECTOR_DB;
  if (configuredDb && (typeof configuredDb !== 'string' || !configuredDb.trim() || configuredDb === ':memory:' || /^file:/i.test(configuredDb) || configuredDb.includes('\0'))) {
    throw new Error('COLLECTOR_DB 须为持久化 SQLite 文件路径');
  }
  const configured = Boolean(env.WECOM_TOKEN && env.WECOM_ENCODING_AES_KEY && env.WECOM_CORP_ID);
  const crypto = wxCrypto ?? (configured ? new WxCrypto(env.WECOM_TOKEN, env.WECOM_ENCODING_AES_KEY, env.WECOM_CORP_ID) : null);
  wecom ??= new WeCom(env.WECOM_CORP_ID, env.WECOM_SECRET, env.WECOM_AGENT_ID);
  inbox ??= new DurableInbox(configuredDb || defaultInboxPath, {maxAttempts: Number(env.COLLECTOR_MAX_ATTEMPTS ?? 5)});
  const kb = new KnowledgeBase(env.KB_URL, {token: env.KB_SERVICE_TOKEN, scope: env.KB_SERVICE_SCOPE, fetchImpl});
  const appId = env.KB_CHANNEL_APP_ID, bridgeKey = env.KB_CHANNEL_BRIDGE_KEY;
  const workers = Array.from({length: concurrency}, () => new CollectorWorker({inbox, kb, wecom, appId, bridgeKey, logger}));
  const worker = workers[0];
  let timer;
  const server = http.createServer(async (req, res) => {
    const respond = (status, body, type = 'text/plain; charset=utf-8') => { res.writeHead(status, {'Content-Type': type, 'Cache-Control': 'no-store'}); res.end(body); };
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (await handleAgentApi(req, res, url.pathname, kb, undefined, {agentKeys: env.AGENT_API_KEYS})) return;
      if (url.pathname !== '/wecom/callback') return respond(404, 'not found');
      if (!crypto) return respond(503, '企业微信回调凭据尚未配置');
      const q = url.searchParams;
      const timestamp = q.get('timestamp') ?? '', nonce = q.get('nonce') ?? '', signature = q.get('msg_signature') ?? '';
      if (req.method === 'GET') {
        const echostr = q.get('echostr') ?? '';
        if (!crypto.verify(timestamp, nonce, echostr, signature)) return respond(403, 'signature mismatch');
        const decoded = crypto.decrypt(echostr);
        if (decoded.receiveId !== env.WECOM_CORP_ID) return respond(403, 'corporation mismatch');
        return respond(200, decoded.message);
      }
      if (req.method !== 'POST') return respond(405, 'method not allowed');
      const encrypted = xmlField(await bodyOf(req), 'Encrypt') ?? '';
      if (!crypto.verify(timestamp, nonce, encrypted, signature)) return respond(403, 'signature mismatch');
      const {message, receiveId} = crypto.decrypt(encrypted);
      if (receiveId !== env.WECOM_CORP_ID || xmlField(message, 'ToUserName') !== env.WECOM_CORP_ID ||
        xmlField(message, 'AgentID') && xmlField(message, 'AgentID') !== String(env.WECOM_AGENT_ID)) return respond(403, 'application mismatch');
      const userId = xmlField(message, 'FromUserName');
      if (!userId || userId.length > 256 || userId === '@all' || userId.includes('|')) return respond(400, 'invalid employee');
      const reply = text => respond(200, encryptReplyXml(crypto, textReplyXml(userId, env.WECOM_CORP_ID, text)), 'application/xml; charset=utf-8');
      const type = xmlField(message, 'MsgType');
      if (type === 'event') return respond(200, 'success');
      if (['text', 'voice'].includes(type) && xmlField(message, 'AgentID') !== String(env.WECOM_AGENT_ID)) return respond(403, 'missing application identity');
      if (!appId || !bridgeKey || bridgeKey.length < 24 || !wecom.configured) return reply('知识库员工身份桥接或答复推送尚未配置，本条尚未入库，请联系管理员完成接入。');
      const text = type === 'text' ? xmlField(message, 'Content') : type === 'voice' ? xmlField(message, 'Recognition') : null;
      if (!text?.trim()) return reply(type === 'voice' ? '语音未识别出文字，本条尚未入库，请重发文字。' : '目前仅支持文字和已转写的语音，本条附件尚未入库。');
      const msgId = xmlField(message, 'MsgId'), seconds = Number(xmlField(message, 'CreateTime'));
      if (!msgId || !Number.isFinite(seconds) || seconds <= 0) return respond(400, 'missing message identity');
      const occurredAt = new Date(seconds * 1000).toISOString();
      const job = inbox.enqueue({appId, externalId: userId, msgId, text: text.trim(), occurredAt});
      // 新消息不再先回一句“已进入队列”的机器腔回执：空响应表示已收到，真正的回答稍后推送。
      if (job.status !== 'done' && job.status !== 'dead') return respond(200, '');
      return reply(job.status === 'done' ? '这条我已经回过你啦，往上翻翻看～'
        : '这条之前没处理成功，我这边先不重试了，麻烦把内容再发我一次。');
    } catch (error) {
      logger.error?.('[collector] callback failed', error.status ?? 503);
      if (!res.headersSent) respond(error.status ?? 503, error.status ? error.message : '消息未确认接收，请稍后重试');
    }
  });
  const startWorker = () => {
    if (timer) return;
    timer = setInterval(() => {
      for (const item of workers) item.runOnce().catch(error => logger.error?.('[collector] worker unavailable', error.status ?? 503));
    }, 500);
    timer.unref();
  };
  const close = async () => {
    clearInterval(timer); timer = null;
    if (server.listening) await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
    while (workers.some(item => item.busy)) await new Promise(done => setTimeout(done, 20));
    inbox.close();
  };
  return {server, worker, workers, inbox, startWorker, close};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createCollector();
  app.server.listen(Number(process.env.COLLECTOR_PORT ?? 9100), process.env.COLLECTOR_HOST ?? '127.0.0.1', () => {
    app.startWorker();
    console.log('[collector] durable employee-channel adapter listening');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0)).catch(() => process.exit(1)));
}
