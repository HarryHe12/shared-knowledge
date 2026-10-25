// Flat Markdown exports cannot carry employee ACLs or invalidate derived text.
// Keep legacy private exports opt-in and reject all organization-managed scopes.
export async function allowLegacyExport(kb, enabled = process.env.KB_ENABLE_LEGACY_EXPORT) {
  if (enabled !== '1') return false;
  const me = await kb.me();
  const scope = me.scopes.find(row => row.id === kb.scope);
  if (!scope || scope.tenant_id) throw Object.assign(new Error('旧 Wiki/摘要导出不支持公司权限范围，请使用有权限校验的聊天查询'), {status: 403});
  return true;
}
