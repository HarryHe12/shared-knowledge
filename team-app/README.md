# 本地知识服务

通过 Skill 使用授权知识范围，网页仅用于账号和管理。后端、存取客户端和 Skill 入口均保存在本项目。需要仓库依赖和 Node >=22.19；SQLite 使用 Node 内置 node:sqlite。

## 启动与身份

第一版采用自主注册、管理员人工核实身份后审批。网页 `/account` 用于注册登录和设备确认，`/admin` 用于审批、范围授权、成员停用、设备撤销和审计。邮箱暂未自动验证，管理员应通过组织通讯录或线下确认身份后批准；界面不会将填写邮箱视为已验证。

首次部署由运维在服务所在机器运行：

```bash
node team-app/src/server.mjs bootstrap-admin
npm run dev
```

初始化交互输入姓名、邮箱和密码（不回显，至少12字符）；已存在管理员时拒绝再次初始化。服务端使用随机盐 scrypt 保存密码，不保存明文。初始管理员仅有管理权，没有业务阅读权，需在后台明确授予范围权限。

正式服务默认强制登录，旧个人令牌不能登录正式 HTTP 服务。仅本机开发可显式 `TEAM_LOCAL_VALIDATION=1 npm run dev`，所有请求共用验证作者，不得用于团队部署。`TEAM_AUTH_REQUIRED` 已由此显式验证开关替代。

员工执行 `node team-app/scripts/knowledge.mjs login --url https://kb.example.test`，打开返回链接，注册/登录后确认设备码。注册状态为 pending，审批后 approved；拒绝为 rejected，停用为 disabled。客户端再次 login 领取会话。设备请求10分钟有效，审批较慢时重新 login 获取新码并登录确认，无需重注册。设备会话空闲30天到期，日常请求自动续期，最长90天重新连接；可主动退出或管理员随时撤销。macOS 凭据写入系统钥匙串，Windows 写入当前用户的 Windows 凭据管理器，配置文件只保存服务地址与范围，不存密码或令牌。Windows 使用系统自带 PowerShell 调用原生凭据接口，无需手写配置或安装模块；企业策略禁止 PowerShell/原生调用时明确失败，不回退明文保存。Linux 自动登录适配尚未实现。

`whoami` 显示身份与授权范围；`use-scope --scope ID` 选择范围；`logout` 撤销当前设备会话。不同范围分别查询，不做隐式跨范围汇总。第一版直接对用户授权；部门是申请信息，不自动授予权限，用户组批量授权尚未实现。

远程部署在受控服务器保存数据库，通过 HTTPS 反向代理访问；设置 `TEAM_PUBLIC_URL=https://kb.example.test`，代理保留原始 Host。需要容器监听时设置 `TEAM_HOST=0.0.0.0`，仅允许代理访问内部端口。服务不自行签发证书。客户端只允许远程 HTTPS 或本机 HTTP，拒绝重定向。注册/登录按来源地址限流；反向代理后也应配置入口限流。生产使用前仍需完成部署、邮件验证及系统凭据适配的验收。

审批与授权相互独立：approved 但没有范围授权仍不可读写。范围 reader 只读；writer 可提交、提取草稿和更改本人记录。管理权限不隐含业务权限。每个范围复用独立 project ID，原默认库保持原ID；后台只显式登记原默认库和新建范围，不自动暴露其他旧项目。新账号没有旧库权限，旧记录作者不自动改写或合并。

空目录的新库固定在 `team-app/.data/team.sqlite`；`.data/` 已有唯一 `.sqlite` 文件时自动沿用，多个文件时要求 `TEAM_DB` 明确选择，不受启动目录影响（旧版根目录 `node` 与 npm workspace 启动可能分别产生两个 `.data` 位置，升级前请检查并用 TEAM_DB 指定已有库，不自动合并）。`TEAM_DB` 可覆盖路径，相对路径按 team-app 目录解析。备份时停止服务再复制数据库。空库自动创建默认库，唯一旧项目自动沿用；有多个旧项目时必须先设置 `TEAM_DEFAULT_PROJECT_ID`。选择会持久化，后续不允许环境变量切换默认库；其他项目数据保留但不通过服务暴露。

## Skill 与客户端

入口是 [skill/SKILL.md](skill/SKILL.md)，客户端是 [scripts/knowledge.mjs](scripts/knowledge.mjs)。Skill 的存取实现以仓库脚本为准，不在安装目录另存一份业务逻辑。可在 AI 宿主中加载该入口；若安装宿主入口，保留指向本仓库客户端的路径。

客户端默认使用系统钥匙串会话。旧 `TEAM_KB_TOKEN` / token-file 参数仅供显式开启 legacyTokens 的测试适配器；正式服务不接受旧个人令牌，不要再手工配置令牌。服务地址与范围可通过 login/use-scope 自动记住。

```bash
node team-app/scripts/knowledge.mjs save --file /path/to/record.txt --idempotency '<本次写入唯一标识>'
node team-app/scripts/knowledge.mjs snapshot
node team-app/scripts/knowledge.mjs search --query '目前进展和阻塞'
node team-app/scripts/knowledge.mjs get --ids '<ID>,<ID>'
node team-app/scripts/knowledge.mjs state
```

保存原文默认不提取事项。需要时先 `extract --file FILE`，用户确认草稿后，将 changes 数组存为 JSON，再 `save --file FILE --changes-file JSON --idempotency KEY`。相同写入重试复用幂等标识；不自动重试。`snapshot` 的原文和事项是两次读取，不保证并发时原子一致。

