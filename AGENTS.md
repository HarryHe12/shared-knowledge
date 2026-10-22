# AGENTS.md

本项目维护 Skill、知识服务，以及账号注册登录和管理后台网页；员工日常存取仍通过 Skill。先读 team-app/README.md 和 team-app/CONTEXT.md。

- 唯一 Skill：team-app/skill/SKILL.md，名称 shared-knowledge，同时负责存和取。
- 客户端：team-app/scripts/knowledge.mjs；后端：team-app/src/；测试：team-app/test/。
- Node >=22.19，npm workspaces，根包保持 CommonJS 兼容。
- npm run dev 启动 5181 本地服务；npm run test:team 或 npm run quality-and-tests 运行测试。
- 数据库默认在 team-app/.data/team.sqlite。不得删除已有数据、外部知识文件或模型凭证。
- 模型凭证由 pi 管理，不在项目配置保存模型密钥。测试使用 Node 内置 node:test。

## 分支与发布

- 唯一发布目标为用户自己的仓库 `HarryHe12/shared-knowledge`，远程名 `origin`（`git@github.com:HarryHe12/shared-knowledge.git`）。推送、创建 PR 和合并前核对目标。
- `upstream`（`sdyckjq-lab/llm-wiki-skill`）仅作为来源参考，不得向其推送、创建 PR 或合并；不得擅自将 `origin` 改回该仓库。

代码变更从 main 创建 codex/feat-* 或 codex/fix-* 分支。按实现、测试、文档分步提交；推送后创建 PR，测试通过后在 GitHub 合并。纯文档修改不要求分支。
每次功能变更推送前更新 CHANGELOG.md 和 README.md 功能说明；新增功能递增 changelog 版本。提交文档前检查个人路径、真实姓名与私有素材线索。
