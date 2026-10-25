// HTTP credentials always identify an approved employee/service account. No anonymous fallback.
export class KnowledgeBase {
  constructor(baseUrl, {token = process.env.KB_SERVICE_TOKEN, scope = process.env.KB_SERVICE_SCOPE, fetchImpl = fetch} = {}) {
    this.base = (baseUrl ?? process.env.KB_URL ?? 'http://127.0.0.1:5181').replace(/\/$/, '');
    const url = new URL(this.base);
    if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new Error('KB_URL 须为 HTTPS 或本机 HTTP 地址');
    }
    this.token = token;
    this.scope = scope;
    this.fetch = fetchImpl;
  }

  withSession(token, scope) {
    return new KnowledgeBase(this.base, {token, scope, fetchImpl: this.fetch});
  }

  async request(path, body, {method = body === undefined ? 'GET' : 'POST', token = this.token, scope = this.scope} = {}) {
    if (typeof token !== 'string' || !token) throw Object.assign(new Error('请配置或登录获准使用的员工身份'), {status: 401});
    if (!path.startsWith('v1/') && !scope) throw Object.assign(new Error('请选择知识范围'), {status: 400});
    let response, data;
    try {
      response = await this.fetch(this.base + '/api/' + path, {
        method, redirect: 'error',
        headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(scope ? {'X-Knowledge-Scope': scope} : {})},
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000),
      });
      data = await response.json();
    } catch {
      throw Object.assign(new Error('知识库服务暂时不可用，请稍后重试'), {status: 503});
    }
    if (!response.ok) throw Object.assign(new Error(data.error ?? '知识库请求失败'), {status: response.status});
    return data;
  }

  async bridge(appId, bridgeKey, externalId) {
    if (!appId || !bridgeKey || bridgeKey.length < 24) throw Object.assign(new Error('企业微信员工身份桥接尚未配置'), {status: 503});
    const session = await this.request('v1/channels/' + encodeURIComponent(appId) + '/bridge', {external_id: externalId}, {token: bridgeKey});
    if (typeof session.token !== 'string' || !session.user?.id) throw Object.assign(new Error('员工登录响应无效'), {status: 502});
    return {client: this.withSession(session.token), user: session.user, identity_verified_at: session.identity_verified_at};
  }

  me() { return this.request('v1/me'); }
  conversation(scopeIds) { return this.request('v1/conversations', {scope_ids: scopeIds, title: '企业微信工作对话'}); }
  message(id, input) { return this.request('v1/conversations/' + encodeURIComponent(id) + '/messages', input); }
  logout() { return this.request('v1/logout', {}); }

  save({text, idempotency, occurredAt}) {
    return this.request('records', {text, changes: [], ...(idempotency ? {idempotency} : {}), ...(occurredAt ? {occurred_at: occurredAt} : {})});
  }
  search(query, {limit = 15, depth = 1, strategy} = {}) {
    return this.request('search', {query, limit, depth, ...(strategy ? {strategy} : {})});
  }
  getRecords(ids) { return this.request('get-records', {ids}); }
  records() { return this.request('records'); }
  state() { return this.request('state'); }
}
