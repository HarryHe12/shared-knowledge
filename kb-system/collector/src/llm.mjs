// OpenAI 兼容协议的 LLM 客户端（协调者提供的共享模块，只读使用）。
// 环境变量：KB_LLM_BASE_URL / KB_LLM_API_KEY / KB_LLM_MODEL。
export class LLM {
  constructor({baseUrl, apiKey, model} = {}) {
    this.baseUrl = (baseUrl ?? process.env.KB_LLM_BASE_URL ?? '').replace(/\/$/, '');
    this.apiKey = apiKey ?? process.env.KB_LLM_API_KEY ?? '';
    this.model = model ?? process.env.KB_LLM_MODEL ?? '';
  }

  get configured() {
    return Boolean(this.baseUrl && this.apiKey && this.model);
  }

  async chat(messages, {maxTokens = 2000} = {}) {
    if (!this.configured) return null;
    try {
      const r = await fetch(this.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.apiKey},
        body: JSON.stringify({model: this.model, messages, max_tokens: maxTokens, temperature: 0.2}),
        signal: AbortSignal.timeout(120000),
      });
      const data = await r.json();
      return data?.choices?.[0]?.message?.content ?? null;
    } catch {
      return null;
    }
  }
}
