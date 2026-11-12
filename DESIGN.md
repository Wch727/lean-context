# Lean Context Design

这份文档回答 4 个问题：

1. `lean-context` 现在的架构是什么
2. 这轮重点修了哪些设计缺陷
3. 它从 Claude 里真正吸收了哪些思路
4. 接下来还值得继续做什么

## 1. 产品定位

`lean-context` 不是普通总结插件。

它更像是一个给 OpenClaw 用的轻量上下文管理层，目标是：

- 减少上下文 token 压力
- 保留工作连续性
- 让“省了多少、从哪省的”可观测
- 在压缩和可恢复之间做平衡

## 2. 当前架构

### 2.1 输入瘦身层

入口：`tool_result_persist`

职责：

- 在工具结果写入 transcript 前做保守瘦身
- 生成 `SavingsEvent`
- 需要时把完整结果单独归档

核心文件：

- [index.ts](./index.ts)
- [tool-result-slimmer.ts](./src/tool-result-slimmer.ts)

### 2.2 上下文组装层

入口：`assemble()`

职责：

- 读取 session data
- 选择 recent raw messages
- 插入 `session_state`
- 插入 `session memory` / hot context
- 插入 recall 和 archive recovery
- 进行预算自救
- 生成 pending turn report

核心文件：

- [engine.ts](./src/engine.ts)
- [context-fit.ts](./src/context-fit.ts)

### 2.3 历史压缩与恢复层

入口：`compact()`

职责：

- 对旧历史前缀做 pre-compaction stripping
- 提炼 `StructuredSessionState`
- 把新被 compact 掉的原文前缀写进 archive
- 后续通过 archive recovery 把旧证据按需注回

核心文件：

- [engine.ts](./src/engine.ts)
- [pre-compaction.ts](./src/pre-compaction.ts)
- [archive.ts](./src/archive.ts)

### 2.4 观测与反馈层

职责：

- 维护 `raw / assembled / compacted` snapshot
- 计算 category savings
- 生成 turn report 和 session summary
- 通过 footer / board / command 暴露给用户

核心文件：

- [reporting.ts](./src/reporting.ts)
- [reply-footer.ts](./src/reply-footer.ts)
- [store.ts](./src/store.ts)

## 3. 这轮修复的 5 个重点

### 3.1 Token 估算从“固定粗估”变成“模型感知 + 会话校准”

之前的问题：

- 估算过于固定
- 不可校准
- 预算判断容易整体漂移

现在的方案：

- 先按模型家族选择 heuristic profile
  - `qwen`
  - `kimi`
  - `openai`
  - `anthropic`
  - `default`
- 再按会话内的 `promptScale` 做校准
- 如果 turn 结束后能从消息里读到实际 prompt usage，就用 EMA 更新 `promptScale`

这不是原生 tokenizer，但已经具备：

- 模型感知
- 可学习
- 可逐轮收敛

关键文件：

- [helpers.ts](./src/helpers.ts)
- [engine.ts](./src/engine.ts)

### 3.2 `pendingSlimming` 从进程内 Map 改成持久化 pending queue

之前的问题：

- `tool_result_persist` 到 `afterTurn` 之间的 slimming 事件只放在 `globalThis`
- 一旦热重载或进程重启，就会静默丢失

现在的方案：

- `tool_result_persist` 同步 append 到 `plugins/lean-context/pending/*.jsonl`
- `afterTurn()` 异步消费并清空

这是一次很明确的“从易丢内存态 -> durable queue”的修复。

关键文件：

- [store.ts](./src/store.ts)
- [engine.ts](./src/engine.ts)
- [index.ts](./index.ts)

### 3.3 `fallbackState` 有显式生命周期了

之前的问题：

- fallback 更像永久影子状态
- 进去了不容易出来

现在的方案：

- 只有在 fallback active 时才继续增量维护
- compaction 成功时立即清空
- 如果后续进入健康低压轮次，会累计 recovery turns
- 达到阈值后自动退出 fallback，并清掉失败计数

这让 fallback 从“越滚越大的临时兜底”变成“有进入和退出边界的降级模式”。

关键文件：

- [engine.ts](./src/engine.ts)
- [types.ts](./src/types.ts)

### 3.4 `structured-state` 从纯扫词升级为 role-aware 启发式

之前的问题：

- 所有角色都套一套正则
- blocker / decision / constraint 噪音大
- `important_outputs` 容易变成垃圾场

现在的方案：

- `user` 更偏 `goal / constraints / open_todos`
- `assistant` 更偏 `done / decisions`
- `toolResult` 更偏 `blockers / important_outputs`
- 收紧 blocker 判定
- 收紧 important output 判定
- 过滤明显的低价值正常输出

这仍然是 heuristic，不是 LLM semantic extractor，但质量和可预测性都更适合当前插件形态。

关键文件：

- [structured-state.ts](./src/structured-state.ts)

### 3.5 hot context 不再必须等第一次 compact

之前的问题：

- `sessionMemory` 虽然在维护
- 但 hot context 必须等 `compactedHistory = true` 才会出现

