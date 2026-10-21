# 本地知识服务

默认通过 Skill 使用唯一知识库，无网页。后端、存取客户端和 Skill 入口均保存在本项目。需要仓库依赖和 Node >=22.19；SQLite 使用 Node 内置 node:sqlite。

## 启动与身份

首次在终端设置至少24字符的个人随机令牌，并创建用户；用户自动获得默认库权限。令牌只保存哈希，不要发进聊天。

```bash
TEAM_USER_TOKEN='<个人随机令牌>' node team-app/src/server.mjs create-user '成员名'
npm run dev
```

默认启动会读取已有 `team-app/.env.retrieval`（若存在），保留本地 embedding/rerank 配置。只监听 `127.0.0.1:5181`，`/` 返回 JSON 404；所有知识接口都需要个人令牌。旧用户保留已有权限；默认库没有权限时，由管理员执行 `node team-app/src/server.mjs grant '<默认库ID>' '<用户ID>'`。

空目录的新库固定在 `team-app/.data/team.sqlite`；`.data/` 已有唯一 `.sqlite` 文件时自动沿用，多个文件时要求 `TEAM_DB` 明确选择，不受启动目录影响（旧版根目录 `node` 与 npm workspace 启动可能分别产生两个 `.data` 位置，升级前请检查并用 TEAM_DB 指定已有库，不自动合并）。`TEAM_DB` 可覆盖路径，相对路径按 team-app 目录解析。备份时停止服务再复制数据库。空库自动创建默认库，唯一旧项目自动沿用；有多个旧项目时必须先设置 `TEAM_DEFAULT_PROJECT_ID`。选择会持久化，后续不允许环境变量切换默认库；其他项目数据保留但不通过服务暴露。

## Skill 与客户端

入口是 [skill/SKILL.md](skill/SKILL.md)，客户端是 [scripts/knowledge.mjs](scripts/knowledge.mjs)。Skill 的存取实现以仓库脚本为准，不在安装目录另存一份业务逻辑。可在 AI 宿主中加载该入口；若安装宿主入口，保留指向本仓库客户端的路径。

客户端默认读取 `team-app/.data/token`；也可在自己的终端设置 `TEAM_KB_TOKEN_FILE` 指向权限0600的个人令牌文件；也支持 `TEAM_KB_TOKEN`。可用 `TEAM_KB_URL` 指定另一个本机端口，不允许外部地址或重定向。

```bash
node team-app/scripts/knowledge.mjs save --file /path/to/record.txt --idempotency '<本次写入唯一标识>'
node team-app/scripts/knowledge.mjs snapshot
node team-app/scripts/knowledge.mjs ask --question '目前的进展和阻塞是什么？'
node team-app/scripts/knowledge.mjs reply --clarification-id '<ID>' --reply '我的判断标准'
```

保存原文默认不提取事项。需要时先 `extract --file FILE`，用户确认草稿后，将 changes 数组存为 JSON，再 `save --file FILE --changes-file JSON --idempotency KEY`。相同写入重试复用幂等标识；不自动重试。`snapshot` 的原文和事项是两次读取，不保证并发时原子一致。

接口：`GET /api/default`、`GET/POST /api/records`、`GET /api/items`、`GET /api/timeline?item=ID`、`POST /api/extract`、`POST /api/ask`。兼容旧 `/api/projects/:默认库ID/*` 路径，`GET /api/projects` 仅返回默认库，禁止 HTTP 新建库或跨库访问。

## 模型与检索

问答、提取复用 `~/.pi/agent/auth.json` 和模型注册表；默认 `kimi-coding/k3`，用 `TEAM_PROVIDER`、`TEAM_MODEL` 改选。应用配置和数据库不存模型密钥。提取草稿经用户确认才落库；直接保存空事项列表只保存原始记录。

默认中文分词 + SQLite FTS5 BM25 + 项目全部事项当前状态证据。可选接入：

- `TEAM_EMBEDDING_URL`：完整 embeddings POST 地址；`TEAM_EMBEDDING_MODEL`；`TEAM_EMBEDDING_KEY`。协议为 `{model,input}` → `{data:[{embedding:[]} ]}`。
- `TEAM_RERANK_URL`：完整 rerank POST 地址；`TEAM_RERANK_MODEL`；`TEAM_RERANK_KEY`。协议为 `{model,query,documents,top_n}` → `{results:[{index,relevance_score}]}`，按返回顺序使用。

