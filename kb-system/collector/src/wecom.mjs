// 企业微信服务端 API 客户端（零依赖，只用 node: 内置模块）。
// 覆盖两个能力：access_token 获取与缓存（gettoken）、发送文本消息（message/send）。
const API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin';

export class WeCom {
  /**
   * @param {string} corpId 企业 ID
   * @param {string} secret 自建应用的 Secret
   * @param {string|number} agentId 自建应用的 AgentId
   */
  constructor(corpId, secret, agentId) {
    this.corpId = corpId ?? '';
    this.secret = secret ?? '';
    this.agentId = agentId === undefined || agentId === null ? '' : String(agentId);
    this._token = null;      // 缓存的 access_token
    this._tokenExpireAt = 0; // 缓存过期时刻（毫秒时间戳）
  }

  /** 三个参数齐全才算配置完成（缺任何一个都无法调服务端 API）。 */
  get configured() {
    return Boolean(this.corpId && this.secret && this.agentId);
  }

  /**
   * 获取 access_token，带内存缓存：按接口返回的 expires_in 提前 5 分钟过期，
   * 避免用到临近失效的 token。
   */
  async getToken() {
    if (this._token && Date.now() < this._tokenExpireAt) return this._token;
    const url = API_BASE + '/gettoken?corpid=' + encodeURIComponent(this.corpId)
      + '&corpsecret=' + encodeURIComponent(this.secret);
    const r = await fetch(url, {signal: AbortSignal.timeout(15000)});
    const data = await r.json();
    if (data.errcode) {
      throw new Error('gettoken 失败：' + data.errcode + ' ' + (data.errmsg ?? ''));
    }
    this._token = data.access_token;
    // 提前 5 分钟视为过期
    this._tokenExpireAt = Date.now() + (data.expires_in - 300) * 1000;
    return this._token;
  }

  /**
   * 给成员发文本消息（应用消息，msgtype=text）。
   * @param {string} touser 成员 UserID，多人用 "|" 分隔
   * @param {string} content 文本内容
   */
  async sendText(touser, content) {
    if (!this.configured) throw new Error('WeCom 未配置（需要 corpId/secret/agentId）');
    const token = await this.getToken();
    const body = {
      touser,
      msgtype: 'text',
      agentid: Number(this.agentId),
      text: {content},
      safe: 0,
    };
    const data = await this._post(API_BASE + '/message/send?access_token=' + encodeURIComponent(token), body);
    // token 过期类错误：清缓存重试一次
    if (data.errcode === 40014 || data.errcode === 42001) {
      this._token = null;
      this._tokenExpireAt = 0;
      const token2 = await this.getToken();
      const retry = await this._post(API_BASE + '/message/send?access_token=' + encodeURIComponent(token2), body);
      if (retry.errcode) throw new Error('message/send 失败：' + retry.errcode + ' ' + (retry.errmsg ?? ''));
      return retry;
    }
    if (data.errcode) throw new Error('message/send 失败：' + data.errcode + ' ' + (data.errmsg ?? ''));
    return data;
  }

  async _post(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    return r.json();
  }
}
