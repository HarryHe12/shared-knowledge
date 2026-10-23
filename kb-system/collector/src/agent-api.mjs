// Agent API：给其他 Agent（WorkBuddy、Codex 等）调用的 HTTP 接口。
//
// 端点（全部走 HTTPS，由 nginx 转发 /agent/ 到本服务）：
//   GET  /agent/ping   —— 连通性自检，返回调用方名字
//   POST /agent/feed   —— 投喂：{text, occurredAt?, idempotency?} → 入库并返回记录 id
//   POST /agent/ask    —— 提问：{question} → 返回整理好的自然语言答案
//   POST /agent/search —— 检索：{query, limit?} → 返回原始记录列表（Agent 自己组织答案用）
//
// 鉴权：请求头 Authorization: Bearer <token>。
// token → 调用方名字的映射配置在环境变量 AGENT_API_KEYS，格式：workbuddy:tokenA,codex:tokenB
import {createHash, timingSafeEqual} from 'node:crypto';
import {answerQuestion} from '../../librarian/scripts/answer.mjs';

/** 解析 AGENT_API_KEYS 为 token → 名字 的映射。 */
function parseKeys() {
  const map = new Map();
  for (const pair of String(process.env.AGENT_API_KEYS ?? '').split(',')) {
    const idx = pair.indexOf(':');
    if (idx < 1) continue;
    const name = pair.slice(0, idx).trim();
    const token = pair.slice(idx + 1).trim();
    if (name && token) map.set(token, name);
  }
  return map;
}

/** 常量时间比对 token，防时序侧信道。 */
function lookupName(token, keys) {
  const a = Buffer.from(String(token ?? ''));
  for (const [t, name] of keys) {
    const b = Buffer.from(t);
    if (a.length === b.length && timingSafeEqual(a, b)) return name;
  }
  return null;
}

function normalizeHits(res) {
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res.records)) return res.records;
  if (res && Array.isArray(res.results)) return res.results;
  if (res && Array.isArray(res.data)) return res.data;
  return [];
}

/**
 * 处理 /agent/ 下的请求。
 * @returns {Promise<boolean>} true 表示已处理（响应已发出）
 */
export async function handleAgentApi(req, res, pathname, kb, llm) {
  if (!pathname.startsWith('/agent/')) return false;

  const send = (code, obj) => {
    res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8'});
    res.end(JSON.stringify(obj));
  };

  // 鉴权
  const keys = parseKeys();
  const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const name = lookupName(token, keys);
  if (!name) {
    send(401, {error: '未授权：请在请求头带 Authorization: Bearer <Agent API Key>'});
    return true;
  }

  // 解析请求体（POST）
  let body = {};
  if (req.method === 'POST') {
    const chunks = [];
    let size = 0;
    try {
      for await (const c of req) {
        size += c.length;
        if (size > 256 * 1024) throw new Error('请求体超过 256KB 上限');
        chunks.push(c);
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw) body = JSON.parse(raw);
    } catch (err) {
      send(400, {error: '请求体不是合法 JSON 或超出限制：' + err.message});
      return true;
    }
  }

  console.log('[agent-api]', name, req.method, pathname);

  try {
    if (req.method === 'GET' && pathname === '/agent/ping') {
      send(200, {ok: true, agent: name, endpoints: ['/agent/feed', '/agent/ask', '/agent/search']});
      return true;
    }

    if (req.method === 'POST' && pathname === '/agent/feed') {
      const text = String(body.text ?? '').trim();
      if (!text) { send(400, {error: '缺少 text 字段'}); return true; }
      if (text.length > 20000) { send(400, {error: '单条最多 20000 字符'}); return true; }
      const idem = body.idempotency
        ? `agent:${name}:${String(body.idempotency).slice(0, 100)}`
        : `agent:${name}:${createHash('sha256').update(text + Date.now()).digest('hex').slice(0, 16)}`;
      const rec = await kb.save({
        text: `【作者:${name}】【来源:AgentAPI】${text}`,
        idempotency: idem,
        occurredAt: body.occurredAt,
      });
      send(200, {ok: true, id: rec.id, shortId: String(rec.id).slice(0, 8), receipt: `已收录 #${String(rec.id).slice(0, 8)} ✅`});
      return true;
    }

    if (req.method === 'POST' && pathname === '/agent/ask') {
      const question = String(body.question ?? '').trim();
      if (!question) { send(400, {error: '缺少 question 字段'}); return true; }
      const answer = await answerQuestion(kb, llm, question);
      send(200, {ok: true, question, answer});
      return true;
    }

    if (req.method === 'POST' && pathname === '/agent/search') {
      const query = String(body.query ?? '').trim();
      if (!query) { send(400, {error: '缺少 query 字段'}); return true; }
      const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 30);
      const hits = normalizeHits(await kb.search(query, {limit})).map((r) => ({
        id: r.id,
        occurred_at: r.occurred_at,
        text: r.text,
      }));
      send(200, {ok: true, count: hits.length, records: hits});
      return true;
    }

    send(404, {error: '未找到接口。可用：GET /agent/ping、POST /agent/feed、POST /agent/ask、POST /agent/search'});
    return true;
  } catch (err) {
    console.error('[agent-api] 处理失败：', err);
    send(500, {error: '处理失败：' + (err?.message ?? '未知错误')});
    return true;
  }
}
