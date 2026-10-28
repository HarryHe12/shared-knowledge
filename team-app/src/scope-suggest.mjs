/**
 * 保存时的自动范围推导。权限不变的边界下，只决定“写入哪个范围”：
 * 单一可写范围直接用；内容关键词唯一命中用命中；岗位归属给默认；
 * 都不确定时给一个稳定的兜底默认。负责人级(executive)范围绝不自动选中，
 * 只能由员工显式选择。
 */
const MANAGEMENT_HINTS = ['盘点', '排班', '绩效', '考核', '工资', '薪资', '人事', '库存',
  '进货', '补货', '报损', '成本', '审计', '巡查', '卫生检查', '投诉', '退货', '损耗'];

export function suggestScope(text, candidates, {assignments = []} = {}) {
  if (!Array.isArray(candidates) || !candidates.length) throw new Error('无可写范围');
  const usable = candidates.filter(scope => scope.level !== 'executive');
  if (!usable.length) throw new Error('无可自动写入的范围');
  if (usable.length === 1) return {scope: usable[0], reason: 'only'};

  // 1) 内容关键词：范围名称、门店、品牌、公司名在原文中出现即加分；管理类用词只提升管理级范围。
  const scored = usable.map(scope => {
    let score = 0;
    if (scope.store_name && text.includes(scope.store_name)) score += scope.level === 'management' ? 4 : 5;
    if (scope.brand_name && text.includes(scope.brand_name)) score += scope.store_id ? 1 : scope.level === 'staff' ? 4 : 2;
    if (scope.tenant_name && text.includes(scope.tenant_name) && !scope.store_id) score += 1;
    if (scope.level === 'management' && MANAGEMENT_HINTS.some(hint => text.includes(hint))) score += 2;
    return {scope, score};
  }).filter(entry => entry.score > 0).sort((a, b) => b.score - a.score || a.scope.id.localeCompare(b.scope.id));
  if (scored.length && scored[0].score > (scored[1]?.score ?? 0)) return {scope: scored[0].scope, reason: 'content'};

  // 2) 岗位归属：店员的默认落点是本店员工协作；店长的日常记录也默认员工协作；品牌负责人默认品牌公共。
  const primary = assignments[0];
  if (primary) {
    const byStore = usable.find(scope => scope.store_id && scope.store_id === primary.store_id && scope.level === 'staff');
    if (byStore) return {scope: byStore, reason: 'assignment'};
    if (primary.role === 'brand_manager') {
      const brandStaff = usable.find(scope => scope.brand_id && !scope.store_id && scope.level === 'staff' && scope.brand_id === primary.brand_id);
      if (brandStaff) return {scope: brandStaff, reason: 'assignment'};
    }
  }

  // 3) 兜底默认：公司级公共 > 品牌公共 > 任一员工级 > 任一可写。稳定可预期，回执告知并可“换”。
  const preferred = usable.find(scope => scope.level === 'staff' && !scope.store_id && !scope.brand_id)
    ?? usable.find(scope => scope.level === 'staff' && !scope.store_id)
    ?? usable.find(scope => scope.level === 'staff')
    ?? usable[0];
  return {scope: preferred, reason: 'default'};
}

/** 解析“换到 XX”里的目标范围；返回唯一命中，歧义或无命中返回 null。 */
export function matchScope(target, candidates) {
  const text = String(target ?? '').trim();
  if (!text) return null;
  const hits = candidates.filter(scope =>
    scope.name === text ||
    scope.name.includes(text) ||
    (scope.store_name && (text.includes(scope.store_name) || scope.store_name.includes(text))) ||
    (scope.brand_name && !scope.store_id && (text.includes(scope.brand_name) || scope.brand_name.includes(text))));
  if (!hits.length) return null;
  const preferred = hits.find(scope => scope.level === 'staff' && scope.store_id)
    ?? hits.find(scope => scope.level === 'staff')
    ?? hits[0];
  return preferred;
}
