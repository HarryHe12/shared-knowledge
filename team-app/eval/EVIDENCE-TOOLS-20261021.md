# Skill 证据接口改造验收

默认查询由宿主 Agent 负责判断、补查、澄清和回答，知识服务返回证据。search 支持原有混合检索、rerank 与确定性实体/编号展开；get 返回完整来源；state 返回最新已登记事项及来源。权限、写入幂等、状态事件历史保持在服务端。

## 已验证

- 31项 Node 测试通过，包含客户端通过真实本机 HTTP 保存、搜索、读取原文和状态；默认 ask 返回410且生成模型调用为0；范围隔离、截断、空结果语义与状态来源均有断言。
- 原固定6道自然多跳题，在真实 Qwen3 embedding/rerank 配置下，先 search，再 exact depth=2，6/6取齐三条来源，生成模型调用为0。
- 本机5181已启动新服务，实际 search 使用 hybrid-rerank；state/search/get 只读冒烟通过。
- 安装的 shared-knowledge 入口本来就转读仓库 Skill，因此直接使用更新后的接口说明，无需复制业务逻辑。

多跳试验采用固定两次工具调用，不是自主 Agent 评测；6/6只证明所需证据可取得，不代表 Agent 能自行决定何时调用。原58次试验继续保留为旧循环历史，不能套用为新架构正确率。

复现：`node team-app/scripts/evaluate-evidence.mjs <原多跳evaluation.sqlite> <独立输出目录>`。结果保存在本地 `test-results/team-evidence-20261021/results.json`，测试日志在同目录。使用独立数据库副本，不修改基线。

## 保留与未完成

- 历史循环代码和测试暂保留，只有 TEAM_LEGACY_ASK=1 显式开启；默认服务与 Skill 不使用它，不新增服务端澄清状态。
- extract 仍是可选的单次生成模型调用，按需加载；它不是查询循环。原文保存及证据查询不需要生成模型。
- 尚未做独立宿主 Agent 留出集、不同宿主稳定性和生产规模测试；也未增加独立事实验证器。
- Skill 内容与路径人工核对完成；官方 quick_validate 因当前两个 Python 运行时均缺少 PyYAML 未运行成功，不将其列作通过。

只提交本轮实现、测试与文档；未发布远端PR。
