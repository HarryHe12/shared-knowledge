// Shared by desktop clients and future employee mini programs. No platform
// credential belongs here: tokens identify an employee in one registered app.
export class KnowledgeError extends Error {
  constructor(message, {status = 0, code = 'request_failed'} = {}) {
    super(message);
    this.name = 'KnowledgeError';
    this.status = status;
    this.code = code;
  }
}

const invalid = message => new KnowledgeError(message, {status: 400, code: 'invalid_input'});
const network = () => new KnowledgeError('网络请求未完成，请检查连接后重试。', {code: 'network_error'});
const timeoutError = () => new KnowledgeError('请求超时；重试写入时请复用原消息标识。', {code: 'timeout'});
const id = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || ['.', '..'].includes(value) || /[\s/\\?#\u0000-\u001f]/.test(value)) {
    throw invalid('标识无效');
  }
  return value;
};
const fields = (input, allowed) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('参数须为对象');
  if (Object.keys(input).some(key => !allowed.includes(key))) throw invalid('包含不支持的参数；员工身份与应用权限由服务端确定');
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
};
const key = input => {
  const value = input.idempotency_key;
  if (typeof value !== 'string' || !value.trim() || value.length > 128) {
    throw invalid('需要1—128字符的 idempotency_key；同一次写入的重试须复用原值');
  }
  return {...input, idempotency_key: value.trim()};
};
const scopes = scope => {
  if (Array.isArray(scope)) {
    if (!scope.length || scope.length > 40) throw invalid('请选择1—40个知识范围');
    return {scope_ids: [...new Set(scope.map(id))]};
  }
  return {scope_id: id(scope)};
};

function origin(value) {
  // Intentionally accepts an origin only. This also works in wx runtimes that
  // do not provide the browser URL/URLSearchParams globals.
  if (typeof value !== 'string') throw invalid('请提供 HTTPS 服务地址');
  const match = /^(https?):\/\/(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?\/?$/i.exec(value);
  if (!match) throw invalid('服务地址须为 HTTPS origin，不含路径、查询或账号密码');
  const [, scheme, host, port] = match;
  const hostname = host.toLowerCase();
  if (!hostname.startsWith('[') && hostname.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw invalid('服务地址的主机名无效');
  }
  if (port && (Number(port) < 1 || Number(port) > 65535)) throw invalid('服务地址端口无效');
  if (scheme.toLowerCase() !== 'https' && !['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
    throw invalid('生产服务必须使用 HTTPS；HTTP 仅用于本机开发');
  }
  return `${scheme.toLowerCase()}://${hostname}${port ? ':' + port : ''}`;
}

export function createFetchTransport(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw invalid('当前环境没有 fetch；请注入请求适配器');
  return async ({url, method, headers, body, timeoutMs}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal});
      let data;
      try { data = await response.json(); }
      catch { throw new KnowledgeError('服务返回了无效数据', {status: response.status, code: 'invalid_response'}); }
      return {status: response.status, data};
    } catch (error) {
      if (error instanceof KnowledgeError) throw error;
      if (controller.signal.aborted) throw timeoutError();
      throw network();
    } finally { clearTimeout(timer); }
  };
}

/** Pass wx.request.bind(wx); the SDK never reads a global wx or stores tokens. */
export function createMiniappTransport(request) {
  if (typeof request !== 'function') throw invalid('请注入小程序 request 函数');
  return ({url, method, headers, body, timeoutMs}) => new Promise((resolve, reject) => {
    try {
      request({url, method, header: headers, data: body, dataType: 'json', timeout: timeoutMs, enableCache: false,
        success: response => {
          let data = response.data;
          if (typeof data === 'string') {
            try { data = JSON.parse(data); }
            catch { reject(new KnowledgeError('服务返回了无效数据', {status: response.statusCode, code: 'invalid_response'})); return; }
          }
          resolve({status: response.statusCode, data});
        },
        fail: error => reject(/timeout/i.test(error?.errMsg ?? '') ? timeoutError() : network())});
    } catch { reject(network()); }
  });
}

