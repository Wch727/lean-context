# Lean Context

> **2026-11-12 已移植到 OpenClaw 2026.11.3。** 项目仍为归档原型，不维护。
> 移植细节和测试状态见 [PORT_NOTES.md](./PORT_NOTES.md)，安全说明见 [SECURITY.md](./SECURITY.md)。

`lean-context` 是一个 OpenClaw 原生 `context-engine` 插件，目标很直接：

- 减少上下文 / 输入 token 压力
- 记录每一轮省了多少 token
- 让用户看见 token 具体省在什么地方

它不是普通“聊天总结器”，而是一个更偏工程场景的上下文管理插件。

## 现在已经能做什么

- `tool_result_persist` 前置瘦身
  - 大 `exec/read/fetch/search` 结果先瘦身再写入 transcript
- 结构化历史压缩
  - 旧历史折叠成 `StructuredSessionState`
- `session memory` 摘要
  - 维护轻量工作记忆，并在需要时注入 hot context
- archive / restore
  - 被 compact 掉的旧前缀会归档，后续可按需恢复
- per-turn savings attribution
  - 每轮维护 `raw / assembled / compacted` snapshot
  - 分类统计 `tool_result_slimming / history_compaction / history_exclusion / attachment_trimming / bootstrap_trim`
- 预算自救与熔断
  - 超预算时逐级裁 recall / system prompt / state / recent window
  - 连续 compact 失败时打开 circuit breaker
- 轻量用户可见反馈
  - footer
  - `/lean-context`
  - `/lean-context board`
  - `/lean-context archive`
  - `/lean-context restore`

## 这轮重点修了什么

这次主要补的是你之前点名的 `1,2,3,4,5`。

### 1. Token 估算不再是单纯 `length / 4`

现在改成了两层：

- 模型家族感知的启发式估算
  - `qwen / kimi / openai / anthropic / default`
- 会话内校准因子
  - 如果 turn 结束后能从消息里读到真实 prompt usage，就会更新 `promptScale`
  - 后续预算判断使用“校准后的估算值”

这仍然不是“真实 billed tokens”，但比原来单一固定估算稳很多，而且可以逐轮自校准。

### 2. `pendingSlimming` 改成持久化队列

之前 `tool_result_persist` 到 `afterTurn` 之间的 slimming 事件只放在进程内 `globalThis` 里，热重载或引擎重建时会静默丢失。

现在改成：

- `tool_result_persist` 同步落盘到 pending JSONL
- `afterTurn()` 原子消费并清空

也就是说，这些节省事件不再只存在内存里。

### 3. `fallbackState` 有明确生命周期了

之前的 fallback 更像“进去了就赖着不走”。

现在的行为是：

- compaction 失败时进入 fallback mode
- fallback 激活期间才继续增量维护
- 如果后续出现“健康轮次”
  - 已有正常 `state`
  - 或当前上下文已经回到低压力区
- 连续达到阈值后会自动清掉 fallback，并顺带重置失败计数

所以它不再是永久影子状态。

### 4. `structured-state` 从纯关键词扫行改成 role-aware 启发式

现在不是只靠一套正则扫所有行了，而是按角色分工：

- `user`
  - 更偏 `goal / constraints / open_todos`
- `assistant`
  - 更偏 `done / decisions`
- `toolResult`
  - 更偏 `blockers / important_outputs`

同时还收紧了：

- blocker 触发条件
- important output 的筛选条件
- 对明显垃圾输出的过滤

它仍然是启发式，不是 LLM 语义摘要，但比原来噪音少很多。

### 5. hot context 不再必须等第一次 compact 之后才出现

现在只要：

- `session memory` 已经积累起来
- 且对话已经进入“有点厚”的阶段

就可以在第一次 compact 之前注入一个更小的 pre-compact hot context。

这样前几十轮也能吃到 memory 的好处，而不是一直等到第一次 compact 之后。

## 它怎么工作

可以把 `lean-context` 理解成四层流水线：

1. 输入瘦身
   - `tool_result_persist` 先把大工具结果瘦下来

2. 历史压缩
   - 旧历史折成 `session_state`
   - 同时把被折掉的原文前缀归档进 archive

3. 上下文组装
   - 最近原始消息
   - `session_state`
   - `session memory` / hot context
   - recall
   - archive recovery
   - 可选 `systemPromptAddition`

4. 观测与反馈
   - turn report
   - session summary
   - footer / board / ledger

## Structured Session State

当前结构化状态字段：

- `goal`
- `done`
- `open_todos`
- `changed_files`
- `important_outputs`
- `constraints`
- `decisions`
- `blockers`

这套结构更关注“工作现场”，而不是“聊了什么话题”。

## “Saved Tokens” 是什么意思

`lean-context` 报的是：

**estimated context token savings**

意思是：

- 这是对“上下文构建阶段省掉了多少 token”的估算
- 适合做 A/B 对比和归因分析
- 不等于 provider 账单上的精确 billed input tokens

如果 provider usage 和这里不完全一致，这是正常的。

## 安装与启用

```bash
openclaw plugins install /path/to/lean-context
openclaw plugins enable lean-context
```

配置里至少加上：

```json
{
  "plugins": {
    "allow": ["lean-context"],
    "slots": {
      "contextEngine": "lean-context"
    },
    "entries": {
      "lean-context": {
        "enabled": true
      }
    }
  }
}
```

完整示例见 [config.example.jsonc](./config.example.jsonc)。

## 常用配置

