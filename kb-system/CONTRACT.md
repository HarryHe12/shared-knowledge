# 开发契约（两个 Coding Agent 的边界与接口）

> 本文件是两个 Coding Agent 并行开发的**唯一共同约定**。各自目录内的实现细节各自决定；本文件中的接口、格式、签名不许单方面更改。

## 地盘划分（互不越界）

| 开发方 | 拥有目录/文件 | 职责 | 不许碰 |
|---|---|---|---|
| **Coding Agent A（收集层）** | `collector/`（除 kb.mjs、llm.mjs 外的部分）、`simulator/`、`docs/`、`README.md` | 企微回调、验签解密、消息分流、入库、回执、提问转发、部署教程 | `librarian/`、`shared-knowledge/`、共享模块 |
| **Coding Agent B（知识库层）** | `librarian/`、`wiki/`（运行时生成） | 问答逻辑、Wiki 编译、每日摘要、每周巡检、Schema/SKILL 规则 | `collector/`、`shared-knowledge/`、共享模块 |
| **协调者（已写好，双方只读使用）** | `CONTRACT.md`、`.env.example`、`collector/src/kb.mjs`、`collector/src/llm.mjs` | 契约与共享客户端 | —— |
| **冻结不动** | `shared-knowledge/`（team-app 内核） | 原始记录存储、检索、生命周期 | —— |

## 知识内核 HTTP API（team-app 提供，现状冻结）

内核启动（仅本机，无鉴权的开发模式）：
```bash
TEAM_LOCAL_VALIDATION=1 TEAM_DB=<临时目录>/team.sqlite TEAM_PORT=<端口> node shared-knowledge/team-app/src/server.mjs
```

- `POST /api/records` 请求体 `{text, changes: [], idempotency?, occurred_at?}` → 返回记录对象（含 `id` 字段）
  - text 上限 20000 字符；同一 author 下 idempotency 唯一（重复提交返回旧记录不报错）
- `POST /api/search` `{query, limit?, depth?, strategy?}` → 证据列表（元素含 `id`/`text`/`author`/`occurred_at`）
- `POST /api/get-records` `{ids: [...]}` → 完整记录
- `GET /api/records` → 全部记录（按 occurred_at 排序）
- `GET /api/state` → 事项当前状态投影

## 记录文本约定（A 写、B 读）

- A 入库时文本头部格式：`【作者:<企微userId>】【来源:<企微|企微语音|企微图片>】<正文>`
- 幂等键格式：`wecom:<MsgId>`

## 模块签名契约（双方必须严格遵守）

**协调者提供（已实现，直接 import）：**
- `collector/src/kb.mjs` → `new KnowledgeBase(baseUrl?)`，方法：`save({text, idempotency?, occurredAt?})`、`search(query, {limit?, depth?, strategy?}?)`、`getRecords(ids)`、`records()`、`state()`，全部返回 Promise
- `collector/src/llm.mjs` → `new LLM()`（读环境变量 `KB_LLM_BASE_URL/KB_LLM_API_KEY/KB_LLM_MODEL`），属性 `configured`（boolean），方法 `chat(messages, {maxTokens?}?) → Promise<string|null>`（未配置或失败返回 null）

**Agent B 提供（A 会 import，签名不得更改）：**
- `librarian/scripts/answer.mjs`：
  - `answerQuestion(kb, llm, question) → Promise<string>`（检索→LLM 组织带 [#短ID] 引用的答案；无证据或无 LLM 时降级为证据列表/提示语，永不抛异常）
  - `extractAuthor(text) → string|undefined`（从文本头部解析作者）
  - `stripHeader(text) → string`（去掉头部元信息）
- `librarian/scripts/router.mjs`：
  - `route(text) → {kind}`，kind ∈ `note`(带text) | `question`(带question) | `help` | `retract`(带recordId) | `ignore`
  - `HELP_TEXT: string`

## 并行开发的防冲突约定（重要）

两个 Agent 在同一台机器同时工作，**自测时必须使用各自的端口和临时目录**：
- Agent A 自测：内核端口 5281，采集服务端口 9200，DB 目录 `/tmp/kb-test-a/`
- Agent B 自测：内核端口 5381，DB 目录 `/tmp/kb-test-b/`
- 标准端口（5181/9100）留给协调者做集成验收，谁都不许占用
- 自测起的服务进程，测完必须杀掉，不许留在后台

## 集成验收清单（协调者执行，全绿才算完成）

1. 模拟器 URL 验证通过（GET）
2. 模拟投喂 → 回执含 `#短ID`，内核中出现对应记录（含【作者】头部）
3. 模拟提问 → 回执"正在查"；CLI 问答返回带编号证据
4. compile / digest / lint 冒烟通过（无 LLM 时优雅降级，不报错崩溃）
