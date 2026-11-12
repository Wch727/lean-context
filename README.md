# lean-context

**Archived (2026-11-12).** A negative-result artifact: a working context-management prototype for [OpenClaw](https://github.com/openclaw/openclaw), originally built in April 2026 against OpenClaw 2026.4.1 and ported to the 2026.11.3 plugin API before retirement.

中文说明: [README.zh.md](README.zh.md) · Postmortem: [POSTMORTEM.md](POSTMORTEM.md) · Port notes: [PORT_NOTES.md](PORT_NOTES.md) · Security: [SECURITY.md](SECURITY.md)

## What it did

`lean-context` plugged into OpenClaw's `context-engine` slot and ran a four-stage pipeline:

1. **Tool-result slimming** — oversized `exec` / `read` / `fetch` / `search` outputs are trimmed before being persisted to the transcript; originals can be archived and referenced.
2. **Structured compaction** — old history is folded into a `StructuredSessionState` (`goal`, `done`, `open_todos`, `changed_files`, `important_outputs`, `constraints`, `decisions`, `blockers`) instead of a free-form summary.
3. **Context assembly** — recent raw messages + structured state + session memory / hot context + conservative archive recall, with budget rescue and a circuit breaker.
4. **Observability** — per-turn `raw / assembled / compacted` snapshots, categorized savings attribution, a reply footer, and `/lean-context` commands.

## Port status (OpenClaw 2026.11.3)

- TypeScript typecheck against `openclaw@2026.11.3`: passes.
- Unit tests: 29 / 37 pass. The 8 failures are pre-existing assertion drift from tests that could not run on the original Windows host (`vitest` `spawn EPERM`), not regressions from the port. See [PORT_NOTES.md](PORT_NOTES.md#known-failing-tests-pre-existing).
- Transcript reads use OpenClaw's session-identity API (SQLite-backed sessions); `sessionFile` remains only as a legacy fallback.
- Host-memory recall is disabled because the memory search manager is no longer exposed through the public plugin SDK. Archive recall and session memory remain.
- Commands default to the caller's session. Explicit cross-session arguments require `allowCrossSessionCommands: true` and an authorized sender.
- Plugin state files are written with `0600` and directories with `0700` (best-effort `chmod`; no-op on Windows).

## Why archived

- **No host ecosystem.** OpenClaw (formerly Warelay → Clawdbot → Moltbot) never reached the adoption needed to sustain third-party plugins.
- **Plugin API churn.** The plugin hooks the host's context-engine lifecycle; every upstream refactor breaks it. The 2026.4.1 → 2026.11.3 port is the proof.
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

- `index.ts` — plugin entry (context engine, command, hooks)
- `src/` — engine, slimming, compaction, archive, memory, reporting
- `*.test.ts` — vitest suites
- `DESIGN.md` — architecture notes (Chinese)
- `POSTMORTEM.md` — why it was retired (Chinese)
- `PORT_NOTES.md` — 2026.11.3 port details (Chinese)
- `SECURITY.md` — threat model and known limitations
- `TESTING.md`, `PINCHBENCH_TOKEN_STRATEGY.md`, `REPORT_OUTLINE.md`

## Compatibility

Requires OpenClaw **>= 2026.11.3**. Not maintained; not guaranteed to load on later versions.

## License

MIT