向量缓存持久化，按项目、端点、模型和文本散列隔离；查询进行精确余弦扫描、与 BM25 做 RRF 融合。首次查询会依次为本项目记录建立缓存，适合小规模验证；后台预索引、批处理及 ANN 尚未实现。服务配置错误会显式失败，不伪装成成功启用。外部服务会接收到本次用户有权访问的项目文本。

问答最多三次模型调用、两次关键词补查，引用必须属于统一证据集合。超时/无效模型结果会报错，不返回无依据答案。引用 ID 校验不等于语义事实已被验证。

## 重要边界

这是可运行的纵向原型，未作为生产多人系统验收。尚无令牌撤销、成员管理界面、审计导出、附件、自动纠错/重建、长期会话指代、跨项目全局汇总。当前事项完整覆盖只指已确认结构化事项；未经提取的原始文字只能通过检索访问。项目内容很多时缺少分层汇总与模型上下文预算，需要限制试用规模。

运行 `npm run test:team`。测试覆盖权限、晚到事件、重开、事务/幂等、中文检索、补查证据、向量与重排适配；真实模型及真实向量服务结果以验收清单为准。

## 同题模型对比

配置模板为 `.env.retrieval.example`，完整步骤、指标定义和当前结果见 [eval/README.md](eval/README.md)。支持显式 `TEAM_RETRIEVAL_MODE=bm25|vector|hybrid|hybrid-rerank`。只有配置并成功调用真实服务后，才能算真实模型验收。

## 查询循环与用户澄清

`ask` 接口现在返回 `answered`、`insufficient` 或 `needs_clarification`。模型在每轮选择补查、澄清或回答，最多三次调用；补查同样走已配置的混合召回与rerank。返回候选答案前检查格式、引用ID及证据要求；不合法的输出在剩余预算内自行修正。

需要用户才能确定的对象/时间/评价标准，返回一个具体问题、最多三个选项，Skill 呈现选项并接收自由输入。用户回复通过 `clarification_id` 与 `reply` 提交，服务端保留原问题和已澄清条件，重新检索后续答。不会把空检索、服务错误都解释成用户表达不清。

澄清状态存在独立数据库表，绑定用户和项目；30分钟有效，成功使用后不可重复提交，最多两次澄清（最多三段查询、九次模型调用）。服务失败允许重试。Skill 应保留并传回 clarification_id；过期待澄清数据尚未自动清理。语义充分性与何时澄清主要由模型判断，程序只做结构和引用检查，尚无独立事实验证器。

工作场景循环测试、固定输入和已知失败见 [扩展验收报告](eval/loop-scenarios/REPORT-20261021.md)。

## 查询策略可靠性修正

- 明确提到另一个有权项目的名称且当前范围不同：返回范围限制，不读取其他项目内容，不要求再次确认名字。该程序规则仅使用调用者可见的项目目录；未知名称仍需模型判断，不能宣称覆盖所有名称歧义。
- 每轮提供项目记录总数、当前证据数和非穷尽标记；缺少关键指标时可以先补查。程序对未限定范围的缺失声明作措辞检查，要求修正或继续查；预算耗尽仍不可靠则说明本轮证据不足。该检查是启发式，不能替代独立事实验证。
- 补查将混合结果与低频词/中文二元片段/明确引用编号匹配合并，补充一跳引用记录。重复词集合或上轮零新增时改用精确匹配及两跳编号展开，不再对相近通用词重复发起相同检索层请求。
- 精确补查额外记录最多12条、种子最多4条，始终限制在当前项目；每段仍最多3次模型调用、2次补查（包括模型主动列出的缺口），最多2次用户澄清。

对高置信的“我之前定的标准”“我关心的周期”“我打算投的钱”等未给值条件，第一轮由程序先询问；已明确提供标准、日期或金额时不触发。普通进度总结、公开验收门槛和通用转发草稿不应因此被强制追问。复杂隐含条件仍由模型判断。
