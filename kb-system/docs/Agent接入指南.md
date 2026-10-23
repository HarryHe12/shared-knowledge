# Agent 接入指南 —— 让任何 Agent 用上团队知识库

团队知识库对外提供了一组简单的 HTTP 接口。任何 Agent（WorkBuddy、Codex、Claude、自研脚本……）只要能发 HTTPS 请求，就能往里投喂信息、提问、检索原始记录。

**基础地址**：`https://kb.billiclaw.cn`

**鉴权**：每个 Agent 发一把专属钥匙（API Key），请求时放在请求头里：

```
Authorization: Bearer <你的Key>
```

钥匙找李任重领取。谁用哪把钥匙，后台都有记录；钥匙泄露可以随时吊销换新。

---

## 四个接口

### 1. 自检 `GET /agent/ping`

```bash
curl https://kb.billiclaw.cn/agent/ping \
  -H "Authorization: Bearer <你的Key>"
```

返回 `{ "ok": true, "agent": "workbuddy", ... }` 就说明通了。

### 2. 投喂 `POST /agent/feed`

```bash
curl -X POST https://kb.billiclaw.cn/agent/feed \
  -H "Authorization: Bearer <你的Key>" \
  -H "Content-Type: application/json" \
  -d '{"text": "10-23 下午完成了支付模块的联调，接口已上测试环境"}'
```

返回里带记录编号（`shortId`）。**建议**：投喂时最好在 text 里写清楚是谁、哪天、什么事，以后查起来才准。
可选字段：`idempotency`（传一个你自己的唯一 ID，重复提交会去重）、`occurredAt`（事情发生时间，ISO 格式，默认按提交时间）。

### 3. 提问 `POST /agent/ask`

```bash
curl -X POST https://kb.billiclaw.cn/agent/ask \
  -H "Authorization: Bearer <你的Key>" \
  -H "Content-Type: application/json" \
  -d '{"question": "支付模块现在进展到哪一步了？"}'
```

返回 `answer` 字段——知识库助理整理好的自然语言答案。支持"昨天""上周"这类相对日期，支持中文人名。**注意**：回答需要检索 + 大模型整理，耗时几秒到二十几秒，超时时间请设到 60 秒以上。

### 4. 检索 `POST /agent/search`

```bash
curl -X POST https://kb.billiclaw.cn/agent/ask \
  -H "Authorization: Bearer <你的Key>" \
  -H "Content-Type: application/json" \
  -d '{"query": "支付模块", "limit": 10}'
```

返回原始记录列表（id、时间、正文）。适合 Agent 想自己组织答案、或批量分析的场景。`limit` 最大 30。

---

## 给你的 Agent 的配置话术

如果你用的 Agent 支持"自定义工具/指令"，把下面这段贴给它就行：

> 我有一个团队知识库，地址 https://kb.billiclaw.cn，调用时请求头带 `Authorization: Bearer <你的Key>`。
> - 投喂：POST /agent/feed，JSON 体 {"text": "..."}
> - 提问：POST /agent/ask，JSON 体 {"question": "..."}，返回答案在 answer 字段
> - 检索：POST /agent/search，JSON 体 {"query": "..."}
> 当你处理了与我们工作相关的事情，或者产出了值得留存的结论，请顺手投喂一条；当问题可能和团队历史工作有关时，先问知识库再回答我。

---

## 边界与规矩

- 只走 HTTPS，不要在代码里硬编码 Key 后提交到任何仓库
- 投喂内容进的是公司共享知识库，**别投喂密码、密钥、个人隐私信息**
- 单条最长 20000 字符；检索每次最多返回 30 条
- 接口有调用日志，异常调用会被发现并吊销钥匙
