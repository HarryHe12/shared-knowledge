# 本地知识存取

通过 shared-knowledge Skill 存取知识；网页用于首次注册登录和管理员审批授权。

## 功能

- 注册与登录独立切换，提供审批步骤、填写提示和移动端布局。

- 自主注册、后台审批、按知识范围授予只读/可提交权限，支持账号停用、设备撤销与审计。
- macOS 客户端通过设备码连接，登录凭证保存在系统钥匙串。

- 保存原始工作记录，支持幂等写入、版本纠错、撤回恢复及彻底删除。
- 提取事项草稿，经用户确认后保存。
- 提供混合检索、精确引用展开和状态证据，由调用方 Agent 补查、澄清并回答。
- 读取记录、事项、状态历史并总结。

## 使用

需要 Node >=22.19 与 npm。运行 `npm ci`，再运行 `npm run dev`。

在 AI 宿主中加载 [Skill 入口](team-app/skill/SKILL.md)。默认只监听 127.0.0.1:5181，正式模式必须登录；首次运行先初始化管理员，步骤见服务说明。
客户端位于 [knowledge.mjs](team-app/scripts/knowledge.mjs)，数据库默认在 `team-app/.data/team.sqlite`。配置、模型凭证与权限边界见 [服务说明](team-app/README.md)。

## 开发

运行 `npm run test:team` 或 `npm run quality-and-tests`。
维护 team-app 后端、客户端、Skill，以及账号/管理页面；已有外部知识文件与本地数据库保留。
