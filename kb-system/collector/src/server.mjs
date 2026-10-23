// 企业微信采集服务主入口（零依赖，只用 node: 内置模块）。
//
// 职责：
//   GET  /wecom/callback —— 企微 URL 验证（验签 → 解密 echostr → 原文返回）
//   POST /wecom/callback —— 验签 → 解密 → 解析消息 → 分流处理 → 加密被动回复
//
// 分流逻辑（route/HELP_TEXT）由 librarian/scripts/router.mjs 提供（Agent B 并行开发），
// 提问回答（answerQuestion）由 librarian/scripts/answer.mjs 提供。本文件只做采集与转发。
//
// 兜底原则：任何异常都回 HTTP 200 "success"，防止企微重推造成重复入库；
// 重复消息由幂等键 wecom:<MsgId> 在内核侧去重。
import http from 'node:http';
import {WxCrypto, xmlField, textReplyXml, encryptReplyXml, DEV_TOKEN, DEV_ENCODING_AES_KEY, DEV_CORP_ID} from './wxcrypto.mjs';
import {WeCom} from './wecom.mjs';
import {KnowledgeBase} from './kb.mjs';
import {LLM} from './llm.mjs';
import {handleAgentApi} from './agent-api.mjs';
import {route, routeWithLLM, HELP_TEXT} from '../../librarian/scripts/router.mjs';
import {answerQuestion} from '../../librarian/scripts/answer.mjs';

// ===== 配置（回调加解密三件套有开发默认值；服务端 API 凭据必须显式配置）=====
const TOKEN = process.env.WECOM_TOKEN ?? DEV_TOKEN;
const AES_KEY = process.env.WECOM_ENCODING_AES_KEY ?? DEV_ENCODING_AES_KEY;
const CORP_ID = process.env.WECOM_CORP_ID ?? DEV_CORP_ID;
const PORT = Number(process.env.COLLECTOR_PORT ?? 9100);

const crypto = new WxCrypto(TOKEN, AES_KEY, CORP_ID);
const kb = new KnowledgeBase(process.env.KB_URL);
const llm = new LLM();
// 注意：secret/agentId 不给开发默认值——没配置时 configured=false，主动推送自动降级为打日志
const wecom = new WeCom(process.env.WECOM_CORP_ID, process.env.WECOM_SECRET, process.env.WECOM_AGENT_ID);

/** 提问后的异步回答：先被动回复"正在查"，答案算好后用应用消息主动推给提问者。 */
async function answerAndPush(userId, question) {
  try {
    const answer = await answerQuestion(kb, llm, question);
    const text = '💡 ' + answer;
    if (wecom.configured) {
      await wecom.sendText(userId, text);
      console.log('[answer] 已推送给', userId);
    } else {
      // 本地开发没有企微服务端凭据时，答案打日志，不影响被动回执
      console.log('[answer]（未配置 WECOM_SECRET/AGENT_ID，答案仅落日志）', userId, text);
    }
  } catch (err) {
    console.error('[answer] 回答失败：', err);
  }
}

/**
 * 文本类消息的统一处理（text 消息、voice 识别结果都走这里）。
 * @returns {Promise<string|null>} 被动回复内容；null 表示不回（回 success）
 */
async function handleText({text, userId, source, msgId, occurredAt}) {
  const r = await routeWithLLM(text, llm);
  switch (r.kind) {
    case 'help':
      return HELP_TEXT;
    case 'ignore':
      return null;
    case 'chat':
      return '我在的～ 想投喂就直接把事情说给我，想查东西就直接问，比如"上周李任重做了啥"。';
    case 'question':
      // 立即被动回复，真正答案异步算好后主动推送（企微被动回复有 5 秒时限）
      answerAndPush(userId, r.question);
      return '收到问题，正在查知识库…';
    case 'retract':
      return '撤回记录需要管理员在知识库后台操作。'
        + (r.recordId ? '请把记录编号 #' + r.recordId + ' 发给管理员处理。' : '请把要撤回的记录编号（回执里的 #短ID）发给管理员处理。');
    case 'note': {
      // 按契约在文本头部加【作者】【来源】，幂等键 wecom:<MsgId>
      const body = '【作者:' + userId + '】【来源:' + source + '】' + r.text;
      const rec = await kb.save({text: body, idempotency: 'wecom:' + msgId, occurredAt});
      const shortId = String(rec.id).slice(0, 8);
      return '已收录 #' + shortId + ' ✅（发“帮助”查看我能做什么）';
    }
    default:
      console.warn('[handleText] 未知路由结果：', r);
      return null;
  }
}

/**
 * 消息分流。返回被动回复内容（string）或 null（不回，回 success）。
 */
