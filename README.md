# lean-context

**Archived on 2026-11-12.** A negative-result artifact: a working prototype of a context-management plugin for [OpenClaw](https://github.com/openclaw/openclaw), built in April 2026 and retired when the host ecosystem and the plugin model stopped making sense.

中文说明：[README.zh.md](README.zh.md) · 完整复盘：[POSTMORTEM.md](POSTMORTEM.md)（中文）

## What it did

`lean-context` plugged into OpenClaw's `context-engine` slot and ran a four-stage pipeline:

1. **Tool-result slimming** — oversized `exec` / `read` / `fetch` / `search` outputs are trimmed before being persisted to the transcript; originals can be archived and referenced.
2. **Structured compaction** — old history is folded into a `StructuredSessionState` (`goal`, `done`, `open_todos`, `changed_files`, `important_outputs`, `constraints`, `decisions`, `blockers`) instead of a free-form summary.
3. **Context assembly** — recent raw messages + structured state + session memory / hot context + conservative archive recall, with budget rescue and a circuit breaker.
4. **Observability** — per-turn `raw / assembled / compacted` snapshots, categorized savings attribution, a reply footer, and `/lean-context` commands.

Tests: 12 vitest suites. Type-check: `tsc -p tsconfig.json --noEmit`.

## Why archived

- **No host ecosystem.** OpenClaw (formerly Warelay → Clawdbot → Moltbot) never reached the adoption needed to sustain third-party plugins.
- **Plugin API churn.** The plugin hooks `assemble / compact / tool_result_persist / afterTurn`, which are internal host lifecycles. Any upstream refactor breaks the plugin.
- **The economics moved.** Longer context windows and cheaper prompt caching keep eroding the value of "saving tokens".
- **Narrow payoff.** Savings were real in long sessions and near-zero in short tasks, where compaction thresholds never trigger.

The prototype was benchmarked on PinchBench (A/B: plugin off vs on). The API ledger and raw A/B results were lost when the development WSL instance was reinstalled, so the recorded figures cannot be re-verified. See [POSTMORTEM.md](POSTMORTEM.md) for the full account.

## What is still reusable

| Module | Value | Coupling |
| --- | --- | --- |
| `src/tool-result-slimmer.ts` | High | None — plain message transforms |
| `src/structured-state.ts` | High | Medium — expects host message shapes |
| `src/reporting.ts` | Medium-high | Low |
| `src/archive.ts` | Medium | Medium |
| `src/engine.ts` (assembly, circuit breaker) | Low | High — host lifecycle bound |

If rebuilt, this belongs in an LLM proxy or an MCP service, not inside an agent's process.

## Layout

- `index.ts` — plugin entry
- `src/` — engine, slimming, compaction, archive, memory, reporting
- `*.test.ts` — vitest suites
- `DESIGN.md` — architecture notes (Chinese)
- `POSTMORTEM.md` — why it was retired (Chinese)
- `TESTING.md`, `PINCHBENCH_TOKEN_STRATEGY.md`, `REPORT_OUTLINE.md`

## Compatibility

Targeted OpenClaw `2026.4.1`. Not maintained; not guaranteed to load on later versions.

## License

MIT
