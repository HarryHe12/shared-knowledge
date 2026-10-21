# 本地知识服务

默认通过 Skill 使用唯一知识库，无网页。后端、存取客户端和 Skill 入口均保存在本项目。需要仓库依赖和 Node >=22.19；SQLite 使用 Node 内置 node:sqlite。

## 启动与身份

功能验证阶段直接运行 `npm run dev`，无需创建用户、配置个人令牌或手动授权。服务自动使用固定的“本地验证用户”，授予默认库访问权限；重启后沿用同一作者，重试写入仍按幂等键去重。已有用户和记录保留。

只监听 `127.0.0.1:5181`，`/` 返回 JSON 404。需要恢复个人令牌与成员权限校验时，以 `TEAM_AUTH_REQUIRED=1 npm run dev` 启动，并配置用户：

```bash
TEAM_USER_TOKEN='<至少24字符的个人随机令牌>' node team-app/src/server.mjs create-user '成员名'
```

令牌只保存哈希；旧用户默认库没有权限时，由管理员执行 `node team-app/src/server.mjs grant '<默认库ID>' '<用户ID>'`。跨库限制、来源检查和输入校验在免令牌模式仍生效。

空目录的新库固定在 `team-app/.data/team.sqlite`；`.data/` 已有唯一 `.sqlite` 文件时自动沿用，多个文件时要求 `TEAM_DB` 明确选择，不受启动目录影响（旧版根目录 `node` 与 npm workspace 启动可能分别产生两个 `.data` 位置，升级前请检查并用 TEAM_DB 指定已有库，不自动合并）。`TEAM_DB` 可覆盖路径，相对路径按 team-app 目录解析。备份时停止服务再复制数据库。空库自动创建默认库，唯一旧项目自动沿用；有多个旧项目时必须先设置 `TEAM_DEFAULT_PROJECT_ID`。选择会持久化，后续不允许环境变量切换默认库；其他项目数据保留但不通过服务暴露。

## Skill 与客户端

入口是 [skill/SKILL.md](skill/SKILL.md)，客户端是 [scripts/knowledge.mjs](scripts/knowledge.mjs)。Skill 的存取实现以仓库脚本为准，不在安装目录另存一份业务逻辑。可在 AI 宿主中加载该入口；若安装宿主入口，保留指向本仓库客户端的路径。

客户端可不带令牌运行；默认令牌文件 `team-app/.data/token` 不存在时直接发送免令牌请求。启用鉴权后，客户端默认读取该文件；也可在自己的终端设置 `TEAM_KB_TOKEN_FILE` 指向权限0600的个人令牌文件；也支持 `TEAM_KB_TOKEN`。可用 `TEAM_KB_URL` 指定另一个本机端口，不允许外部地址或重定向。

```bash
node team-app/scripts/knowledge.mjs save --file /path/to/record.txt --idempotency '<本次写入唯一标识>'
node team-app/scripts/knowledge.mjs snapshot
node team-app/scripts/knowledge.mjs search --query '目前进展和阻塞'
node team-app/scripts/knowledge.mjs get --ids '<ID>,<ID>'
node team-app/scripts/knowledge.mjs state
```

保存原文默认不提取事项。需要时先 `extract --file FILE`，用户确认草稿后，将 changes 数组存为 JSON，再 `save --file FILE --changes-file JSON --idempotency KEY`。相同写入重试复用幂等标识；不自动重试。`snapshot` 的原文和事项是两次读取，不保证并发时原子一致。

接口：`GET /api/default`、`GET/POST /api/records`、`GET /api/items`、`GET /api/timeline?item=ID`、`POST /api/extract`、`POST /api/search`、`POST /api/get-records`、`GET /api/state`。兼容旧 `/api/projects/:默认库ID/*` 路径，`GET /api/projects` 仅返回默认库，禁止 HTTP 新建库或跨库访问。

## 模型与检索

可选提取复用 `~/.pi/agent/auth.json` 和模型注册表；默认 `kimi-coding/k3`，用 `TEAM_PROVIDER`、`TEAM_MODEL` 改选。应用配置和数据库不存模型密钥。提取草稿经用户确认才落库；直接保存空事项列表只保存原始记录。

默认中文分词 + SQLite FTS5 BM25 + 项目全部事项当前状态证据。可选接入：

- `TEAM_EMBEDDING_URL`：完整 embeddings POST 地址；`TEAM_EMBEDDING_MODEL`；`TEAM_EMBEDDING_KEY`。协议为 `{model,input}` → `{data:[{embedding:[]} ]}`。
- `TEAM_RERANK_URL`：完整 rerank POST 地址；`TEAM_RERANK_MODEL`；`TEAM_RERANK_KEY`。协议为 `{model,query,documents,top_n}` → `{results:[{index,relevance_score}]}`，按返回顺序使用。

向量缓存持久化，按项目、端点、模型和文本散列隔离；查询进行精确余弦扫描、与 BM25 做 RRF 融合。首次查询会依次为本项目记录建立缓存，适合小规模验证；后台预索引、批处理及 ANN 尚未实现。服务配置错误会显式失败，不伪装成成功启用。外部服务会接收到本次用户有权访问的项目文本。

## 重要边界

这是可运行的纵向原型，未作为生产多人系统验收。尚无令牌撤销、成员管理界面、审计导出、附件、自动纠错/重建、长期会话指代、跨项目全局汇总。当前事项完整覆盖只指已确认结构化事项；未经提取的原始文字只能通过检索访问。项目内容很多时缺少分层汇总与模型上下文预算，需要限制试用规模。

运行 `npm run test:team`。测试覆盖权限、晚到事件、重开、事务/幂等、中文检索、补查证据、向量与重排适配；真实模型及真实向量服务结果以验收清单为准。

## 同题模型对比

配置模板为 `.env.retrieval.example`，完整步骤、指标定义和当前结果见 [eval/README.md](eval/README.md)。支持显式 `TEAM_RETRIEVAL_MODE=bm25|vector|hybrid|hybrid-rerank`。只有配置并成功调用真实服务后，才能算真实模型验收。

## 证据工具与 Agent 分工

search 接受 query、limit（1—40，默认15）、strategy（hybrid 或 exact）和 depth（0—2，默认1）。hybrid 使用配置的检索模式并合并引用候选；exact 只做实体/编号展开。返回原文、作者、时间、范围和覆盖信息，不生成答案。coverage.exhaustive 始终为 false，truncated 只表示合并候选被 limit 截断，corpus_not_returned 表示未返回的库内记录数；这些不代表语义置信度或相关记录总数。

get-records 接受1—40个 ids，返回当前范围内记录及 unavailable_ids；state 返回已登记事项的最新状态和来源记录。宿主 Agent 根据证据补查、澄清并回答，在当前对话维护上下文。生成模型按需加载，服务启动和证据查询不依赖生成模型；embedding/rerank 仍按配置调用。

默认 /api/ask 返回410，不创建服务端澄清会话。旧客户端 ask/reply 仅为迁移兼容保留，显式设置 TEAM_LEGACY_ASK=1 才开启历史循环。已有澄清数据不删除。历史58次试验只验证旧循环，不能代表新宿主 Agent 的端到端表现。

本轮31项测试通过，覆盖真实本机HTTP与客户端存取、默认关闭问答、证据范围、状态来源和已有检索/循环回归。独立宿主端到端留出集验收尚未完成。