async function dispatchMessage(msg) {
  const msgType = xmlField(msg, 'MsgType');
  const userId = xmlField(msg, 'FromUserName') ?? 'unknown';
  const msgId = xmlField(msg, 'MsgId') ?? String(Date.now());
  const createTimeSec = Number(xmlField(msg, 'CreateTime') ?? 0);
  const occurredAt = new Date((createTimeSec || Math.floor(Date.now() / 1000)) * 1000).toISOString();

  if (msgType === 'text') {
    const content = xmlField(msg, 'Content') ?? '';
    return handleText({text: content, userId, source: '企微', msgId, occurredAt});
  }

  if (msgType === 'voice') {
    // 企微开通"语音转文字"后会在 Recognition 字段带识别结果
    const recognition = xmlField(msg, 'Recognition');
    if (recognition) {
      return handleText({text: recognition, userId, source: '企微语音', msgId, occurredAt});
    }
    // 无识别结果：存占位文本，方便管理员看到"有人发过语音"
    const mediaId = xmlField(msg, 'MediaId') ?? '';
    const body = '【作者:' + userId + '】【来源:企微语音】[语音消息 未能识别文字] MediaId:' + mediaId;
    const rec = await kb.save({text: body, idempotency: 'wecom:' + msgId, occurredAt});
    return '已收录 #' + String(rec.id).slice(0, 8) + ' ✅（语音未识别出文字，仅存档占位）';
  }

  if (msgType === 'image') {
    const picUrl = xmlField(msg, 'PicUrl') ?? '';
    const body = '【作者:' + userId + '】【来源:企微图片】[图片] ' + picUrl;
    const rec = await kb.save({text: body, idempotency: 'wecom:' + msgId, occurredAt});
    return '已收录 #' + String(rec.id).slice(0, 8) + ' ✅（图片文字识别 OCR 即将上线）';
  }

  // event 及其他类型（位置、链接、卡片等）：不处理，回 success
  return null;
}

/** 读取请求体（限 1MB，防异常大包）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function respond(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {'Content-Type': contentType});
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    // Agent API（/agent/ 前缀，Bearer token 鉴权，与企微回调完全隔离）
    if (await handleAgentApi(req, res, url.pathname, kb, llm)) return;
    if (url.pathname !== '/wecom/callback') {
      respond(res, 404, 'not found');
      return;
    }
    const q = url.searchParams;
    const msgSignature = q.get('msg_signature') ?? '';
    const timestamp = q.get('timestamp') ?? '';
    const nonce = q.get('nonce') ?? '';

    if (req.method === 'GET') {
      // ===== 企微 URL 验证：验签 → 解密 echostr → 原文返回 =====
      const echostr = q.get('echostr') ?? '';
      if (!crypto.verify(timestamp, nonce, echostr, msgSignature)) {
        console.warn('[GET] URL 验证签名不匹配');
        respond(res, 403, 'signature mismatch');
        return;
      }
      const {message} = crypto.decrypt(echostr);
      respond(res, 200, message);
      console.log('[GET] URL 验证通过');
      return;
    }

    if (req.method === 'POST') {
      // ===== 接收消息：验签 → 解密 → 分流 → 加密被动回复 =====
      const bodyXml = await readBody(req);
      const encrypt = xmlField(bodyXml, 'Encrypt') ?? '';
      if (!crypto.verify(timestamp, nonce, encrypt, msgSignature)) {
        console.warn('[POST] 消息签名不匹配');
        respond(res, 200, 'success'); // 签名错也回 200，避免企微反复重推
        return;
      }
      const {message: innerXml, receiveId} = crypto.decrypt(encrypt);
      if (receiveId !== CORP_ID) {
        console.warn('[POST] receiveId 不匹配：', receiveId);
        respond(res, 200, 'success');
        return;
      }
      const replyText = await dispatchMessage(innerXml);
      if (replyText === null || replyText === undefined) {
        respond(res, 200, 'success');
        return;
      }
      // 被动回复：From/To 对调，加密信封返回
      const toUser = xmlField(innerXml, 'FromUserName') ?? '';
      const fromUser = xmlField(innerXml, 'ToUserName') ?? CORP_ID;
      const replyXml = encryptReplyXml(crypto, textReplyXml(toUser, fromUser, replyText));
      respond(res, 200, replyXml, 'application/xml; charset=utf-8');
      return;
    }

    respond(res, 405, 'method not allowed');
  } catch (err) {
    // 兜底：任何异常都回 200 "success"，防企微重推（幂等键在内核侧兜底防重复）
    console.error('[server] 处理异常：', err);
    try {
      respond(res, 200, 'success');
    } catch {
      // 响应已发出就没办法了，仅记录
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[collector] 企业微信采集服务已启动');
  console.log('[collector] 回调地址：http://0.0.0.0:' + PORT + '/wecom/callback');
  console.log('[collector] 知识库内核：' + kb.base);
  console.log('[collector] 企微主动推送：' + (wecom.configured ? '已配置' : '未配置（答案只打日志）'));
  console.log('[collector] LLM：' + (llm.configured ? '已配置' : '未配置（问答降级）'));
});
