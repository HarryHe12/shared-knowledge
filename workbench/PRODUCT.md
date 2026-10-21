# 后端与 Skill 产品边界

2026-10-21：按作者决策撤下 5180 与 5181 两套网页。产品入口统一使用 Skill，默认只启动 5181 知识服务。

- `team-app/` 保存后端、默认知识库、存取客户端和最小 Skill 入口。
- 默认数据保存在 `team-app/.data/team.sqlite`，按项目目录定位，不依赖启动目录；模型凭证继续由 pi 管理。
- 只有一个现有项目时自动沿用；空库自动创建默认库；多个旧项目时必须指定 `TEAM_DEFAULT_PROJECT_ID`，不合并、不删除数据。
- 默认库选择持久化，所有存取入口受个人令牌和默认库成员权限约束。保留旧项目路径用于客户端兼容，但不再允许 HTTP 新建项目或跨库访问。
- Skill 负责收集用户原文、呈现提取草稿和澄清问题、展示证据；存储、检索、问答、澄清状态由本地后端负责。
- `workbench/server/` 暂保留旧 Markdown 知识库接口，只有显式 `npm run dev:legacy` 才启动。旧用户目录、知识库和模型凭证不迁移、不删除。
- `packages/graph-engine/` 继续供 Skill 的离线图谱产物使用。

启动和使用见 [team-app/README.md](../team-app/README.md)。历史网页产品决策保留在 docs/archive 与 ADR 中，不代表当前产品入口。
