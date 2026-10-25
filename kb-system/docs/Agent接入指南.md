# 电脑 Agent 接入

Codex、Claude Code、Workbuddy 等共用知识服务，调用权限属于实际员工，不属于 Agent 名称。推荐加载仓库的 [shared-knowledge Skill](../../team-app/skill/SKILL.md)，或使用 [共享 SDK](../../team-app/client/knowledge-client.mjs)。

## 员工连接

```bash
node team-app/scripts/knowledge.mjs login --url https://kb.example.test
node team-app/scripts/knowledge.mjs whoami
node team-app/scripts/knowledge.mjs use-scope --scope '<获准范围ID>'
```

在浏览器核对设备码、登录并确认设备；账号需经审批、加入公司及岗位授权。凭证保存在受支持的系统凭据存储，不能把其他员工会话或公司桥接密钥发给 Agent。服务地址和范围可保存，密码不进入命令参数。

现有 Skill 按单范围调用 search/get/state，由宿主 Agent 组织证据回答。新 SDK/API 可显式汇总同公司内全部获准范围，并提供私有聊天、幂等发送、轮询和记录生命周期操作。复杂任务读取同样要经过权限，不允许直接读取 SQLite 或共享 Wiki 文件绕过服务。

## 兼容采集端 Agent 网关

- `GET /agent/ping`：当前员工和获准范围。
- `POST /agent/feed`：保存 `{text,idempotency,occurredAt?}`，或通过 `Idempotency-Key` 提供稳定标识。
- `POST /agent/search`：检索 `{query,limit?}`。
- `POST /agent/ask`：问答 `{question}`。

所有请求必须携带员工 `Authorization: Bearer ...`，后三个接口还需 `X-Knowledge-Scope`。如额外启用 `AGENT_API_KEYS=name:key,...`，通过 `X-Agent-Key` 传递网关凭据；它不能代替员工 Bearer。

旧版把应用密钥当 Bearer、把 author 字段当员工身份的调用方式已停用，需要迁移。写入重试复用原幂等标识，不能重复生成新标识。详细 API 和未来小程序接入见 [服务说明](../../team-app/README.md)。
