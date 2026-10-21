import { createHash } from 'node:crypto';

const MODES = ['bm25', 'vector', 'hybrid', 'hybrid-rerank'];
export function retrievalConfig(options = {}) {
  const config = {
    mode: options.mode ?? process.env.TEAM_RETRIEVAL_MODE ??
      (process.env.TEAM_RERANK_URL ? 'hybrid-rerank' : process.env.TEAM_EMBEDDING_URL ? 'hybrid' : 'bm25'),
    embeddingUrl: options.embeddingUrl ?? process.env.TEAM_EMBEDDING_URL,
    embeddingModel: options.embeddingModel ?? process.env.TEAM_EMBEDDING_MODEL,
    embeddingKey: options.embeddingKey ?? process.env.TEAM_EMBEDDING_KEY ?? process.env.SILICONFLOW_API_KEY,
    rerankUrl: options.rerankUrl ?? process.env.TEAM_RERANK_URL,
    rerankModel: options.rerankModel ?? process.env.TEAM_RERANK_MODEL,
    rerankKey: options.rerankKey ?? process.env.TEAM_RERANK_KEY ?? process.env.SILICONFLOW_API_KEY,
    topK: options.topK ?? 15,
  };
  if (!MODES.includes(config.mode)) throw new Error('无效检索模式');
  if (!Number.isInteger(config.topK) || config.topK < 1 || config.topK > 40) throw new Error('topK 须为1—40');
  if (config.mode !== 'bm25' && (!config.embeddingUrl || !config.embeddingModel)) throw new Error('缺少 embedding 地址或模型配置');
  if (config.mode === 'hybrid-rerank' && (!config.rerankUrl || !config.rerankModel)) throw new Error('缺少 rerank 地址或模型配置');
  return config;
}

async function request(url, key, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  // Never echo response bodies: gateways may include credentials or submitted text.
  if (!response.ok) throw new Error(`检索服务调用失败（HTTP ${response.status}）`);
  return response.json();
}

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length ||
      [...a, ...b].some(x => !Number.isFinite(x))) throw new Error('无效向量');
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  if (!aa || !bb) throw new Error('向量范数不能为零');
  return dot / Math.sqrt(aa * bb);
}

export function fuse(lists) {
  const scores = new Map(), rows = new Map();
  for (const list of lists) list.forEach((r, i) => {
    scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (60 + i + 1)); rows.set(r.id, r);
  });
  return [...rows.values()].sort((a, b) => scores.get(b.id) - scores.get(a.id));
}

export async function retrieve(store, user, project, query, options = {}) {
  // Check permissions before consulting caches or making any external request.
  store.access(user, project);
  const epoch=store.db.prepare('SELECT value FROM record_epoch').get().value;
  const unchanged=()=>{if(store.db.prepare('SELECT value FROM record_epoch').get().value!==epoch)throw Object.assign(new Error('记录已变化，请重新检索'),{status:409});};
  const config = retrievalConfig(options);
  const lexical = config.mode === 'vector' ? [] : store.search(user, project, query);
  const notes = config.mode === 'vector' ? [] : ['中文全文 BM25'];
  let hits = lexical;
  if (config.mode !== 'bm25') {
    store.db.exec('CREATE TABLE IF NOT EXISTS embeddings(cache_key TEXT PRIMARY KEY,vector TEXT NOT NULL)');
    const embed = async text => {
      const key = createHash('sha256').update(JSON.stringify([project, config.embeddingUrl, config.embeddingModel, text])).digest('hex');
      const cached = store.db.prepare('SELECT vector FROM embeddings WHERE cache_key=?').get(key);
      if (cached) return JSON.parse(cached.vector);
      const result = await request(config.embeddingUrl, config.embeddingKey, {
        model: config.embeddingModel, input: text, encoding_format: 'float',
      });
      const vector = result.data?.[0]?.embedding;
      cosine(vector, vector);
      unchanged();
      store.db.prepare('INSERT OR REPLACE INTO embeddings VALUES(?,?)').run(key, JSON.stringify(vector));
      return vector;
    };
    const q = await embed(query), ranked = [];
    for (const record of store.records(user, project)) {
      const vector = await embed(record.text);
      ranked.push({ ...record, semantic_score: cosine(q, vector) });
    }
    ranked.sort((a, b) => b.semantic_score - a.semantic_score);
    hits = config.mode === 'vector' ? ranked.slice(0, 40) : fuse([lexical, ranked.slice(0, 40)]);
    notes.push(config.mode === 'vector' ? '向量' : '向量 + RRF');
  }
  if (config.mode === 'hybrid-rerank' && hits.length) {
    const candidates = hits.slice(0, 60);
    const result = await request(config.rerankUrl, config.rerankKey, {
      model: config.rerankModel, query, documents: candidates.map(r => r.text),
      top_n: Math.min(config.topK, candidates.length), return_documents: false,
    });
    if (!Array.isArray(result.results) || !result.results.length || result.results.some(r =>
      !Number.isInteger(r.index) || !candidates[r.index] || !Number.isFinite(r.relevance_score))) {
      throw new Error('无效 rerank 结果');
    }
    hits = [...new Set([...result.results].sort((a,b) => b.relevance_score - a.relevance_score).map(r => r.index))].map(i => candidates[i]);
    notes.push('rerank');
  }
  unchanged();
  return { hits: hits.slice(0, config.topK), description: notes.join(' + '), mode: config.mode };
}
