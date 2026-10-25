import {extract} from './intelligence.mjs';

// A draft is never committed automatically. Keep related state and model work
// bounded, and invalidate a draft if source state changes during generation.
export async function extractDraft(store, chat, user, scopeId, text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 20000) {
    throw Object.assign(new Error('记录须为1—20000字符'), {status: 400});
  }
  const epoch = chat.epoch(), all = store.items(user, scopeId);
  const items = all.sort((a,b) => Number(text.includes(b.title))*b.title.length - Number(text.includes(a.title))*a.title.length).slice(0,100)
    .map(item=>({id:item.id,title:item.title.slice(0,500),status:item.status,kind:item.kind}));
  const draft = await extract((system,input)=>chat.callModel(user.id,system,input),text,items);
  if (chat.epoch() !== epoch) throw Object.assign(new Error('资料或权限已变化，请重新提取'), {status: 409});
  if (!draft || !Array.isArray(draft.changes) || !Array.isArray(draft.ambiguities) || draft.changes.length>30) {
    throw Object.assign(new Error('事项草稿格式无效，请重新提取或直接保存原文'), {status: 503});
  }
  return {...draft,coverage:{related_items:items.length,total_items:all.length,truncated:all.length>items.length},requires_confirmation:true};
}
