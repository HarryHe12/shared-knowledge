import http from 'node:http';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {WxCrypto, xmlField, textReplyXml, encryptReplyXml} from './wxcrypto.mjs';
import {WeCom} from './wecom.mjs';
import {KnowledgeBase} from './kb.mjs';
import {DurableInbox} from './inbox.mjs';
import {handleAgentApi} from './agent-api.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), {status});
const HELP = '可以直接对话，或用“记录：工作进展”“问：项目进展”明确操作。发送“范围”查看可访问范围，发送“/范围 范围编号或完整名称”选择范围，“/范围 全部”恢复公司内汇总查询。多个可写范围时，请先选范围再重发要保存的原文。语音需要开启企微语音转文字；图片和附件请先整理成文字。';

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
  return '可访问的知识范围：\n' + scopes.map(s => `${s.name}（${s.role === 'writer' ? '可录入' : '只读'}）\n/范围 ${s.id}`).join('\n')
    + '\n请选择完整名称或编号；选定前，多个可写范围的记录不会自动保存。';
}

function messageIntent(text) {
  const save = /^(?:\/save\s+|(?:记录|录入|保存)\s*[:：]\s*)/i;
  const query = /^(?:\/(?:ask|q)\s+|(?:问|查询)\s*[:：]\s*)/i;
  if (save.test(text)) return {intent: 'save', text: text.replace(save, '').trim()};
  if (query.test(text)) return {intent: 'query', text: text.replace(query, '').trim()};
  return {intent: 'auto', text};
}

function failureText(error) {
  if (error.bindingChanged) return '员工身份绑定晚于或与这条消息同时发生，本条没有写入知识库。请确认当前员工绑定正确后，重新发送原文。';
  if (error.status === 401 || error.status === 403) return '当前员工身份未绑定、已停用或没有所需范围权限。本条消息未能确认处理，请联系本公司管理员核对绑定与授权。';
  if (error.status === 404) return '原对话或范围已不可用，请联系管理员核对；本次没有确认保存。';
  if (error.status === 400 || error.status === 409) return '本次未能确认处理：' + error.message + '。请核对后重新发送；如曾收到保存编号，请先查该编号以免重复。';
  return '知识库暂时无法确认处理结果，已停止自动重试。请稍后先查询是否已有本条记录，再决定是否重发。';
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
      if (selection === '全部') { this.inbox.select(job, null); return {reply: '已恢复在本公司获准范围内查询。录入时仍需明确一个保存范围。'}; }
      const matches = scopes.filter(s => s.id === selection || s.name === selection);
      if (matches.length !== 1) return {reply: '没有唯一匹配的获准范围，请使用完整编号。\n' + listScopes(scopes)};
      this.inbox.select(job, matches[0].id);
      return {reply: '当前范围已选择：' + matches[0].name + '。请发送要录入的原文或问题；此前需要选范围的消息尚未保存。'};
    }
    if (/^(?:作废|删除|撤回|撤销)\s*(?:记录)?\s*#/.test(job.text)) return {reply: '撤回或更正请通过已登录的知识库客户端操作，携带记录编号与当前版本；聊天中本次没有执行删除。'};
    const payload = messageIntent(job.text.trim());
    if (!payload.text) return {reply: HELP};
    const selected = this.inbox.preference(job);
    if (selected && !scopes.some(s => s.id === selected)) {
      this.inbox.select(job, null);
      return {reply: '之前选定的范围已不可用，本条尚未处理。\n' + listScopes(scopes)};
    }
    let chosen = selected ? scopes.filter(s => s.id === selected) : scopes;
    if (payload.intent === 'save') {
      const writers = chosen.filter(s => s.role === 'writer');
      if (writers.length !== 1) return {reply: '这条原文尚未保存，请先选择一个可录入范围，再重发原文。\n' + listScopes(chosen)};
      chosen = writers;
    }
    if (chosen.length > 40) return {reply: '可查询范围超过40个，请先发送“/范围 完整范围编号”缩小范围，再重发。'};
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
        if (response.result.kind === 'needs_clarification' && response.result.clarification?.scope_ids) reply += '\n' + listScopes(scopes);
        const citations = (response.result.citations ?? []).filter(item => item?.id);
        if (response.result.kind !== 'saved' && citations.length) reply += '\n来源：' + citations.map(c => '#' + c.id.slice(0, 8)).join('、');
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
      // This response confirms durable receipt, never an unverified save.
      return reply(job.status === 'done' ? '这条消息已处理，请查看此前答复。' : job.status === 'dead'
        ? '这条消息之前未能确认处理，请联系管理员核对后再发送。' : '已收到并进入处理队列，完成后会另发结果；这条回执尚不表示已入库。');
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
