# PinchBench Token Strategy

This note describes the restored stable configuration used after rolling back the benchmark-aggressive experiment.

## Current stance

`lean-context` is currently optimized for:

- stable long-session compaction
- transcript slimming before persistence
- conservative archive recovery
- predictable PinchBench behavior

It is **not** running a benchmark-specific aggressive memory-first mode anymore.

## Why PinchBench savings may stay modest

On many PinchBench task sessions:

- transcript history stays relatively short
- full compaction thresholds are rarely crossed
- the plugin intentionally bypasses low-yield short turns
- the recent raw window still carries most of the useful prompt state

That means the restored stable version often preserves correctness better than it reduces prompt size on short benchmark tasks.

## Where savings are still most likely

- long file-reading tasks
- judge or reviewer sessions
- multi-step research tasks that revisit earlier evidence
- sessions where tool outputs would otherwise bloat the transcript

## Current strategy

1. Slim oversized tool results before they are persisted.
2. Keep recent raw history and a compact structured state.
3. Use archive recovery conservatively when older context is actually needed.
4. Avoid aggressive benchmark-only assembly behavior that can distort short-task results.

## Practical implication

If the goal is specifically to lower PinchBench token usage, the restored stable plugin is a safer baseline, but it will not chase the most aggressive possible token reduction on short task sessions.