export class KnowledgeClient {
  #token = null;
  #transport;
  constructor({baseUrl, token, transport, timeoutMs = 60000} = {}) {
    Object.defineProperty(this, 'baseUrl', {value: origin(baseUrl), enumerable: true});
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw invalid('timeoutMs 须为1000—120000毫秒');
    this.timeoutMs = timeoutMs;
    this.#transport = transport ?? createFetchTransport();
    if (typeof this.#transport !== 'function') throw invalid('请求适配器须为函数');
    if (token !== undefined) this.setToken(token);
  }
  setToken(token) {
    if (typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token)) throw invalid('员工会话凭证无效');
    this.#token = token;
    return this;
  }
  clearToken() { this.#token = null; return this; }

  async #request(path, {method = 'GET', body, query, scope, anonymous = false} = {}) {
    const usedToken = anonymous ? null : this.#token;
    if (!anonymous && !usedToken) throw new KnowledgeError('请先登录员工账号', {status: 401, code: 'unauthenticated'});
    const headers = {Accept: 'application/json'};
    if (usedToken) headers.Authorization = 'Bearer ' + usedToken;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (scope !== undefined) headers['X-Knowledge-Scope'] = id(scope);
    const pairs = Object.entries(query ?? {}).filter(([, value]) => value !== undefined && value !== null);
    const suffix = pairs.length ? '?' + pairs.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&') : '';
    let result;
    try {
      result = await this.#transport({url: `${this.baseUrl}/api/v1/${path}${suffix}`, method, headers, body, timeoutMs: this.timeoutMs});
    } catch (error) {
      if (error instanceof KnowledgeError) throw error;
      throw network();
    }
    if (!result || !Number.isInteger(result.status) || result.status < 100 || result.status > 599 ||
        !result.data || typeof result.data !== 'object') {
      throw new KnowledgeError('服务返回了无效数据', {code: 'invalid_response'});
    }
    if (result.status < 200 || result.status >= 300) {
      if (result.status === 401 && this.#token === usedToken) this.clearToken();
      const message = typeof result.data.error === 'string' ? result.data.error : '请求未完成，请稍后重试';
      throw new KnowledgeError(message, {status: result.status, code: 'http_error'});
    }
    return result.data;
  }

  capabilities() { return this.#request('capabilities', {anonymous: true}); }
  async login(appId, code) {
    if (typeof code !== 'string' || !code.trim() || code.length > 256) throw invalid('小程序临时登录凭证无效');
    const result = await this.#request(`channels/${encodeURIComponent(id(appId))}/login`, {method: 'POST', body: {code}, anonymous: true});
    this.setToken(result.token);
    return result;
  }
  me() { return this.#request('me'); }
  async logout() {
    const usedToken = this.#token;
    try { return await this.#request('logout', {method: 'POST', body: {}}); }
    finally { if (this.#token === usedToken) this.clearToken(); }
  }
  createConversation(input) {
    const body = fields(input, ['scope_id', 'scope_ids', 'title']);
    if (body.scope_id !== undefined && body.scope_ids !== undefined) throw invalid('请选择 scope_id 或 scope_ids');
    return this.#request('conversations', {method: 'POST', body: {...body, ...scopes(body.scope_ids ?? body.scope_id)}});
  }
  listConversations(input = {}) {
    return this.#request('conversations', {query: fields(input, ['scope_id', 'limit', 'before'])});
  }
  sendMessage(conversationId, input) {
    return this.#request(`conversations/${encodeURIComponent(id(conversationId))}/messages`, {method: 'POST',
      body: key(fields(input, ['text', 'intent', 'idempotency_key', 'occurred_at', 'changes']))});
  }
  getMessages(conversationId, input = {}) {
    return this.#request(`conversations/${encodeURIComponent(id(conversationId))}/messages`, {query: fields(input, ['limit', 'before'])});
  }
  getRequest(conversationId, requestId) {
    return this.#request(`conversations/${encodeURIComponent(id(conversationId))}/requests/${encodeURIComponent(id(requestId))}`);
  }
  deleteConversation(conversationId) {
    return this.#request(`conversations/${encodeURIComponent(id(conversationId))}/delete`, {method: 'POST', body: {}});
  }
  search(scope, input) {
    return this.#request('search', {method: 'POST', body: {...fields(input, ['query', 'strategy', 'depth', 'limit']), ...scopes(scope)}});
  }
  state(scope) { return this.#request('state', {method: 'POST', body: scopes(scope)}); }
  records(scope, input = {}) {
    return this.#request('records', {scope: id(scope), query: fields(input, ['limit', 'after'])});
  }
  getRecords(scope, ids) { return this.#request('get-records', {method: 'POST', body: {scope_id: id(scope), ids}}); }
  save(scope, input) {
    return this.#request('records', {method: 'POST', body: {...key(fields(input, ['text', 'changes', 'occurred_at', 'idempotency_key'])), scope_id: id(scope)}});
  }
  extract(scope, text) { return this.#request('extract', {method: 'POST', body: {scope_id: id(scope), text}}); }
  correct(scope, input) { return this.#mutate('correct', scope, fields(input, ['id', 'version', 'text', 'changes', 'occurred_at'])); }
  withdraw(scope, input) { return this.#mutate('withdraw', scope, fields(input, ['id', 'version'])); }
  restore(scope, input) { return this.#mutate('restore', scope, fields(input, ['id', 'version'])); }
  purge(scope, input) { return this.#mutate('purge', scope, fields(input, ['id', 'version'])); }
  #mutate(action, scope, input) {
    if (!Number.isInteger(input.version) || input.version < 1) throw invalid('更改记录需要当前 version；冲突后重新读取');
    return this.#request(action, {method: 'POST', body: {...input, id: id(input.id), scope_id: id(scope)}});
  }
  history(scope, recordId) { return this.#request('record-history', {scope: id(scope), query: {id: id(recordId)}}); }
}
