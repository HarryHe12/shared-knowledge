import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';

const fail = (message, status = 400) => Object.assign(new Error(message), {status});
const digest = value => createHash('sha256').update(value).digest();

function gatewayName(value, configuration) {
  const pairs = String(configuration ?? '').split(',').flatMap(pair => {
    const index = pair.indexOf(':');
    return index > 0 && pair.slice(index + 1).trim() ? [[pair.slice(0, index).trim(), pair.slice(index + 1).trim()]] : [];
  });
  if (!pairs.length) return 'employee-agent';
  for (const [name, token] of pairs) if (timingSafeEqual(digest(String(value ?? '')), digest(token))) return name;
  throw fail('接入网关需要有效的 X-Agent-Key；员工身份仍须使用 Authorization Bearer', 401);
}

function requiredText(value, label, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw fail(label + '须为1—' + limit + '字符');
  return value.trim();
}

/** Existing tool routes remain, but an application API key can never substitute for an employee. */
export async function handleAgentApi(req, res, pathname, kb, _llm, {agentKeys = process.env.AGENT_API_KEYS} = {}) {
  if (!pathname.startsWith('/agent/')) return false;
  const send = (status, data) => { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(data)); };
  try {
    const token = /^Bearer\s+([^\s]+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!token) throw fail('请使用获准员工登录后的 Authorization: Bearer 会话', 401);
    const name = gatewayName(req.headers['x-agent-key'], agentKeys);
    const scope = req.headers['x-knowledge-scope'];
    const client = kb.withSession(token, scope);
    const profile = await client.me();
    if (req.method === 'GET' && pathname === '/agent/ping') {
      send(200, {ok: true, agent: name, user: profile.user, scopes: profile.scopes,
        endpoints: ['/agent/feed', '/agent/ask', '/agent/search']});
      return true;
    }
    if (req.method !== 'POST' || !['/agent/feed', '/agent/ask', '/agent/search'].includes(pathname)) throw fail('未找到接口', 404);
    if (typeof scope !== 'string' || !scope || !profile.scopes?.some(s => s.id === scope)) throw fail('请在 X-Knowledge-Scope 选择获准范围', 403);
    let size = 0; const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 100000) throw fail('请求体过大', 413);
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { throw fail('请求体须为有效 JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('请求体须为对象');
    if (pathname === '/agent/feed') {
      const text = requiredText(body.text, 'text', 20000);
      const key = requiredText(body.idempotency ?? req.headers['idempotency-key'], 'idempotency（重试时复用）', 100);
      const record = await client.request('v1/records', {scope_id: scope, text, changes: [],
        idempotency_key: 'agent:' + key, ...(body.occurredAt ? {occurred_at: body.occurredAt} : {})});
      send(200, {ok: true, id: record.id, shortId: String(record.id).slice(0, 8), receipt: '已收录 #' + String(record.id).slice(0, 8)});
    } else if (pathname === '/agent/ask') {
      const question = requiredText(body.question, 'question', 2000);
      const conversation = await client.conversation([scope]);
      const response = await client.message(conversation.id, {text: question, intent: 'query', idempotency_key: 'agent-query:' + randomUUID()});
      if (response.status !== 'completed' || !response.result?.answer) throw fail('知识助手仍在处理，请稍后查询', 503);
      send(200, {ok: true, question, answer: response.result.answer, citations: response.result.citations ?? [],
        coverage: response.result.coverage, conversation_id: conversation.id});
    } else {
      const query = requiredText(body.query, 'query', 2000);
      const limit = body.limit ?? 10;
      if (!Number.isInteger(limit) || limit < 1 || limit > 30) throw fail('limit 须为1—30');
      const response = await client.request('v1/search', {scope_id: scope, query, limit});
      const records = (response.results ?? []).flatMap(result => result.records ?? []);
      send(200, {ok: true, count: records.length, records, coverage: response.coverage});
    }
  } catch (error) { send(error.status ?? 503, {error: error.status ? error.message : '知识库暂时不可用'}); }
  return true;
}
