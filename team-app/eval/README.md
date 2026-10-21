# 真实检索对照

推荐首轮服务：硅基流动 `Qwen/Qwen3-Embedding-8B` 与 `Qwen/Qwen3-Reranker-8B`。这是待用业务数据验证的选型，不宣称效果已优于其他模型。

官方接口：
- https://api-docs.siliconflow.cn/docs/api/embeddings-post
- https://docs.siliconflow.cn/docs/api/rerank-post
- https://github.com/QwenLM/Qwen3-Embedding

## 配置

将 `.env.retrieval.example` 复制到 `team-app/.env.retrieval`，本机填入 `SILICONFLOW_API_KEY`。该文件已被 Git 忽略，建议权限 0600。两类服务可共用该 key；也可分别使用 `TEAM_EMBEDDING_KEY` / `TEAM_RERANK_KEY`。模型凭证不写入应用 JSON、数据库或报告。

需要账户具备两个模型的调用权限与可用额度；已有 Kimi Coding key 不假定可用于硅基流动。没有凭证时只能运行 BM25，不能提供真实向量或 rerank 成绩。

```bash
# 从仓库根执行；不需要新增 npm 依赖
node --env-file=team-app/.env.retrieval team-app/scripts/evaluate-retrieval.mjs
# 同题生成回答，保持生成模型与提示一致，答案需人工核对
node --env-file=team-app/.env.retrieval team-app/scripts/evaluate-retrieval.mjs --answers
# 启用真实检索启动团队应用，TEAM_DB 可指定已有演示库
node --env-file=team-app/.env.retrieval team-app/src/server.mjs
```

也可从根执行 `npm run eval:retrieval -w @llm-wiki/team-app` 和 `npm run start:retrieval -w @llm-wiki/team-app`。npm workspace 的工作目录为 team-app，默认数据库路径可能不同；要继续使用已有库请通过 `TEAM_DB` 显式指定绝对路径。

## 设计

- 四组：`bm25`、`vector`、`hybrid`、`hybrid-rerank`，同一问题、语料、top-k；单独模式显式隔离，不受另一组服务配置影响。
- 问题沿用前次16题。语料为原7份虚构材料，增加30条确定性行政干扰记录；标准答案和 source 标签只用于打分，不进入模型提示或向量输入。
- 14道有答案题按原标注来源计算 Hit@1、Hit@5、MRR@5；这是来源命中代理，不是完整事实覆盖和问答正确率。2道无答案题保留结果，不能靠相似度自动判定答对。
- 评测输入是原始材料，不是上次工作台生成的 wiki；原始问法一致，但不可直接把这次来源召回率与上次问答正确率比较。
- 检索评测不加入当前事项状态和 agent 补查，避免这些能力掩盖各组召回差异。`--answers` 固定提示、生成模型且不使用工具，原始答案保存待人工核对。
- 缓存按项目/模型/端点/内容散列持久化；首次向量检索包含建库，后续复用缓存。当前耗时仅作观察，不能据此公平比较线上延迟。
- 默认写入 `.data/evaluation/`，可用 `TEAM_EVAL_OUTPUT` 指定。输出数据库、逐题排名、可选原始回答及 REPORT.md。每题检查点保存；失败时保留已执行数据，不伪造余下成绩。
- 语料小、每题一次，仅作接线和首轮方向判断；还需要未参与调优的工作进度题、状态冲突、跨项目与多轮稳定性评测。

## 当前结果

2026-10-21：BM25 的 Hit@1 为9/14（64.3%），Hit@5 为11/14（78.6%），MRR@5 为0.690。之后已完成真实服务与64份回答对照，详细成绩、退步样例和边界见 [RESULTS-20261021.md](RESULTS-20261021.md)。纯向量和混合的指定来源Hit@5仍为11/14，混合重排为13/14；最终回答通过分别为BM25 13/16、纯向量15/16、混合14/16、混合重排15/16。