现在的方案：

- 当 `sessionMemory` 已经有内容
- 且消息数 / token 已经超过预热阈值
- 即使还没第一次 compact，也允许注入更小的 pre-compact hot context

这解决了“前几十轮完全吃不到 memory 增益”的问题。

关键文件：

- [session-memory.ts](./src/session-memory.ts)
- [engine.ts](./src/engine.ts)

## 4. 从 Claude 吸收进来的设计思路

### 已经落地的

- 压缩不是一句 summary，而是一条流水线
- 优先保留工作状态，不只保留聊天主题
- recent raw window 保真，旧历史结构化
- 预算不够时要有 rescue
- auto-compact 需要 circuit breaker
- pre-compaction stripping 比“全量拿去总结”更稳
- 压缩不能变成单向门，所以要有 archive / restore

### 还没完全学满的

- 真正独立的 session memory 后台层
- compact 后完整 cleanup
- 更像 Claude 的 post-compact hot-context reinjection
- 更强的 partial compaction 边界
- 更强的工具批次 summary

## 5. 当前的设计取舍

### 确定性提取

优点：

- 成本低
- 速度快
- 输出可预测
- 易测试

缺点：

- 语义上限低
- 多轮隐含关系抓得不如 LLM

### 前置瘦身

优点：

- 后续每轮都更轻
- transcript 不容易被大工具结果污染

缺点：

- 如果策略太激进，会增加遗漏风险
- 因此必须配合 archive / persisted artifact

### fallback 模式

优点：

- 不会一失败就彻底失去压缩能力

缺点：

- 降级质量肯定不如正常 compact
- 所以必须保证能退出，而不是永久停在 fallback

## 6. 当前还没完成的硬缺口

### P0

- 真正的 provider 原生 tokenizer
- LLM / hybrid structured-state mode
- 更稳定的 recall / archive 检索质量

### P1

- 更强的 recent-window 选择策略
- 更完整的 post-compact cleanup
- 热上下文重注入更多 runtime artifact

### P2

- 更像产品的 dashboard
- 更细的趋势可视化
- 更强的 tool-batch short summary

## 7. 当前推荐的下一步

如果继续往 Claude 那套方向收，我会按这个顺序做：

1. provider tokenizer 接入或可插拔 tokenizer 层
2. hybrid structured-state mode
3. compact 后 cleanup
4. recent-window v2
5. archive / recall 搜索升级

## 8. 这次改动最重要的一句话

`lean-context` 现在不再只是“压缩器”，而是一个带有：

- durable slimming queue
- calibrated token estimation
- lifecycle-managed fallback
- role-aware state extraction
- pre-compact hot context

## 9. 当前的客观评价

从当前代码、配置和实测结果来看，`lean-context` 的位置可以这样判断：

- 它已经是一个像样的工程化插件，而不是 demo
- 它已经把“上下文压缩”推进成了“瘦身 + 结构化状态 + 归因 + 恢复”的系统
- 它的主要优势场景是长会话、长评审、长研究，而不是天然适合所有短任务 benchmark

当前已经做得比较好的地方：

- 四层流水线已经清楚：输入瘦身、历史压缩、上下文组装、观测反馈
- 有明确的问题意识，能持续修正 fallback、pending queue、token drift 这类工程问题
- 可观测性较好，用户能看到 saved tokens、category savings、archive restore

当前还比较明显的限制：

- heuristic 结构化提炼仍然有质量上限
- session memory 还不是 Claude 那种独立、持续、后台维护的层
- archive / recall 检索质量还不够强
- 在短任务、短 transcript 场景下，经常因为 bypass 或阈值设置而不触发真正 compaction

所以更准确的结论不是“已经完成”，而是：

`lean-context` 现在已经完成了第一代工程化实现，设计方向正确，长上下文场景下有价值；但距离更成熟的 Claude 风格上下文系统，还差更强的 session memory、语义级 state 提炼、恢复质量和生命周期管理。

## 10. 这轮吸收的 LycheeMem 思路

这次没有照搬 LycheeMem 的后端和向量库，而是挑了最适合当前插件形态的三点落地：

### 10.1 Typed Session Memory

原先的 `sessionMemory` 更像 compact digest。

现在新增了 typed records：

- `fact`
- `preference`
- `constraint`
- `decision`
- `procedure`
- `failure_pattern`
- `tool_affordance`

这让 session memory 更像“轻量 working memory”，而不是只有 summary。

### 10.2 Novelty Check

新记录写入前会做近似归一化和去重：

- 同类型近似重复项会合并
- 老记录会衰减
- 每种类型和整体条数都有上限

目标不是绝对精确，而是降低 memory 污染速度。

### 10.3 Soft / Hard Threshold

当前插件已经有 hard threshold（full compaction）。

这轮新增了更轻的 soft threshold：

- soft threshold：提前激活 working-memory hot context
- hard threshold：继续走现有 compaction / rescue 流程

这样更接近 LycheeMem 的“两段式工作记忆”思路，同时又不会把插件复杂度一下拉得太高。

的上下文管理器。
