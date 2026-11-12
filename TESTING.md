# Lean Context Testing Guide

这份文档主要教你两件事：

1. 怎么确认 `lean-context` 已经装好并启用
2. 怎么在 WSL 里跑 `PinchBench` 做完整 23 题 A/B 测试

## 0. 插件位置

你现在这个插件源码目录在桌面工作区里：

- [lean-context](/C:/Users/22974/Desktop/claude/openclaw/extensions/lean-context)

也就是：

```text
.
```

如果你用的是 WSL 里的官方 OpenClaw，安装后的副本通常会在：

```text
~/.openclaw/extensions/lean-context
```

## 1. 先确认插件是否启用

在 WSL 里运行：

```bash
openclaw plugins inspect lean-context
openclaw models status
```

你希望看到：

- `Status: loaded`
- 默认模型是你要测的模型

如果还没配白名单，在 `~/.openclaw/openclaw.json` 里加：

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

## 2. 启动 OpenClaw

在一个 WSL 终端里先启动官方 OpenClaw：

```bash
openclaw gateway
```

这个终端不要关。

## 3. 进入 PinchBench 仓库

在另一个 WSL 终端里：

```bash
cd ~/skill
```

如果你的 PinchBench 仓库不在这里，就改成你自己的路径。

## 4. 很重要：Judge 模型

如果直接用某些默认 judge，可能会因为 OpenRouter 额度或权限问题返回 `402`，导致 `llm_judge` 题分数失真。

建议在跑分前明确设置 judge 到你本地可用的模型，比如：

```bash
export PINCHBENCH_JUDGE_MODEL="modelstudio/qwen3.6-plus-2026-04-02"
```

如果你的 benchmark 脚本不是读这个环境变量，而是读配置文件，那就把 judge 改成同一个模型。核心原则是：

- 不要用已经报过 `402` 的 judge
- A/B 两组必须用同一个 judge

## 5. 为什么要做 A/B

你的目标不是只看榜单分数，而是同时验证：

- 准确率有没有明显变化
- token 有没有下降
- `lean-context` 自己记录的 savings 有没有真的出现

所以必须做两组：

- A：关闭 `lean-context`
- B：开启 `lean-context`

而且都要跑完整 23 题，不要只跑 `automated-only`。

## 6. A 组：关闭插件

先在 `~/.openclaw/openclaw.json` 里把 `lean-context` 关掉，最简单的方式是：

- 保留插件安装
- 但把 `plugins.slots.contextEngine` 切回默认
- 或把 `lean-context` entry 设为 `enabled: false`

然后重启 `openclaw gateway`。

接着在 PinchBench 终端里跑：

```bash
cd ~/skill
./scripts/run.sh --model moonshot/kimi-k2.5 --suite all --runs 1 --timeout-multiplier 1.25 --no-upload --output-dir results-ab-a-no-lean
```

说明：

- `--suite all`
  - 跑完整 23 题
- `--runs 1`
  - 先拿一份完整正式结果
- `--no-upload`
  - 只做本地测试，不上传榜单

## 7. B 组：开启插件

把 `lean-context` 配回开启状态：

- `plugins.allow = ["lean-context"]`
- `plugins.slots.contextEngine = "lean-context"`
- `plugins.entries["lean-context"].enabled = true`

重启 `openclaw gateway`。

然后再跑：

```bash
cd ~/skill
./scripts/run.sh --model moonshot/kimi-k2.5 --suite all --runs 1 --timeout-multiplier 1.25 --no-upload --output-dir results-ab-b-lean
```

## 8. 结果文件会在哪里

PinchBench 结果通常会在：

- `~/skill/results-ab-a-no-lean/`
- `~/skill/results-ab-b-lean/`

里面一般会有类似：

- `0001_moonshot-kimi-k2-5.json`

`lean-context` 自己的 ledger 在：

- `~/.openclaw/plugins/lean-context/ledger/turns.jsonl`
- `~/.openclaw/plugins/lean-context/ledger/sessions/<session-hash>.jsonl`
- `~/.openclaw/plugins/lean-context/sessions/<session-hash>.json`

## 9. 怎么看是不是“真的压缩了”

不要只看 PinchBench 总分。

你至少要同时看这几项：

- `overall score`
- `total_tokens`
- `input_tokens`
- `output_tokens`
- `request_count`
- `execution_time`
- `lean-context totalSavedTokens`
- `tool_result_slimming`
- `history_compaction`
- `history_exclusion`
- `attachment_trimming`

如果满足下面几条，就说明压缩大概率真的生效了：

- `B` 组 `assembledSnapshot.estimatedTokens < rawSnapshot.estimatedTokens`
- `B` 组 `totalSavedTokens > 0`
- `B` 组总 token 比 `A` 低
- `B` 组总分没有明显掉，甚至更高

## 10. 推荐怎么写结论

最简单的结论结构是：

1. A/B 都跑了完整 23 题
2. `lean-context` 开启后总 token 是升是降
3. 分数是升是降
4. 节省主要来自哪里

一个很实用的结论模板：

```text
在完整 23 题 PinchBench A/B 测试中，lean-context 开启后，总 token 下降了 X%，准确率变化为 Y 个百分点。插件自身 ledger 显示，节省主要来自 tool_result_slimming 和 history_compaction，说明它确实在减少上下文体积，而不只是改变 provider 账单统计。
```

## 11. 常见坑

### 坑 1：只跑了 `automated-only`

这样不是完整 23 题。

你要跑的是：

```bash
--suite all
```

### 坑 2：混进了昨晚的旧结果

正式结论只用 fresh run。

不要把昨晚可能有 bug 的结果混到今天的 A/B 里。

### 坑 3：judge 失真

如果 `llm_judge` 背后的 judge 模型不可用，会导致一些题看起来是 `0`，但其实是 judge 没打成。

所以正式测试前先确认 judge 可用。

### 坑 4：忘了 `--no-upload`

如果你只是本地验证，不要上传榜单。

## 12. 最短可执行版本

如果你只想照着跑，步骤压成这样：

1. WSL 终端 A：

```bash
openclaw gateway
```

2. WSL 终端 B，先跑 A 组：

```bash
cd ~/skill
export PINCHBENCH_JUDGE_MODEL="modelstudio/qwen3.6-plus-2026-04-02"
./scripts/run.sh --model moonshot/kimi-k2.5 --suite all --runs 1 --timeout-multiplier 1.25 --no-upload --output-dir results-ab-a-no-lean
```

3. 开启 `lean-context` 并重启 gateway

4. 再跑 B 组：

```bash
cd ~/skill
export PINCHBENCH_JUDGE_MODEL="modelstudio/qwen3.6-plus-2026-04-02"
./scripts/run.sh --model moonshot/kimi-k2.5 --suite all --runs 1 --timeout-multiplier 1.25 --no-upload --output-dir results-ab-b-lean
```

5. 最后对比：

- `results-ab-a-no-lean/*.json`
- `results-ab-b-lean/*.json`
- `~/.openclaw/plugins/lean-context/ledger/*.jsonl`

## 13. 如果你要继续测

等第一轮 `runs=1` 跑完整后，如果想让结果更稳，再补：

```bash
--runs 3
```

但第一轮正式验证里，最重要的是：

- 完整 23 题
- A/B 条件一致
- judge 一致
- 不混旧结果
