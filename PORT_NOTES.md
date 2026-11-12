# Port Notes — OpenClaw 2026.11.3

**Ported: 2026-11-12**
**From: OpenClaw 2026.4.1 → To: OpenClaw 2026.11.3**

This document records what changed to make `lean-context` load against the current OpenClaw
plugin SDK. It is a compatibility port, not a feature rewrite.

## Verification

- `tsc --noEmit` against `openclaw@2026.11.3`: **passes**
- Unit tests: **29 / 37 pass**; 8 known failures are pre-existing assertion drift (see below)
- Live gateway load: **not verified** in this environment. The plugin registers against the
  published SDK types and a mock `OpenClawPluginApi`; a real `openclaw plugins install` smoke test
  is still recommended.

## API changes handled

1. **`AgentMessage` moved**
   No longer exported by `@mariozechner/pi-agent-core` in this stack. It now comes from
   `openclaw/plugin-sdk/agent-harness-runtime` (re-exported by `src/types.ts`).

2. **`ContextEngine` contract expanded**
   The engine already implemented `bootstrap / ingest / ingestBatch / assemble / compact /
   afterTurn / dispose`. The required changes were:
   - `compact()` no longer receives `sessionFile`. Reads now go through
     `readVisibleSessionTranscriptMessageEntries()` by `sessionTarget` / session id + key.
   - Legacy `sessionFile` is kept only as a fallback for file-backed hosts.
   - `afterTurn()` prefers the runtime transcript target when
     `runtimeContext.transcriptStorage.kind === "sqlite"`.
   - `openclaw/plugin-sdk/session-transcript-runtime` ships without a `types` export condition in
     2026.11.3, so `src/openclaw-shims.d.ts` mirrors the one function used.

3. **Command identity is now available**
   `PluginCommandContext` in 2026.11.3 exposes `sessionId`, `sessionKey`, `sessionTarget`,
   `senderIsOwner`, and `assertOwnerCurrent`. Commands now:
   - default to the caller's own session;
   - require `ctx.isAuthorizedSender`;
   - reject explicit `<sessionId>` / `<sessionKey>` arguments unless
     `allowCrossSessionCommands: true`.

4. **Host memory search is no longer public**
   `getMemorySearchManager` is not exported through the plugin SDK in 2026.11.x. Host-memory recall
   is therefore disabled (`collectRecallSnippets` returns `[]`). Archive recall, structured state,
   session memory, tool-result slimming, and savings reporting are unchanged.

5. **File permissions**
   Session state, ledgers, archives, and pending queues are written with `mode: 0o600`; their
   directories use `mode: 0o700`; a best-effort `chmod` follows each write. This is a no-op on
   Windows and effective on POSIX hosts.

6. **Standalone build**
   `tsconfig.json` no longer extends the OpenClaw monorepo root. Target is ES2023 (the code uses
   `toSorted` / `toReversed`).

## Known failing tests (pre-existing)

These tests exercise pure functions or thresholds that were not changed by the port. The original
project notes that Vitest could not run on the Windows development machine (`spawn EPERM`), so these
assertions were never validated against the shipped behavior. They are left unchanged rather than
rewriting the expected semantics to match current output.

- `session-memory.test.ts` — digest `next_steps` is clipped before the expected phrase.
- `background-context.test.ts` — expects an "Archived context" block; current archive scoring
  omits it.
- `context-fit.test.ts` — expects the tiny session-memory fallback; current fitting keeps state.
- `engine.test.ts` — "injects typed hot context once working-memory soft pressure is reached"
  (token-count expectation).
- `engine.test.ts` — "estimates CJK-heavy text more densely than plain latin text" (equal counts).
- `engine.test.ts` — "archives newly compacted history and restores relevant old excerpts on
  demand" (expects `LEAN CONTEXT ARCHIVE RECOVERY`).
- `engine.test.ts` — "injects hot context before the first compaction once session memory is warm"
  (expects `Immediate next step`).
- `engine.test.ts` — "maintains session memory between turns and reinjects hot context after
  compaction" (expects `Keep warm:`).

Two new tests cover the port surface:

- `index.test.ts` — plugin registers the context engine, command, and hooks with the 2026.11 API.
- `command-scope.test.ts` — authorized-sender gate and cross-session opt-in.

## Compatibility

- Requires OpenClaw **>= 2026.11.3**.
- Older OpenClaw versions are not supported by this port.
- The project remains archived; API drift after 2026.11.3 is not tracked.
