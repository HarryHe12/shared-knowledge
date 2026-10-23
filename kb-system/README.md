# 团队知识库系统（kb-system）

员工在企业微信里随手发消息给机器人，机器人把内容存进知识库内核；员工也可以随时向它提问，答案自动推送回来。

## 当前状态（2026-10-23）

已上线运行，部署在腾讯云（systemd：`kb-core` 内核 + `kb-collector` 采集服务，nginx + HTTPS 回调）。

- ✅ 企业微信自建应用采集：投喂入库、回执、提问异步推送答案
- ✅ 微信插件：同事在个人微信里即可投喂和提问，与企业微信数据互通
- ✅ 意图自动识别：口语消息自动区分 投喂 / 提问 / 闲聊，提问和闲聊不会误入知识库
- ✅ 口语化提问：支持"昨天""上周"等相对日期、中文人名自动对照作者 ID，回答为自然口吻
- ✅ 每日摘要（08:13 推送管理员）、Wiki 自动编译（每 4 小时）、每周巡检

## 架构

```
┌──────────┐   发消息/提问    ┌─────────────┐
│  企业微信  │ ◄────────────► │  企业微信后台  │
│ (员工手机) │   回执/答案推送  │             │
└──────────┘                 └──────┬──────┘
                                    │ HTTPS 回调（加密+验签）
                                    ▼
                          ┌───────────────────┐
                          │ collector 采集服务  │  验签/解密/分流/入库/回执
                          │  (本项目, :9100)   │
                          └────────┬──────────┘
                                   │ HTTP
                                   ▼
                          ┌───────────────────┐
                          │ team-app 知识库内核 │  原始记录存储/检索/生命周期
                          │ (shared-knowledge, │  （冻结，不可修改）
                          │      :5181)       │
                          └────────┬──────────┘
                                   ▲
                                   │ HTTP（读取/检索）
                          ┌────────┴──────────┐
                          │ librarian 知识库层  │  问答/Wiki 编译/每日摘要/巡检
                          │  (Agent B 并行开发) │
                          └───────────────────┘
```

- **collector/**（本目录）：企业微信回调采集服务。验签解密 → 消息分流 → 投喂入库 → 被动回执；提问异步转给 librarian 回答后用应用消息推送。
- **simulator/**：本地模拟器，假装企业微信服务器发加密回调，不依赖真实企微即可联调。
- **librarian/**：知识库层（问答、编译、摘要、巡检），由另一个 Agent 开发。
- **shared-knowledge/team-app/**：知识库内核，**冻结不可改**。能力见它的 README。
- **docs/**：面向管理员的部署配置教程。
- **CONTRACT.md / .env.example**：开发契约与环境变量清单（冻结）。

## 快速开始（本地试跑，无需真实企业微信）

需要 Node.js ≥ 22.19。

```bash
# 1. 启动知识库内核（本地验证模式，数据放临时目录）
TEAM_LOCAL_VALIDATION=1 TEAM_DB=/tmp/kb-demo/team.sqlite TEAM_PORT=5181 \
  node shared-knowledge/team-app/src/server.mjs

# 2. 另开一个终端，启动采集服务（开发默认 Token/AESKey，无需任何企微配置）
cd kb-system/collector
npm start          # 监听 0.0.0.0:9100

# 3. 再开一个终端，用模拟器假装企微发消息
cd kb-system
node simulator/send.mjs --verify                          # URL 验证（GET）
node simulator/send.mjs --user zhangsan --text "会议纪要：Q3 目标提前两周完成"
node simulator/send.mjs --user lisi --text "问：Q3 目标进展如何？"   # 提问（需 librarian 就位）
node simulator/send.mjs --user zhangsan --text "帮助"
```

投喂成功会收到回执 `已收录 #xxxxxxxx ✅`，记录同时出现在内核里（`curl http://127.0.0.1:5181/api/records` 可见，文本头部带 `【作者:zhangsan】【来源:企微】`）。

模拟器与采集服务使用同一套开发默认值（`dev-token` / 43 位假 AESKey / `ww-dev-corp`），可用 `WECOM_TOKEN` / `WECOM_ENCODING_AES_KEY` / `WECOM_CORP_ID` 环境变量覆盖。

## 部署（pm2）

```bash
cd kb-system
cp .env.example .env   # 填好企业微信五项 + KB_URL，按需填 LLM 三项

# 内核
TEAM_PORT=5181 pm2 start ../shared-knowledge/team-app/src/server.mjs --name kb-kernel
# 采集服务
pm2 start collector/src/server.mjs --name kb-collector --update-env
pm2 save && pm2 startup   # 开机自启
```

企业微信后台配置（回调 URL、可信 IP、nginx、定时任务）见 [docs/企业微信配置教程.md](docs/企业微信配置教程.md)。

## 当前边界（诚实清单）

- **本地验证模式下作者只存文本头部**：`TEAM_LOCAL_VALIDATION=1` 时内核所有请求共用一个验证作者，作者身份只是写在文本头部的 `【作者:xxx】`，没有内核级权限隔离。多人正式使用需要按 team-app README 部署完整身份体系。
- **图片只存占位**：入库内容是 `[图片] <PicUrl>`，不做 OCR（即将上线）。
- **语音依赖企微转文字**：识别结果走企微「语音转文字」能力；未开启时只存占位文本。
- **群内 @ 机器人提问的能力视企业微信版本/权限而定**：当前只保证「应用私聊」场景；群聊机器人（webhook 机器人）只能发不能收，属于企微平台限制。
- **单条记录上限 20000 字符**（内核限制），超出会被拒绝。
- **撤回需要管理员操作**：员工发「撤回」只会收到指引话术，真正的撤回/删除走内核的管理端能力。
- 无 LLM 时问答降级为证据列表，不报错崩溃。
