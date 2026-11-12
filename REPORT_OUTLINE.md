# Lean Context 汇报提纲

## 1. 这个插件是做什么的

`lean-context` 是一个 OpenClaw 原生 `context-engine` 插件，目标是两件事：

- 减少上下文 / 输入 token 使用
- 让 token 节省变得可观测、可归因

它不是普通聊天总结器，而是更偏工程场景的上下文管理插件。

## 2. 为什么要做它

长对话和 agent 工作流里，上下文经常被这些东西撑爆：

- 大型工具输出
- shell 日志
- 搜索 / 网页抓取结果
- 重复的旧历史
- 无法直接帮助当前工作的附件和中间态

如果只做自然语言 summary，虽然能变短，但很容易丢掉“工作现场”。

所以这个插件的核心思路是：

**尽量保留工作状态，而不是只保留聊天摘要。**

## 3. 现在已经实现了什么

当前版本已经实现：

- `tool_result_persist` transcript slimming
  - 大工具结果在写入 transcript 前先瘦身

- structured compaction
  - 旧历史不是只做自由摘要，而是折叠成结构化 `session_state`

- context assembly
  - 最近原始消息
  - `session_state`
  - 少量 recall
  - 可选动态 `systemPromptAddition`

- savings attribution
  - 每轮记录 raw / assembled / compacted snapshot
  - 按类别统计节省量

- 轻量用户可见反馈
  - footer
  - `/lean-context`
  - `/lean-context board`

- 预算自救和熔断
  - 超预算时自动降级
  - 主动 compact 连续失败时暂停，避免死循环

- pre-compaction stripping
  - compaction 前先剥掉 `thinking`、附件块、tool-call 包装等低价值重块

## 4. 它怎么保留“工作现场”

插件会维护结构化 `session_state`，至少包括：

- `goal`
- `done`
- `open_todos`
- `changed_files`
- `important_outputs`
- `constraints`
- `decisions`
- `blockers`

也就是说，它保留的不是“这段对话大概聊了什么”，而是：

- 现在目标是什么
- 已经做到了哪里
- 改过哪些文件
- 有哪些关键输出
- 当前有哪些约束、决策和阻塞

## 5. token 节省是怎么统计的

每轮会生成三类 snapshot：

- `raw snapshot`
  - 如果没优化，本轮上下文理论上会有多大

- `assembled snapshot`
  - 实际送给模型的上下文大小

- `compacted snapshot`
  - 发生 compaction 时的压缩后大小

并按类别归因：

- `tool_result_slimming`
- `history_compaction`
- `history_exclusion`
- `attachment_trimming`
- `bootstrap_trim`
- `tool_schema_avoidance`

这里强调的是：

**这些数值是 estimated context token savings，不是 provider 账单上的 billed input tokens。**

## 6. 从 Claude 借鉴了什么

主要借鉴了 Claude 的几个思路：

- transcript slimming 要尽量前置
- 旧历史更适合结构化压缩，而不是只做自由摘要
- recent raw window 必须保留
- 预算不够时需要自救，不要直接爆掉
- auto-compact 需要熔断
- 用户最好能看到“省了多少、主要省在哪里”

## 7. 当前效果怎么验证

当前已经做过 PinchBench A/B：

- A：关 `lean-context`
- B：开 `lean-context`

比较：

- 准确率 / 总分
- token 使用
- request 数
- `lean-context` 自己记录的 savings attribution

这类测试能回答两个问题：

- 压缩有没有真的生效
- 压缩会不会伤准确率

## 8. 当前边界

当前版本还没有：

- 完整前端 dashboard 面板
- 真正后台维护的独立 `session memory` 层
- compaction 后的完整 cleanup 生命周期
- post-compact 的热上下文重注入

所以更准确地说：

- 现在已经实现了压缩、归因、轻量可见反馈
- 但还没有完整 UI 面板和完整长期记忆层

## 9. 下一步准备做什么

下一阶段最值得做的是：

1. 独立 `session memory` 层
2. compact 后 cleanup
3. post-compact 热上下文重注入
4. 更稳的 recent-window 保留策略
5. 更强的 tool-batch summary

## 10. 一句话总结

`lean-context` 把 Claude 风格的上下文压缩思路改造成了 OpenClaw 原生插件。当前已经实现 transcript 瘦身、结构化 compaction、token 节省归因和轻量用户可见反馈，下一阶段会继续补独立 session memory 和更完整的 compaction 生命周期管理。
