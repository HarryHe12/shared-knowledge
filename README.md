# 本地知识存取

通过一个 shared-knowledge Skill 使用本地知识服务，不提供网页端。

## 功能

- 保存原始工作记录，支持幂等写入。
- 提取事项草稿，经用户确认后保存。
- 提供混合检索、精确引用展开和状态证据，由调用方 Agent 补查、澄清并回答。
- 读取记录、事项、状态历史并总结。

## 使用

需要 Node >=22.19 与 npm。运行 `npm ci`，再运行 `npm run dev`。

在 AI 宿主中加载 [Skill 入口](team-app/skill/SKILL.md)。默认只监听 127.0.0.1:5181，验证模式无需令牌。
客户端位于 [knowledge.mjs](team-app/scripts/knowledge.mjs)，数据库默认在 `team-app/.data/team.sqlite`。配置、模型凭证与权限边界见 [服务说明](team-app/README.md)。

## 开发

运行 `npm run test:team` 或 `npm run quality-and-tests`。
只维护 team-app 中的后端、客户端与 Skill。旧 Markdown wiki Skill、工作台后端、网页及离线图谱已移除；已有外部知识文件与本地数据库保留。
