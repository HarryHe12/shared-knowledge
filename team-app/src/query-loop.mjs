import { randomUUID } from 'node:crypto';
import { answer } from './intelligence.mjs';

const invalid = message => Object.assign(new Error(message), { status: 400 });
const MAX_CLARIFICATIONS = 2;

// Persist pending clarification across reloads/restarts, scoped to both member and project.
export async function ask(store, model, user, project, input) {
  store.access(user, project);
  store.db.exec(`CREATE TABLE IF NOT EXISTS query_clarifications(
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL,
    question TEXT NOT NULL, turns TEXT NOT NULL, pending TEXT NOT NULL,
    expires_at INTEGER NOT NULL, state TEXT NOT NULL)`);
  let context, claimed;
  if (input.clarification_id !== undefined) {
    if (typeof input.clarification_id !== 'string' || typeof input.reply !== 'string' ||
        !input.reply.trim() || input.reply.length > 1000 || input.question !== undefined) throw invalid('请提供澄清回答');
    const row = store.db.prepare(`UPDATE query_clarifications SET state='busy'
      WHERE id=? AND user_id=? AND project_id=? AND state='pending' AND expires_at>?
      RETURNING *`).get(input.clarification_id, user.id, project, Date.now());
    if (!row) throw invalid('澄清已过期、已提交或不属于当前会话，请重新提问');
    claimed = row;
    context = { question: row.question, turns: [...JSON.parse(row.turns),
      { question: row.pending, answer: input.reply.trim() }] };
  } else {
    if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 2000 || input.reply !== undefined) throw invalid('无效问题');
    context = { question: input.question.trim(), turns: [] };
  }
  try {
    const result = await answer(store, model, user, project, context.question, {
      clarifications: context.turns, remainingClarifications: MAX_CLARIFICATIONS - context.turns.length,
    });
    if (result.status === 'needs_clarification') {
      const id = randomUUID();
      store.db.prepare('INSERT INTO query_clarifications VALUES(?,?,?,?,?,?,?,?)').run(
        id, user.id, project, context.question, JSON.stringify(context.turns),
        result.clarification.question, Date.now() + 30 * 60 * 1000, 'pending');
      result.clarification_id = id;
    }
    if (claimed) store.db.prepare("UPDATE query_clarifications SET state='completed' WHERE id=?").run(claimed.id);
    return result;
  } catch (error) {
    // Allow retry after a failed provider request without losing the pending user question.
    if (claimed) store.db.prepare("UPDATE query_clarifications SET state='pending' WHERE id=?").run(claimed.id);
    throw error;
  }
}
