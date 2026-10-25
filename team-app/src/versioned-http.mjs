import {searchRecords, getRecords, getState} from './evidence.mjs';
import {extractDraft} from './extract-draft.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), {status});
const integer = (value, fallback, max) => {
  const n = value === null || value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw fail('分页参数无效');
  return n;
};

// Every client uses the same business API. Channel restrictions apply to raw
// evidence and history as well as to generated answers, including after awaits.
export async function versionedHttp({req, url, input, send, store, model, auth, channels, chat, bearer, cookie, sessionUser}) {
  if (!url.pathname.startsWith('/api/v1/')) return false;
  const path = url.pathname.slice('/api/v1/'.length);
  const method = req.method;
  if (path === 'capabilities' && method === 'GET') {
    send(200, {api_version: 1, audience: 'staff', features: ['organizations', 'channels', 'conversations', 'records', 'state', 'citations'], transport: 'https-json'});
    return true;
  }
  const login = /^channels\/([^/]+)\/(login|bridge)$/.exec(path);
  if (login && method === 'POST') {
    const result = login[2] === 'login'
      ? await channels.login(input.code, login[1])
      : await channels.bridge(login[1], bearer, input.external_id);
    send(200, result);
    return true;
  }
  const channel = sessionUser ? null : channels.authenticate(bearer);
  const user = sessionUser ?? channel?.user;
  if (!user) throw fail('请先登录员工账号', 401);
  const current = () => {
    const latest = channel ? channels.authenticate(bearer) : {user: auth.user(bearer || cookie)};
    if (!latest?.user || latest.user.id !== user.id) throw fail('会话已失效，请重新登录', 401);
    return latest;
  };
  const authorize = (scope, write = false) => {
    const latest = current();
    if (channel) channels.assertScope(latest.app, latest.user, scope, write);
    else auth.authorize(latest.user, scope, write);
  };
  const context = {app_id: channel?.app.id ?? null, authorize};
  const page = () => ({...Object.fromEntries(url.searchParams), ...(url.searchParams.has('limit') ? {limit: integer(url.searchParams.get('limit'), 30, 100)} : {})});
  const scope = () => {
    const id = input.scope_id ?? req.headers['x-knowledge-scope'] ?? url.searchParams.get('scope_id');
    if (typeof id !== 'string' || !id) throw fail('请选择知识范围');
    return id;
  };
  const scopeIds = () => {
    const ids = input.scope_ids ?? [scope()];
    if (!Array.isArray(ids) || !ids.length || ids.length > 40 || ids.some(id => typeof id !== 'string' || !id)) throw fail('知识范围须为1—40个ID');
    const unique = [...new Set(ids)];
    unique.forEach(id => authorize(id));
    const tenants = unique.map(id => auth.organization.context(id)?.tenant_id);
    if (unique.length > 1 && (tenants.some(id => !id) || new Set(tenants).size !== 1)) throw fail('汇总范围必须属于同一家公司');
    return unique;
  };

  let result;
  if (path === 'me' && method === 'GET') {
    current();
    const scopes = auth.me(user).scopes.filter(s => {
      try { authorize(s.id); return true; } catch { return false; }
    });
    result = {user: {id: user.id, name: user.name, status: user.status}, scopes,
      application: channel ? {id: channel.app.id, name: channel.app.name, channel: channel.app.channel} : null};
  } else if (path === 'logout' && method === 'POST') {
    if (channel) channels.revoke(bearer);
    else auth.db.prepare('DELETE FROM auth_sessions WHERE hash=?').run(user.session_hash);
    result = {ok: true};
  } else if (path.startsWith('admin/')) {
    if (channel) throw fail('请通过员工账号管理页面操作', 403);
    current();
    if (path === 'admin/organization') {
      if (method === 'GET') result = auth.organization.overview(user, url.searchParams.get('tenant_id') || undefined);
      else if (method === 'POST') result = auth.organization.manage(user, input);
    } else if (path === 'admin/channels') {
      if (method === 'GET') result = channels.overview(user, url.searchParams.get('tenant_id') || undefined);
      else if (method === 'POST') result = channels.manage(user, input);
    }
  } else if (path === 'conversations') {
    if (method === 'POST') result = chat.create(user, input, context);
    else if (method === 'GET') result = chat.list(user, page(), context);
  } else if (/^conversations\/[^/]+\/messages$/.test(path)) {
    const id = path.split('/')[1];
    if (method === 'POST') result = await chat.send(user, id, input, context);
    else if (method === 'GET') result = chat.messages(user, id, page(), context);
    current();
  } else if (/^conversations\/[^/]+\/requests\/[^/]+$/.test(path) && method === 'GET') {
    const [,id,,requestId] = path.split('/');
    result = chat.request(user, id, requestId, context);
  } else if (/^conversations\/[^/]+\/delete$/.test(path) && method === 'POST') {
    result = chat.remove(user, path.split('/')[1], context);
  } else if (path === 'search' && method === 'POST') {
    const ids = scopeIds();
    const totalLimit = integer(input.limit, 15, 40);
    const limit = Math.max(1, Math.floor(totalLimit / ids.length));
    const epoch = chat.epoch();
    const results = [];
    for (const id of ids) results.push(await searchRecords(store, user, id, {...input, limit}));
    ids.forEach(id => authorize(id));
    if (chat.epoch() !== epoch) throw fail('检索期间资料或权限发生变化，请重新查询', 409);
    result = {results, coverage: {scope_ids: ids, exhaustive: false, per_scope_limit: limit}};
  } else if (path === 'state' && ['GET', 'POST'].includes(method)) {
    const ids = method === 'POST' ? scopeIds() : [scope()];
    const results = ids.map(id => { authorize(id); return {scope_id: id, ...getState(store, user, id)}; });
    result = {results, coverage: {scope_ids: ids, registered_items_only: true}};
  } else if (path === 'records') {
    const id = scope();
    authorize(id, method === 'POST');
    if (method === 'POST') {
      if (typeof input.idempotency_key !== 'string' || !input.idempotency_key.trim() || input.idempotency_key.length > 128) throw fail('请提供1—128字符的幂等标识');
      result = store.add(user, id, {text: input.text, changes: input.changes ?? [], occurred_at: input.occurred_at, idempotency: input.idempotency_key});
    }
    else if (method === 'GET') {
      const limit = integer(url.searchParams.get('limit'), 30, 100);
      const after = url.searchParams.get('after');
      result = store.pageRecords(user, id, {limit, after});
    }
  } else if (path === 'get-records' && method === 'POST') {
    const id = scope(); authorize(id); result = getRecords(store, user, id, input.ids);
  } else if (path === 'extract' && method === 'POST') {
    const id = scope(); authorize(id, true);
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 20000) throw fail('记录须为1—20000字符');
    result = await extractDraft(store, chat, user, id, input.text);
    authorize(id, true);
  } else if (['correct', 'withdraw', 'restore', 'purge'].includes(path) && method === 'POST') {
    const id = scope(); authorize(id, true); result = store[path](user, id, input);
  } else if (path === 'record-history' && method === 'GET') {
    const id = scope(); authorize(id); result = store.history(user, id, url.searchParams.get('id'));
  }
  if (result === undefined) throw fail('未找到接口', 404);
  send(200, result);
  return true;
}
