# Lean Context — 项目复盘（归档）

**状态：已归档 / 不再维护**
**归档日期：2026-11-12**
**最后开发：2026-04-08**
**目标宿主：OpenClaw `2026.4.1`（`context-engine` 插件槽位）**

## 一句话

`lean-context` 是一个 OpenClaw 原生上下文管理插件：在工具结果落盘前瘦身、把旧历史折叠成结构化状态、按需恢复归档，并逐轮记录"省了多少 token、省在哪"。

它技术上成立，但产品上没成立。

## 为什么做

长会话和 agent 工作流里，上下文被这些东西撑爆：

- 大型工具输出（shell 日志、搜索结果、文件读取）
- 重复的旧历史
- 对当前任务无用的附件和中间态

普通 summarizer 能把上下文变短，但会丢掉"工作现场"。所以核心思路是：
**保留工作状态（目标/进度/决策/阻塞），而不是只保留聊天摘要。**

## 做成了什么

设计上真正立住的部分：

1. **工具结果前置瘦身**（`src/tool-result-slimmer.ts`）
   在 `tool_result_persist` 写入 transcript 之前裁剪，原始结果可选归档并留下指针。
   这是整个插件里最可复用、最不依赖宿主语义的部分。

2. **结构化会话状态**（`src/structured-state.ts`）
   把旧历史折成 `goal / done / open_todos / changed_files / important_outputs / constraints / decisions / blockers`，并按 user / assistant / toolResult 角色做不同的启发式抽取。

3. **节省归因**（`src/reporting.ts`、`src/store.ts`）
   raw / assembled / compacted 三种 snapshot，按 `tool_result_slimming / history_compaction / history_exclusion / attachment_trimming / bootstrap_trim` 分类记账，落盘 ledger。

4. **工程兜底**
   - pending 队列持久化，避免热重载丢事件
   - 超预算时分级降级（budget rescue）
   - 连续 compact 失败时熔断（circuit breaker）
   - fallback 状态有明确进入/退出生命周期

5. **可观测的用户反馈**
   footer、`/lean-context`、`board`、`archive`、`restore`。

测试：12 个 vitest 文件 + 插件级 TypeScript 类型检查。

## 没成立的部分

- **短会话没有收益**。压缩阈值根本触发不了，插件大部分时间在 bypass，或者只省了个零头。
- **节省量是估算不是账单**。模型家族启发式 + 会话内校准（EMA）比固定 `len/4` 好，但仍不等于 provider 实际计费 token。
- **语义能力有限**。结构化状态是启发式，不是 LLM 提炼；archive/recall 是关键词检索，不是语义检索。
- **验证不完整**。PinchBench A/B 曾记录到较好的长会话结果（文档里有 ~85% 的说法），但 `ledger/turns.jsonl` 和 `results-2026-04-08-*` 随 WSL 重装丢失，**原始数据已无法复核**。

## 为什么停

1. **宿主没用户**。OpenClaw 本身换名多次（Warelay → Clawdbot → Moltbot → OpenClaw），生态不稳定；插件价值依赖宿主，宿主没人用，插件再好也是零。
2. **插件 API 跟着 agent 内部结构走**。`context-engine` 的 `assemble / compact / tool_result_persist / afterTurn` 是宿主私有生命周期，宿主一改内部实现，插件就失效。这是所有 agent 插件的结构性风险。
3. **赛道正在被上游吃掉**。上下文窗口越来越长、prompt caching 越来越便宜，"省 token"的边际价值持续下降。
4. **收益场景太窄**。只在长会话、长评审、反复回看旧证据的任务里明显；而这类任务恰好也是用户愿意直接买更大上下文/更强模型的地方。

## 结论

**方向对，形态错。**

上下文管理（前置瘦身、结构化状态、分级降级）是有价值的技术；把它做成某个 agent 的进程内插件，是错误的分发方式。

## 如果重做

把逻辑放到稳定的边界上，而不是宿主内部：

1. **LLM 代理层**：在请求发出前裁剪 tool result、折叠旧历史。对 Claude Code / Codex / Cline 等一律生效，接口是 OpenAI/Anthropic 兼容 API，生命周期稳定。
2. **MCP server**：把"结构化会话状态"和"归档/召回"做成独立服务，宿主只负责调用。
3. **独立 CLI / 成本观测工具**：把 `reporting` 单独拿出来做 token 成本看板，比"省 token"更容易被需要。

可复用优先级：

| 模块 | 复用价值 | 迁移难度 |
| --- | --- | --- |
| `tool-result-slimmer` | 高 | 低（无宿主语义） |
| `structured-state` | 高 | 中（需换消息格式） |
| `reporting` / ledger 归因 | 中高 | 低 |
| `archive` / recall | 中 | 中 |
| `context-engine` 装配/熔断 | 低（宿主强绑定） | 高 |

## 给未来的自己

- 选插件宿主时先看生态，不只看 API 好不好用。
- 能放在代理层的，不要放进程内。
- 先验证"用户愿不愿意为此付费/切换"，再写 12 个测试。
- **负结果也是结果**：这份复盘存在的意义，是避免三年后再做一遍同样的事。
