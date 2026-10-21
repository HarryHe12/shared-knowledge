# AGENTS.md

## 🧭 仓库导航（任何人 / AI 进来先读这里）

本仓库当前以 **Skill + 本地后端** 为产品入口，5180 / 5181 两套网页已删除。

| 区 | 位置 | 状态 |
|---|---|---|
| 默认知识服务、存取客户端、最小 Skill | `team-app/` | 活跃开发 |
| 旧 Markdown 工作台后端 | `workbench/server/` | 兼容保留，不默认启动 |
| 离线图谱引擎 | `packages/graph-engine/` | 继续供 Skill HTML 使用 |
| Markdown Skill | 根 `SKILL.md` / `scripts/` / `templates/` / `platforms/` | 成熟维护 |

先读 `team-app/README.md` 和 `team-app/CONTEXT.md`；旧后端改动再读 `workbench/AGENTS.md` 与 `workbench/PRODUCT.md`。统一术语和历史 ADR 见 `CONTEXT-MAP.md`。

## 开发命令与数据边界

- Node >=22.19，npm workspaces，根包保持 CommonJS 兼容。
- `npm run dev`：仅启动 5181 本地知识服务。
- `npm run dev:legacy`：显式启动 8787 旧后端。
- `npm run test:team`：知识服务与存取测试。
- `npm run quality-and-tests`：全仓后端、契约、引擎质量检查。
- `npm run typecheck` / `npm run check:boundaries`：类型与契约检查。
- 默认知识库数据库位于 `team-app/.data/team.sqlite`，客户端位于 `team-app/scripts/knowledge.mjs`，最小入口位于 `team-app/skill/SKILL.md`。
- 旧 Markdown 库 `~/llm-wiki/`、应用数据 `~/.llm-wiki-agent/`、pi 凭证 `~/.pi/agent/auth.json` 保留且分离。不在应用配置保存模型密钥。
- 测试使用 Node 内置 node:test；引擎更新后需 build 再验证旧后端类型。

## Skill 形态：安装与维护

仅当你在维护 `SKILL.md`、`install.sh`、`scripts/`、`templates/` 或 `platforms/` 时阅读 [docs/agents/skill-maintenance.md](docs/agents/skill-maintenance.md)。Skill 已功能成熟、进入维护冻结，不再追加新功能。

## 分支管理规则

改动代码（非纯文档/注释）时，按以下流程操作：

1. 开新分支：从 main 创建，命名表达用 feat 或 fix 前缀；Codex 环境默认使用 `codex/` 命名空间，例如 `codex/fix-cache-reliability-write-through`
2. 分步 commit：每完成一个逻辑单元就提交（脚本实现、测试、文档更新分开 commit）
3. 推送并创建 PR：推到远端后用 `gh pr create` 创建 PR
4. 合并：确认测试通过后在 GitHub 上合并

不需要开分支的情况：

- 只改了 AGENTS.md、CLAUDE.md、文档、注释
- 只是探索性阅读代码

设计文档或 plan 写完准备动手改代码时，也先开分支再开始实现。

## 推送前文档更新规则

每次 commit 含功能改动（feat/fix）后、`git push` 前，**必须**主动检查并更新以下文档，不需要用户提醒：

1. **CHANGELOG.md**：在顶部加新版本条目（日期、新增/改进/修复分类）
2. **README.md 功能列表**：新增功能或行为变化时，在"功能"章节补一条
3. **版本号**：如果改动涉及新功能，在 CHANGELOG 条目里用新版本号（按 v当前+1 递增）

跳过条件：纯文档/排版/注释改动不需要更新。

## 文档隐私自查

提交或推送文档改动前，扫描入口、docs、词表和工作台文档，避免把本机路径、真实姓名或私有素材线索写进仓库：

```bash
grep -r '本机用户路径\|真实姓名\|私有素材路径' README.md README.en.md AGENTS.md CLAUDE.md docs/ workbench/ packages/graph-engine/CONTEXT.md
```

如果是在维护 Skill，再按 [docs/agents/skill-maintenance.md](docs/agents/skill-maintenance.md) 跑 Skill 专用检查。

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `sdyckjq-lab/llm-wiki-skill`; external PRs are not treated as a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five-label triage vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Use a multi-context domain-doc layout for this monorepo. See `docs/agents/domain.md`.

## Skill routing

当用户请求匹配可用 skill 时，优先使用对应 skill 的工作流。不要直接临时发挥；先打开对应 `SKILL.md`，按里面的流程做。

关键路由规则：

- Product ideas, "is this worth building", brainstorming → 使用 office-hours
- Bugs, errors, "why is this broken", 500 errors → 使用 investigate
- Ship, deploy, push, create PR → 使用 ship
- QA, test the site, find bugs → 使用 qa
- Code review, check my diff → 使用 review
- Update docs after shipping → 使用 document-release
- Weekly retro → 使用 retro
- Design system, brand → 使用 design-consultation
- Visual audit, design polish → 使用 design-review
- Architecture review → 使用 plan-eng-review
- Save progress, checkpoint, resume → 使用 checkpoint
- Code quality, health check → 使用 health