- `keepRecentMessages`
- `keepRecentTokens`
- `assembleBypassMaxTokens`
- `minimumRecentMessagesOnRescue`
- `preCompactHotContextMinMessages`
- `preCompactHotContextMinTokens`
- `fallbackStateSuccessTurnsToClear`
- `tokenCalibrationEnabled`
- `tokenCalibrationAlpha`
- `maxRecallResults`
- `enableMemoryRecall`
- `autoCompactTriggerTokens`
- `autoCompactTriggerRatio`
- `maxConsecutiveAutoCompactFailures`
- `compressionNoticeEnabled`
- `workflowHintsEnabled`
- `replyFooterEnabled`
- `allowCrossSessionCommands`（默认 `false`，显式跨会话命令参数需要开启）

## 日常怎么用

大多数时候不用手动操作：

1. 正常聊天、改代码、跑工具
2. 大工具结果会先瘦身再进 transcript
3. 旧历史逐渐折成 `session_state`
4. 需要时自动 archive recovery / hot context
5. 想看细节再用命令

常用命令：

- `/lean-context`
- `/lean-context board`
- `/lean-context archive`
- `/lean-context restore <query>`
- `/lean-context summary <sessionId> [sessionKey]`

## 落盘位置

- `plugins/lean-context/sessions/<session-hash>.json`
- `plugins/lean-context/ledger/turns.jsonl`
- `plugins/lean-context/ledger/sessions/<session-hash>.jsonl`
- `plugins/lean-context/archives/<session-hash>.jsonl`
- `plugins/lean-context/pending/<session-hash>.jsonl`

## 当前边界

当前版本还没做到这些：

- 真正的 provider 原生 tokenizer
- LLM 辅助的结构化语义提炼
- 语义级 archive / recall 检索
- 完整的 post-compact runtime cleanup
- 独立前端 dashboard

## 下一步最值得做的

1. 真正独立的 session memory 层
2. 更完整的 compact 后 cleanup
3. 更强的 archive / recall 检索
4. 更好的 recent-window 选择策略
5. 更像 Claude 的工具批次摘要

## 测试

在插件目录内：

```bash
npm install
./node_modules/.bin/tsc -p tsconfig.json --noEmit
./node_modules/.bin/vitest run
```

2026.11.3 移植后的状态：类型检查通过，单测 **29 / 37 通过**。8 个失败是移植前就存在的断言漂移
（原 Windows 开发机上 Vitest 因 `spawn EPERM` 从未跑通），不是移植引入的回归；逐条说明见
[PORT_NOTES.md](./PORT_NOTES.md#known-failing-tests-pre-existing)。

## 客观评价

如果只看当前完成度，`lean-context` 已经不是一个玩具插件了。

它现在已经具备：

- 分层的上下文处理流水线
- 可落盘的 savings ledger
- 结构化 state、archive / restore、session memory 雏形
- budget rescue、fallback、circuit breaker 这类工程化兜底

但它也还没有到“任何场景都稳定体现价值”的阶段。

更准确的评价是：

- 在长会话、长评审、长研究任务里，它已经有真实价值
- 在短会话、短 benchmark 主流程里，它经常因为 bypass 或阈值原因而不容易触发
- 它现在更像“好的一代原型”，而不是完全成熟的生产级上下文系统

和 Claude 那套上下文管理相比，当前差距主要还在：

- `session memory` 还不是完整的独立后台层
- 结构化 state 仍然以 heuristic 为主，不是 LLM 参与的高语义摘要
- archive / recall 还偏关键词检索，不是更强的语义恢复

一句话说：

`lean-context` 的设计方向是对的，工程结构也已经立住了；但它的优势目前主要体现在长上下文场景，短任务 benchmark 里还不足以稳定证明自己。

## LycheeMem 风格的新增改动

这轮额外吸收了几条 LycheeMem 的思路，但做成了更轻的 OpenClaw 插件版本：

- `typed session memory`
  - 不再只保留一段 summary
  - 现在会维护 typed records，例如：
    - `fact`
    - `preference`
    - `constraint`
    - `decision`
    - `procedure`
    - `failure_pattern`
    - `tool_affordance`

- `novelty check`
  - 新记忆写入前会做近似去重和合并
  - 避免 session memory 越滚越脏

- `working-memory soft threshold`
  - 不再只能等到 full compaction 之后才有 hot context
  - 当上下文进入 soft-pressure 区间时，就允许提前注入更小的 working-memory hot context

这让 `lean-context` 更接近“工作记忆 + 压缩器”的组合，而不只是 transcript summary。

当前这台 Windows 机器上，Vitest 仍然会因为 `spawn EPERM` 在加载 `vitest.config.ts` 时失败；所以目前我能稳定验证的是：

- `lean-context` 插件级 TypeScript 检查
- WSL 官方 OpenClaw 插件加载

## PinchBench Token Reduction Notes

Current `lean-context` is tuned for the more stable configuration that produced the earlier `~85%` PinchBench runs.

That means:

- no benchmark-specific aggressive mode
- normal recent-window replay behavior
- archive recovery stays conservative
- typed session memory remains available, but the plugin does not force a memory-first assembly path for short benchmark turns

In practice, this version is better suited to:

- long sessions
- judge/reviewer flows
- tasks that repeatedly revisit earlier context

For many short PinchBench task sessions, token savings can still be modest because the transcript often never reaches the full compaction threshold.

更细的实现说明见 [DESIGN.md](./DESIGN.md)。
