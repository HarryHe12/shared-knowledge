#!/usr/bin/env node
// 本地模拟器：假装企业微信服务器，向采集服务发送加密回调。
// 复用 collector 的 WxCrypto，保证加解密、验签逻辑与真实链路完全一致。
//
// 用法：
//   node simulator/send.mjs --verify                      模拟企微 URL 验证（GET）
//   node simulator/send.mjs --user zhangsan --text "会议纪要：本周五发版"   模拟成员发消息（POST）
//   node simulator/send.mjs --user lisi --text "问：发版时间是？"          模拟提问（POST）
//
// 选项：
//   --port <端口>   采集服务端口，默认 9100
//   --host <主机>   采集服务主机，默认 127.0.0.1
//
// 企微配置默认与 collector 的开发默认一致（dev-token / 43 位假 AESKey / ww-dev-corp），
// 可用环境变量 WECOM_TOKEN / WECOM_ENCODING_AES_KEY / WECOM_CORP_ID 覆盖。
import {randomBytes} from 'node:crypto';
import {WxCrypto, xmlField, DEV_TOKEN, DEV_ENCODING_AES_KEY, DEV_CORP_ID} from '../collector/src/wxcrypto.mjs';

// ===== 参数解析（手工极简解析，不引第三方库）=====
function parseArgs(argv) {
  const args = {port: 9100, host: '127.0.0.1'};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--verify') args.verify = true;
    else if (a === '--user') args.user = argv[++i];
    else if (a === '--text') args.text = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      console.error('未知参数：' + a);
      process.exit(2);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || (!args.verify && !(args.user && args.text))) {
  console.log(`用法：
  node simulator/send.mjs --verify                       模拟企微 URL 验证（GET）
  node simulator/send.mjs --user <id> --text <文本>      模拟成员发消息（POST）
  node simulator/send.mjs --user <id> --text "问：..."   模拟提问（POST）
选项：--port 默认 9100；--host 默认 127.0.0.1`);
  process.exit(args.help ? 0 : 2);
}

const crypto = new WxCrypto(
  process.env.WECOM_TOKEN ?? DEV_TOKEN,
  process.env.WECOM_ENCODING_AES_KEY ?? DEV_ENCODING_AES_KEY,
  process.env.WECOM_CORP_ID ?? DEV_CORP_ID,
);
const CORP_ID = process.env.WECOM_CORP_ID ?? DEV_CORP_ID;

/** 构造带签名的回调 query 串。 */
function signedQuery(encrypt) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(8).toString('hex');
  const sig = crypto.signature(timestamp, nonce, encrypt);
  return 'msg_signature=' + sig + '&timestamp=' + timestamp + '&nonce=' + nonce;
}

/** GET：模拟企微 URL 验证。 */
async function doVerify() {
  const echoPlain = 'echo-' + randomBytes(8).toString('hex'); // 随机回声串
  const echostr = crypto.encrypt(echoPlain);
  const url = 'http://' + args.host + ':' + args.port + '/wecom/callback?'
    + signedQuery(echostr) + '&echostr=' + encodeURIComponent(echostr);
  const r = await fetch(url);
  const body = await r.text();
  console.log('HTTP 状态：', r.status);
  console.log('返回回声：', body);
  console.log(body === echoPlain ? '✅ URL 验证通过' : '❌ URL 验证失败（期望：' + echoPlain + '）');
  process.exitCode = body === echoPlain ? 0 : 1;
}

/** POST：模拟成员发一条 text 消息，并解密打印被动回执。 */
async function doSend() {
  const now = Math.floor(Date.now() / 1000);
  // MsgId：时间戳 + 随机数，保证每次模拟唯一（幂等键由此派生）
  const msgId = String(now) + String(randomBytes(4).readUInt32BE(0));
  // 1) 拼消息明文 XML（企微服务器真正加密的就是这一段）
  const innerXml = '<xml>'
    + '<ToUserName><![CDATA[' + CORP_ID + ']]></ToUserName>'
    + '<FromUserName><![CDATA[' + args.user + ']]></FromUserName>'
    + '<CreateTime>' + now + '</CreateTime>'
    + '<MsgType><![CDATA[text]]></MsgType>'
    + '<Content><![CDATA[' + args.text + ']]></Content>'
    + '<MsgId>' + msgId + '</MsgId>'
    + '<AgentID>1000002</AgentID>'
    + '</xml>';
  // 2) 加密并套外层信封
  const encrypt = crypto.encrypt(innerXml);
  const envelope = '<xml>'
    + '<ToUserName><![CDATA[' + CORP_ID + ']]></ToUserName>'
    + '<Encrypt><![CDATA[' + encrypt + ']]></Encrypt>'
    + '<AgentID><![CDATA[1000002]]></AgentID>'
    + '</xml>';
  // 3) 发送
  const url = 'http://' + args.host + ':' + args.port + '/wecom/callback?' + signedQuery(encrypt);
  const r = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/xml'},
    body: envelope,
  });
  const respBody = await r.text();
  console.log('HTTP 状态：', r.status);
  // 4) 解密被动回执（若是加密信封 XML）
  const respEncrypt = xmlField(respBody, 'Encrypt');
  if (respEncrypt) {
    try {
      const {message} = crypto.decrypt(respEncrypt);
      const content = xmlField(message, 'Content');
      console.log('回执内容：', content ?? message);
    } catch (err) {
      console.error('回执解密失败：', err.message);
      console.log('原始返回：', respBody);
      process.exitCode = 1;
    }
  } else {
    console.log('返回内容：', respBody);
  }
}

if (args.verify) {
  await doVerify();
} else {
  await doSend();
}