接口：`GET /api/default`、`GET/POST /api/records`、`GET /api/items`、`GET /api/timeline?item=ID`、`POST /api/extract`、`POST /api/search`、`POST /api/get-records`、`GET /api/state`。兼容旧 `/api/projects/:默认库ID/*` 路径，`GET /api/projects` 仅返回默认库，普通业务接口禁止新建库，范围由管理员后台建立，跨范围请求必须具备对应授权。

## 模型与检索

可选提取复用 `~/.pi/agent/auth.json` 和模型注册表；默认 `kimi-coding/k3`，用 `TEAM_PROVIDER`、`TEAM_MODEL` 改选。应用配置和数据库不存模型密钥。提取草稿经用户确认才落库；直接保存空事项列表只保存原始记录。

默认中文分词 + SQLite FTS5 BM25 + 项目全部事项当前状态证据。可选接入：

- `TEAM_EMBEDDING_URL`：完整 embeddings POST 地址；`TEAM_EMBEDDING_MODEL`；`TEAM_EMBEDDING_KEY`。协议为 `{model,input}` → `{data:[{embedding:[]} ]}`。
- `TEAM_RERANK_URL`：完整 rerank POST 地址；`TEAM_RERANK_MODEL`；`TEAM_RERANK_KEY`。协议为 `{model,query,documents,top_n}` → `{results:[{index,relevance_score}]}`，按返回顺序使用。

向量缓存持久化，按项目、端点、模型和文本散列隔离；查询进行精确余弦扫描、与 BM25 做 RRF 融合。首次查询会依次为本项目记录建立缓存，适合小规模验证；后台预索引、批处理及 ANN 尚未实现。服务配置错误会显式失败，不伪装成成功启用。外部服务会接收到本次用户有权访问的项目文本。

## 重要边界

这是可运行的纵向原型，未作为生产多人系统验收。已支持会话撤销与成员管理；尚无审计导出、附件、自动纠错/重建、长期会话指代、跨项目全局汇总。当前事项完整覆盖只指已确认结构化事项；未经提取的原始文字只能通过检索访问。项目内容很多时缺少分层汇总与模型上下文预算，需要限制试用规模。

运行 `npm run test:team`。测试覆盖权限、晚到事件、重开、事务/幂等、中文检索、补查证据、向量与重排适配；真实模型及真实向量服务结果以验收清单为准。

## 同题模型对比

配置模板为 `.env.retrieval.example`，完整步骤、指标定义和当前结果见 [eval/README.md](eval/README.md)。支持显式 `TEAM_RETRIEVAL_MODE=bm25|vector|hybrid|hybrid-rerank`。只有配置并成功调用真实服务后，才能算真实模型验收。

## 证据工具与 Agent 分工

search 接受 query、limit（1—40，默认15）、strategy（hybrid 或 exact）和 depth（0—2，默认1）。hybrid 使用配置的检索模式并合并引用候选；exact 只做实体/编号展开。返回原文、作者、时间、范围和覆盖信息，不生成答案。coverage.exhaustive 始终为 false，truncated 只表示合并候选被 limit 截断，corpus_not_returned 表示未返回的库内记录数；这些不代表语义置信度或相关记录总数。

get-records 接受1—40个 ids，返回当前范围内记录及 unavailable_ids；state 返回已登记事项的最新状态和来源记录。宿主 Agent 根据证据补查、澄清并回答，在当前对话维护上下文。生成模型按需加载，服务启动和证据查询不依赖生成模型；embedding/rerank 仍按配置调用。

默认 /api/ask 返回410，不创建服务端澄清会话。旧客户端 ask/reply 仅为迁移兼容保留，显式设置 TEAM_LEGACY_ASK=1 才开启历史循环。已有澄清数据不删除。历史58次试验只验证旧循环，不能代表新宿主 Agent 的端到端表现。

本轮31项测试通过，覆盖真实本机HTTP与客户端存取、默认关闭问答、证据范围、状态来源和已有检索/循环回归。独立宿主端到端留出集验收尚未完成。

## 更改与删除

客户端增加 `correct --id ID --version N --file FILE [--changes-file JSON] [--occurred-at ISO]`、`withdraw/restore/purge --id ID --version N`、`history --id ID`。对应 POST /api/correct、/api/withdraw、/api/restore、/api/purge 与 GET /api/record-history?id=ID。get/records 返回 version；history 可读取撤回状态。仅原作者可修改或删除，项目有权成员可查历史；默认免令牌模式所有请求共用验证作者，不适合多人权限验证。

纠错保留原记录ID和录入时间，默认保持发生时间，保存旧原文及旧事件快照。correct 是完整替代：原记录含事项时必须显式提供完整 changes，空数组撤销该记录全部事项，保留事项关联需沿用 item_id。正常业务进展继续 save 追加；版本变化返回409，失败或响应丢失后先读 history，不盲目重试。

撤回记录从默认 records/get、全文、向量、精确展开和状态历史中排除，restore 后恢复当前版本。当前事项由剩余有效事件重新计算，零来源事项不出现在 state；旧来源回退不代表现实已恢复。历史接口显式可读旧版本。

purge 清除该记录正文、事件、修订版本、全文索引及无剩余事件事项，清空共享向量缓存和本项目旧澄清会话。幂等键仅保留哈希墓碑，防止重试复活已删除记录。历史ID会失效；不清理其他独立记录中人工重复抄录的相同文本。没有摘要层，因此目前无自动摘要重建。

彻底删除指活动应用数据库中的逻辑内容清除；开启 SQLite secure_delete，但不承诺清除外部备份、文件系统历史、既有WAL副本、外部模型服务已接收的数据或宿主对话。敏感资料的介质级清除需要独立流程。向量缓存缺少记录映射，现阶段保守清空整表，下次检索重建，存在额外请求成本。记录修改期间在途检索返回409，避免使用旧证据或重新写入旧缓存。
