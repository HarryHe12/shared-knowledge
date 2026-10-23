// team-app 知识库内核的 HTTP 客户端（协调者提供的共享模块，只读使用）。
export class KnowledgeBase {
  constructor(baseUrl = 'http://127.0.0.1:5181') {
    this.base = (baseUrl ?? process.env.KB_URL ?? 'http://127.0.0.1:5181').replace(/\/$/, '');
  }

  async request(path, body) {
    const r = await fetch(this.base + '/api/' + path, {
      method: body ? 'POST' : 'GET',
      headers: {'Content-Type': 'application/json'},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000),
    });
    const data = await r.json();
    if (!r.ok) throw new Error('知识库 ' + path + ' 失败：' + (data.error ?? r.status));
    return data;
  }

  save({text, idempotency, occurredAt}) {
    return this.request('records', {
      text,
      changes: [],
      ...(idempotency ? {idempotency} : {}),
      ...(occurredAt ? {occurred_at: occurredAt} : {}),
    });
  }

  search(query, {limit = 15, depth = 1, strategy} = {}) {
    return this.request('search', {query, limit, depth, ...(strategy ? {strategy} : {})});
  }

  getRecords(ids) { return this.request('get-records', {ids}); }
  records() { return this.request('records'); }
  state() { return this.request('state'); }
}
