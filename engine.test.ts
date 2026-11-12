import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "./src/types.js";
import { LeanContextEngine, recordPendingSlimming } from "./src/engine.js";
import { estimateMessagesTokens, estimateTextTokens } from "./src/helpers.js";
import {
  ensurePluginStateDirs,
  loadSessionData,
  readArchivedHistorySegments,
  readLatestTurnReport,
  saveSessionData,
} from "./src/store.js";

let tempRoot = "";

function buildHistory(): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let index = 0; index < 8; index += 1) {
    messages.push({
      role: "user",
      content: `Please update file src/module-${index}.ts and keep a record of the decision.`,
      timestamp: Date.now() + index,
    } as AgentMessage);
    messages.push({
      role: "assistant",
      content: [
        {
          type: "text",
          text:
            `Implemented src/module-${index}.ts and decided to keep the structured state. ` +
            "This is a deliberately long assistant update that repeats context to make the raw history large. ".repeat(
              8,
            ),
        },
      ],
      timestamp: Date.now() + index + 1,
    } as AgentMessage);
  }
  return messages;
}

function buildAttachmentHeavyHistory(): AgentMessage[] {
  return [
    {
      role: "user",
      content: [
        {
          type: "document",
          path: "docs/project-spec.pdf",
          payload: "P".repeat(3200),
        },
      ],
      timestamp: Date.now() - 50,
    } as unknown as AgentMessage,
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "internal draft summary ".repeat(160),
        },
        {
          type: "toolCall",
          name: "read",
          input: {
            path: "docs/project-spec.pdf",
          },
        },
      ],
      timestamp: Date.now() - 49,
    } as AgentMessage,
    ...buildHistory(),
  ];
}

async function createSessionFile(messages: AgentMessage[]): Promise<string> {
  const file = path.join(tempRoot, "session.jsonl");
  await fs.writeFile(
    file,
    `${messages.map((message) => JSON.stringify({ message })).join("\n")}\n`,
    "utf8",
  );
  return file;
}

describe("lean-context engine", () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lean-engine-"));
  });

  afterEach(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("assembles a smaller context after structured compaction and writes a turn report", async () => {
    const sessionId = "session-1";
    const sessionKey = "agent:main:test";
    const messages = buildHistory();
    const sessionFile = await createSessionFile(messages);
    const engine = new LeanContextEngine({
      stateRootDir: tempRoot,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      cfg: {} as never,
      config: {
        enableMemoryRecall: false,
        maxRecallResults: 0,
        keepRecentMessages: 4,
        keepRecentTokens: 420,
        autoCompactTriggerTokens: 500,
        workflowHintsEnabled: true,
      },
    });

    const pluginStateDir = await ensurePluginStateDirs(tempRoot);
    const sessionData = await loadSessionData({
      pluginStateDir,
      sessionId,
      sessionKey,
    });
    sessionData.persistentCategoryTotals.tool_result_slimming = 120;
    sessionData.persistentTopContributors = [
      {
        id: "persisted-tool",
        turnId: "older-turn",
        ts: Date.now(),
        sessionId,
        sessionKey,
        category: "tool_result_slimming",
        tokensSaved: 120,
        label: "exec transcript slimming",
      },
    ];
    await saveSessionData({ pluginStateDir, sessionData });

    const compactResult = await engine.compact({
      sessionId,
      sessionKey,
      sessionFile,
      force: true,
      tokenBudget: 700,
    });
    expect(compactResult.compacted).toBe(true);

    const assembled = await engine.assemble({
      sessionId,
      sessionKey,
      messages,
      tokenBudget: 2400,
      prompt: "continue the implementation",
    });
    expect(assembled.estimatedTokens).toBeLessThan(estimateMessagesTokens(messages));
    expect(assembled.systemPromptAddition).toContain(
      "If the user names a deliverable file or exact artifact, update that artifact early instead of only describing a plan.",
    );
    expect(assembled.systemPromptAddition).toContain(
      "Do not use read directly on binary PDFs. If the pdf tool is available, use it first.",
    );
    expect(assembled.systemPromptAddition).toContain(
      "Do not use read directly on binary spreadsheet workbooks. If the spreadsheet tool is available, use it first for .xlsx, .xlsm, or .xls files.",
    );
    expect(assembled.systemPromptAddition).toContain(
      "For large PDFs, spreadsheets, logs, or webpages, prefer targeted extraction and summaries over repeated full rereads.",
    );
    expect(assembled.systemPromptAddition).toContain(
      "For spreadsheet tasks, inspect sheet names, headers, row counts, and numeric summaries before manually rereading raw rows.",
    );
    expect(assembled.systemPromptAddition).toContain(
      "For folders full of emails, notes, or reports, use text_collection first to map subjects, senders, dates, and matching excerpts before opening files one by one.",
    );
    expect(assembled.systemPromptAddition).toContain(
      "For inbox triage or topic search across many local text files, start with text_collection, then read only the few ambiguous files in full.",
    );
    expect(assembled.systemPromptAddition).toContain(
      "Use the timeline, budget/business, and risk highlights from text_collection as scaffolding for synthesis tables and executive summaries.",
    );
    expect(assembled.systemPromptAddition).toContain(
      "For topic summaries spanning many files, write explicit cross-file cause-and-effect links, for example: security findings caused timeline delay, budget changes came from infrastructure costs and later savings, and client feedback informed feature prioritization.",
    );
    expect(assembled.systemPromptAddition).toContain(
      "When the evidence shows original and revised budgets or timelines, name both explicitly instead of only describing the change in general terms.",
    );
    expect(assembled.systemPromptAddition).toContain(
      "If multiple clients, prospects, or feedback sources appear in the folder, mention more than one of them instead of collapsing everything into a single generic customer.",
    );
    expect(assembled.systemPromptAddition).toContain(
      "For long papers or reports, start with the abstract, introduction, and conclusion before diving into appendices or raw page dumps.",
    );
    expect(assembled.systemPromptAddition).toContain(
      "When summarizing a paper, confirm the title and main section headings before writing. If extraction lands in appendices or supplementary material, narrow the page range and try again.",
    );
    expect(assembled.systemPromptAddition).toContain(
      "When the user wants something remembered across sessions, prefer memory_write when available; otherwise persist it to the workspace memory files named by AGENTS.md.",
    );

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        ...messages,
        {
          role: "assistant",
          content: [{ type: "text", text: "Finished the current step." }],
          timestamp: Date.now(),
        } as AgentMessage,
      ],
      prePromptMessageCount: messages.length,
      tokenBudget: 2400,
    });

    const report = await readLatestTurnReport({
      pluginStateDir,
      sessionId,
      sessionKey,
    });
    expect(report).not.toBeNull();
    expect(report?.totalSavedTokens).toBeGreaterThan(0);
    expect(report?.categorySavings.history_compaction).toBeGreaterThan(0);
    expect(report?.categorySavings.tool_result_slimming).toBe(120);
  });

  it("injects typed hot context once working-memory soft pressure is reached before compaction", async () => {
    const sessionId = "session-soft-memory";
    const sessionKey = "agent:main:soft-memory";
    const messages: AgentMessage[] = [
      {
        role: "user",
        content:
          "Prefer qwen for drafting. Avoid using read directly on spreadsheets. Keep the client timeline and revised budget visible. " +
          "This request is intentionally long so the working-memory soft threshold is reached. ".repeat(
            10,
          ),
        timestamp: Date.now(),
      } as AgentMessage,
      {
        role: "assistant",
        content:
          "First use the spreadsheet tool, then summarize the workbook and name both the original and revised budget. " +
          "This is another long assistant turn to create soft working-memory pressure without needing full compaction. ".repeat(
            8,
          ),
        timestamp: Date.now() + 1,
      } as unknown as AgentMessage,
      {
        role: "toolResult",
        toolName: "spreadsheet",
        content:
          "Used spreadsheet tool successfully. revised budget is 150k and timeline moved to Q3.",
        timestamp: Date.now() + 2,
      } as unknown as AgentMessage,
    ];

    const engine = new LeanContextEngine({
      stateRootDir: tempRoot,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      cfg: {} as never,
      config: {
        enableMemoryRecall: false,
        maxRecallResults: 0,
        keepRecentMessages: 4,
        keepRecentTokens: 900,
        autoCompactTriggerTokens: 5000,
        workingMemorySoftTriggerTokens: 400,
        preCompactHotContextMinMessages: 99,
        preCompactHotContextMinTokens: 99999,
      },
    });

    await engine.ingestBatch({
      sessionId,
      sessionKey,
      messages,
    });

    const assembled = await engine.assemble({
      sessionId,
      sessionKey,
      messages,
      tokenBudget: 1800,
      prompt: "continue the spreadsheet task",
    });

    expect(
      assembled.messages.some(
        (message) =>
          JSON.stringify(message).includes("LEAN CONTEXT HOT CONTEXT") &&
          JSON.stringify(message).includes("spreadsheet"),
      ),
    ).toBe(true);
    expect(
      assembled.messages.some((message) => JSON.stringify(message).includes("tool_affordance")),
    ).toBe(false);
    expect(assembled.estimatedTokens).toBeLessThan(estimateMessagesTokens(messages));
  });

  it("tracks proactive compaction failures and opens the circuit breaker", async () => {
    const sessionId = "session-failures";
    const sessionKey = "agent:main:failures";
    const messages = buildHistory();
    const sessionFile = await createSessionFile(messages);
    const engine = new LeanContextEngine({
      stateRootDir: tempRoot,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      cfg: {} as never,
      config: {
        enableMemoryRecall: false,
        maxRecallResults: 0,
        autoCompactTriggerTokens: 1,
        maxConsecutiveAutoCompactFailures: 2,
      },
    });
    const pluginStateDir = await ensurePluginStateDirs(tempRoot);

    const compactSpy = vi.spyOn(engine, "compact").mockRejectedValueOnce(new Error("boom"));
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages,
      prePromptMessageCount: messages.length,
      tokenBudget: 400,
    });

    let sessionData = await loadSessionData({
      pluginStateDir,
      sessionId,
      sessionKey,
    });
    expect(sessionData.consecutiveAutoCompactFailures).toBe(1);
    expect(sessionData.lastAutoCompactFailureReason).toContain("boom");
    expect(sessionData.summary.statusNotices?.[0]).toContain("minimal fallback state");
    expect(
      Boolean(sessionData.fallbackState.goal) || sessionData.fallbackState.changed_files.length > 0,
    ).toBe(true);
    compactSpy.mockRestore();

    const assembledAfterFailure = await engine.assemble({
      sessionId,
      sessionKey,
      messages,
      tokenBudget: 400,
      prompt: "continue",
    });
    expect(assembledAfterFailure.estimatedTokens).toBeLessThan(estimateMessagesTokens(messages));
    expect(assembledAfterFailure.systemPromptAddition).toBeUndefined();

    await saveSessionData({
      pluginStateDir,
      sessionData: {
        ...sessionData,
        consecutiveAutoCompactFailures: 2,
      },
    });

    const breakerSpy = vi.spyOn(engine, "compact");
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages,
      prePromptMessageCount: messages.length,
      tokenBudget: 400,
    });
    expect(breakerSpy).not.toHaveBeenCalled();
    breakerSpy.mockRestore();

    sessionData = await loadSessionData({
      pluginStateDir,
      sessionId,
      sessionKey,
    });
    expect(sessionData.summary.statusNotices?.[0]).toContain("Auto-compaction is paused");
    expect(sessionData.summary.statusNotices?.[0]).toContain("fallback mode");
  });

  it("resets compaction failures after a successful compaction", async () => {
    const sessionId = "session-reset";
    const sessionKey = "agent:main:reset";
    const messages = buildHistory();
    const sessionFile = await createSessionFile(messages);
    const engine = new LeanContextEngine({
      stateRootDir: tempRoot,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      cfg: {} as never,
      config: {
        enableMemoryRecall: false,
        maxRecallResults: 0,
        keepRecentMessages: 3,
        keepRecentTokens: 320,
      },
    });
    const pluginStateDir = await ensurePluginStateDirs(tempRoot);
    const sessionData = await loadSessionData({
      pluginStateDir,
      sessionId,
      sessionKey,
    });
    await saveSessionData({
      pluginStateDir,
      sessionData: {
        ...sessionData,
        consecutiveAutoCompactFailures: 2,
        lastAutoCompactFailureReason: "previous boom",
      },
    });

    const compactResult = await engine.compact({
      sessionId,
      sessionKey,
      sessionFile,
      force: true,
      tokenBudget: 500,
    });

    expect(compactResult.compacted).toBe(true);
    const nextSessionData = await loadSessionData({
      pluginStateDir,
      sessionId,
      sessionKey,
    });
    expect(nextSessionData.consecutiveAutoCompactFailures).toBe(0);
    expect(nextSessionData.lastAutoCompactFailureReason).toBeUndefined();
    expect(nextSessionData.lastCompactionTrigger).toBe("forced");
  });

  it("incrementally compacts beyond the previous boundary and rebuilds state when the transcript shrinks", async () => {
    const sessionId = "session-incremental";
    const sessionKey = "agent:main:incremental";
    const baseMessages = buildAttachmentHeavyHistory();
    const engine = new LeanContextEngine({
      stateRootDir: tempRoot,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      cfg: {} as never,
      config: {
        enableMemoryRecall: false,
        maxRecallResults: 0,
        keepRecentMessages: 3,
        keepRecentTokens: 320,
        minMessagesToCompact: 2,
      },
    });
    const pluginStateDir = await ensurePluginStateDirs(tempRoot);

    let sessionFile = await createSessionFile(baseMessages);
    const firstResult = await engine.compact({
      sessionId,
      sessionKey,
      sessionFile,
      force: true,
      tokenBudget: 520,
    });

    expect(firstResult.compacted).toBe(true);
    const firstSessionData = await loadSessionData({
      pluginStateDir,
      sessionId,
      sessionKey,
    });

    const extendedMessages = [
      ...baseMessages,
      {
        role: "user",
        content: "Please also update src/module-8.ts and note the rollout blocker.",
        timestamp: Date.now() + 100,
      } as AgentMessage,
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Implemented src/module-8.ts, decided to keep rollout guarded, and hit a blocker waiting on review. ".repeat(
              5,
            ),
          },
        ],
        timestamp: Date.now() + 101,
      } as AgentMessage,
    ];
    sessionFile = await createSessionFile(extendedMessages);
    const secondResult = await engine.compact({
      sessionId,
      sessionKey,
      sessionFile,
      force: true,
      tokenBudget: 520,
    });

    expect(secondResult.compacted).toBe(true);
    expect(
      (
        secondResult.result.details as {
          stripping?: { notes?: string[] };
        }
      ).stripping?.notes?.some((note) => note.includes("Incremental compaction only processed")),
    ).toBe(true);
    const secondSessionData = await loadSessionData({
      pluginStateDir,
      sessionId,
      sessionKey,
    });
    expect(secondSessionData.compactedThroughMessageCount).toBeGreaterThan(
      firstSessionData.compactedThroughMessageCount,
    );
    expect(secondSessionData.compactedPrefixSanitizedTokens).toBeGreaterThan(
      firstSessionData.compactedPrefixSanitizedTokens,
    );

    const truncatedMessages = extendedMessages.slice(-6);
    sessionFile = await createSessionFile(truncatedMessages);
    const thirdResult = await engine.compact({
      sessionId,
      sessionKey,
      sessionFile,
      force: true,
      tokenBudget: 360,
    });

    expect(thirdResult.compacted).toBe(true);
    expect(
      (
        thirdResult.result.details as {
          stripping?: { notes?: string[] };
        }
      ).stripping?.notes?.some((note) =>
        note.includes("Compaction boundary reset because the available transcript prefix shrank"),
      ),
    ).toBe(true);
    const thirdSessionData = await loadSessionData({
      pluginStateDir,
      sessionId,
      sessionKey,
    });
    expect(thirdSessionData.compactedThroughMessageCount).toBeLessThan(
      secondSessionData.compactedThroughMessageCount,
    );
    expect(thirdSessionData.state.changed_files.some((file) => file.includes("module-0"))).toBe(
      false,
    );
  });

  it("attributes attachment trimming from pre-compaction stripping", async () => {
    const sessionId = "session-attachments";
    const sessionKey = "agent:main:attachments";
    const messages = buildAttachmentHeavyHistory();
    const sessionFile = await createSessionFile(messages);
    const engine = new LeanContextEngine({
      stateRootDir: tempRoot,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      cfg: {} as never,
      config: {
        enableMemoryRecall: false,
        maxRecallResults: 0,
        keepRecentMessages: 4,
        keepRecentTokens: 420,
      },
    });

    const compactResult = await engine.compact({
      sessionId,
      sessionKey,
      sessionFile,
      force: true,
      tokenBudget: 700,
    });

    expect(compactResult.compacted).toBe(true);
    expect(
      (compactResult.result.details as { stripping?: { attachmentTrimmedTokens?: number } })
        .stripping?.attachmentTrimmedTokens ?? 0,
    ).toBeGreaterThan(0);

    await engine.assemble({
      sessionId,
      sessionKey,
      messages,
      tokenBudget: 2600,
      prompt: "continue",
    });

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages,
      prePromptMessageCount: messages.length,
      tokenBudget: 2600,
    });

    const pluginStateDir = await ensurePluginStateDirs(tempRoot);
    const report = await readLatestTurnReport({
      pluginStateDir,
      sessionId,
      sessionKey,
    });
    expect(report?.categorySavings.attachment_trimming).toBeGreaterThan(0);
  });

  it("bypasses low-yield turns without injecting prompt additions or writing reports", async () => {
    const sessionId = "session-bypass";
    const sessionKey = "agent:main:bypass";
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "ok",
        timestamp: Date.now(),
      } as AgentMessage,
    ];
    const sessionFile = await createSessionFile(messages);
    const engine = new LeanContextEngine({
      stateRootDir: tempRoot,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      cfg: {} as never,
      config: {
        assembleBypassMaxTokens: 256,
        enableMemoryRecall: true,
        dynamicSystemPromptAddition: true,
      },
    });

    const assembled = await engine.assemble({
      sessionId,
      sessionKey,
      messages,
      tokenBudget: 1600,
      prompt: "ok",
    });

    expect(assembled.messages).toEqual(messages);
    expect(assembled.systemPromptAddition).toBeUndefined();

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages,
      prePromptMessageCount: messages.length,
      tokenBudget: 1600,
    });

    const pluginStateDir = await ensurePluginStateDirs(tempRoot);
    const report = await readLatestTurnReport({
      pluginStateDir,
      sessionId,
      sessionKey,
    });
    expect(report).toBeNull();
  });

  it("ingests batches incrementally into session memory and skips empty heartbeat acknowledgements", async () => {
    const sessionId = "session-ingest";
    const sessionKey = "agent:main:ingest";
    const engine = new LeanContextEngine({
      stateRootDir: tempRoot,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      cfg: {} as never,
      config: {
        enableMemoryRecall: false,
        maxRecallResults: 0,
      },
    });
    const pluginStateDir = await ensurePluginStateDirs(tempRoot);

    const result = await engine.ingestBatch({
      sessionId,
      sessionKey,
      messages: [
        {
          role: "user",
          content: "Please remember that src/ingest.ts still needs review.",
          timestamp: Date.now(),
        } as AgentMessage,
        {
          role: "assistant",
          content: [{ type: "text", text: "Decision: keep the incremental ingest path." }],
          timestamp: Date.now() + 1,
        } as AgentMessage,
      ],
    });
    expect(result.ingestedCount).toBe(2);

    let sessionData = await loadSessionData({
      pluginStateDir,
      sessionId,
      sessionKey,
    });
    expect(sessionData.sessionMemory.sourceMessageCount).toBe(2);
    expect(
      sessionData.sessionMemory.active_files.some((file) => file.includes("src/ingest.ts")),
    ).toBe(true);
    expect(
      sessionData.sessionMemory.active_decisions.some((decision) =>
        decision.includes("incremental ingest path"),
      ),
    ).toBe(true);

    const heartbeatResult = await engine.ingest({
      sessionId,
      sessionKey,
      isHeartbeat: true,
      message: {
        role: "assistant",
        content: "HEARTBEAT_OK",
        timestamp: Date.now() + 2,
      } as unknown as AgentMessage,
    });
    expect(heartbeatResult.ingested).toBe(false);

    sessionData = await loadSessionData({
      pluginStateDir,
      sessionId,
      sessionKey,
    });
    expect(sessionData.sessionMemory.sourceMessageCount).toBe(2);
  });

  it("injects only the compression notice by default once lean-context is active", async () => {
    const sessionId = "session-compression-notice";
    const sessionKey = "agent:main:compression-notice";
    const messages = buildHistory();
    const sessionFile = await createSessionFile(messages);
    const engine = new LeanContextEngine({
      stateRootDir: tempRoot,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      cfg: {} as never,
      config: {
        enableMemoryRecall: false,
        maxRecallResults: 0,
        keepRecentMessages: 4,
        keepRecentTokens: 420,
      },
    });

    await engine.compact({
      sessionId,
      sessionKey,
      sessionFile,
      force: true,
      tokenBudget: 700,
    });

    const assembled = await engine.assemble({
      sessionId,
      sessionKey,
      messages,
      tokenBudget: 1800,
      prompt: "continue the implementation",
    });

    expect(assembled.systemPromptAddition).toContain(
      "Lean-context compressed the older transcript before this turn.",
    );
    expect(assembled.systemPromptAddition).not.toContain(
      "Do not use read directly on binary PDFs. If the pdf tool is available, use it first.",
    );
  });

  it("estimates CJK-heavy text more densely than plain latin text", () => {
    expect(estimateTextTokens("hello world hello world")).toBeLessThan(
      estimateTextTokens("你好世界你好世界"),
    );
  });

  it("archives newly compacted history and restores relevant old excerpts on demand", async () => {
    const sessionId = "session-archive-recovery";
    const sessionKey = "agent:main:archive-recovery";
    const messages = buildHistory();
    const sessionFile = await createSessionFile(messages);
    const engine = new LeanContextEngine({
      stateRootDir: tempRoot,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      cfg: {} as never,
      config: {
        enableMemoryRecall: false,
        maxRecallResults: 0,
        archiveRecoveryMaxTokens: 480,
        archiveRecoveryMinScore: 2,
        keepRecentMessages: 3,
        keepRecentTokens: 320,
      },
    });

    const compactResult = await engine.compact({
      sessionId,
      sessionKey,
      sessionFile,
      force: true,
      tokenBudget: 620,
    });
    expect(compactResult.compacted).toBe(true);

    const pluginStateDir = await ensurePluginStateDirs(tempRoot);
    const archived = await readArchivedHistorySegments({
      pluginStateDir,
      sessionId,
      sessionKey,
    });
    expect(archived.length).toBeGreaterThan(0);
    expect(archived[0]?.messageCount).toBeGreaterThan(0);
    expect(JSON.stringify(archived[0]?.messages ?? [])).toContain("src/module-0.ts");

    const assembled = await engine.assemble({
      sessionId,
      sessionKey,
      messages,
      tokenBudget: 2200,
      prompt: "What did we say earlier about src/module-0.ts and why did we keep that decision?",
    });

    const serialized = JSON.stringify(assembled.messages);
    expect(serialized).toContain("LEAN CONTEXT ARCHIVE RECOVERY");
    expect(serialized).toContain("src/module-0.ts");
  });

  it("persists pending slimming events across engine instances", async () => {
    const sessionId = "session-pending-slimming";
    const sessionKey = "agent:main:pending-slimming";
    const messages = buildHistory().slice(0, 2);
    const sessionFile = await createSessionFile(messages);
    const pluginStateDir = await ensurePluginStateDirs(tempRoot);

    recordPendingSlimming({
      stateRootDir: tempRoot,
      sessionIdentity: sessionKey,
      events: [
        {
          id: "persisted-event",
          turnId: "turn-persisted",
          ts: Date.now(),
          sessionId,
          sessionKey,
          category: "tool_result_slimming",
          tokensSaved: 180,
          label: "persisted exec slimming",
        },
      ],
    });

    const engine = new LeanContextEngine({
      stateRootDir: tempRoot,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      cfg: {} as never,
      config: {
        enableMemoryRecall: false,
        maxRecallResults: 0,
      },
    });

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages,
      prePromptMessageCount: messages.length,
      tokenBudget: 1600,
    });

    const sessionData = await loadSessionData({
      pluginStateDir,
      sessionId,
      sessionKey,
    });
    expect(sessionData.persistentCategoryTotals.tool_result_slimming).toBe(180);
  });

  it("clears fallback state after healthy low-pressure turns", async () => {
    const sessionId = "session-fallback-clear";
    const sessionKey = "agent:main:fallback-clear";
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "thanks",
        timestamp: Date.now(),
      } as AgentMessage,
    ];
    const sessionFile = await createSessionFile(messages);
    const engine = new LeanContextEngine({
      stateRootDir: tempRoot,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      cfg: {} as never,
      config: {
        enableMemoryRecall: false,
        maxRecallResults: 0,
        fallbackStateSuccessTurnsToClear: 1,
        autoCompactTriggerTokens: 2000,
      },
    });
    const pluginStateDir = await ensurePluginStateDirs(tempRoot);
    const sessionData = await loadSessionData({
      pluginStateDir,
      sessionId,
      sessionKey,
    });
    await saveSessionData({
      pluginStateDir,
      sessionData: {
        ...sessionData,
        consecutiveAutoCompactFailures: 2,
        lastAutoCompactFailureReason: "boom",
        fallbackStateActive: true,
        fallbackState: {
          goal: "Recover the previous session state",
          done: [],
          open_todos: ["retry compaction later"],
          changed_files: ["src/fallback.ts"],
          important_outputs: [],
          constraints: [],
          decisions: [],
          blockers: ["auto-compaction failed"],
        },
      },
    });

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages,
      prePromptMessageCount: messages.length,
      tokenBudget: 1600,
    });

    const cleared = await loadSessionData({
      pluginStateDir,
      sessionId,
      sessionKey,
    });
    expect(cleared.fallbackStateActive).toBe(false);
    expect(cleared.consecutiveAutoCompactFailures).toBe(0);
    expect(cleared.fallbackState.goal).toBe("");
  });

  it("injects hot context before the first compaction once session memory is warm", async () => {
    const sessionId = "session-precompact-hot-context";
    const sessionKey = "agent:main:precompact-hot-context";
    const messages = buildHistory();
    const sessionFile = await createSessionFile(messages);
    const engine = new LeanContextEngine({
      stateRootDir: tempRoot,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      cfg: {} as never,
      config: {
        enableMemoryRecall: false,
        maxRecallResults: 0,
        enableSessionMemory: true,
        hotContextEnabled: true,
        preCompactHotContextMinMessages: 2,
        preCompactHotContextMinTokens: 0,
      },
    });

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages,
      prePromptMessageCount: Math.max(0, messages.length - 2),
      tokenBudget: 2600,
    });

    const assembled = await engine.assemble({
      sessionId,
      sessionKey,
      messages,
      tokenBudget: 2600,
      prompt: "continue the same work",
    });

    const serialized = JSON.stringify(assembled.messages);
    expect(serialized).toContain("LEAN CONTEXT HOT CONTEXT");
    expect(serialized).toContain("Immediate next step");
  });

  it("calibrates token estimation from observed prompt usage", async () => {
    const sessionId = "session-calibration";
    const sessionKey = "agent:main:calibration";
    const messages = buildHistory().slice(0, 4);
    const sessionFile = await createSessionFile(messages);
    const engine = new LeanContextEngine({
      stateRootDir: tempRoot,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      cfg: {} as never,
      config: {
        enableMemoryRecall: false,
        maxRecallResults: 0,
        tokenCalibrationEnabled: true,
        tokenCalibrationAlpha: 0.5,
      },
    });
    const pluginStateDir = await ensurePluginStateDirs(tempRoot);

    await engine.assemble({
      sessionId,
      sessionKey,
      messages,
      tokenBudget: 2400,
      model: "modelstudio/qwen3.6-plus-2026-04-02",
      prompt: "continue the implementation",
    });
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        ...messages,
        {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          usage: { promptTokens: 1200 },
          timestamp: Date.now(),
        } as unknown as AgentMessage,
      ],
      prePromptMessageCount: messages.length,
      tokenBudget: 2400,
      runtimeContext: {
        model: "modelstudio/qwen3.6-plus-2026-04-02",
      },
    });

    const sessionData = await loadSessionData({
      pluginStateDir,
      sessionId,
      sessionKey,
    });
    expect(sessionData.tokenEstimatorCalibration.sampleCount).toBe(1);
    expect(sessionData.tokenEstimatorCalibration.promptScale).not.toBe(1);
    expect(sessionData.tokenEstimatorCalibration.modelFamily).toBe("qwen");
  });

  it("maintains session memory between turns and reinjects hot context after compaction", async () => {
    const sessionId = "session-memory-hot-context";
    const sessionKey = "agent:main:memory-hot-context";
    const messages = buildHistory();
    const sessionFile = await createSessionFile(messages);
    const engine = new LeanContextEngine({
      stateRootDir: tempRoot,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      cfg: {} as never,
      config: {
        enableMemoryRecall: false,
        maxRecallResults: 0,
        enableSessionMemory: true,
        hotContextEnabled: true,
        sessionMemoryMaxItems: 4,
        keepRecentMessages: 3,
        keepRecentTokens: 320,
      },
    });

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages,
      prePromptMessageCount: Math.max(0, messages.length - 2),
      tokenBudget: 2400,
    });

    const pluginStateDir = await ensurePluginStateDirs(tempRoot);
    const storedBeforeCompaction = await loadSessionData({
      pluginStateDir,
      sessionId,
      sessionKey,
    });
    expect(storedBeforeCompaction.sessionMemory.summary).toContain("Goal:");
    expect(storedBeforeCompaction.sessionMemory.active_files.join(" ")).toContain("src/module");

    await engine.compact({
      sessionId,
      sessionKey,
      sessionFile,
      force: true,
      tokenBudget: 700,
    });

    const assembled = await engine.assemble({
      sessionId,
      sessionKey,
      messages,
      tokenBudget: 2200,
      prompt: "Continue the implementation without losing the active file context.",
    });
    const serialized = JSON.stringify(assembled.messages);
    expect(serialized).toContain("LEAN CONTEXT HOT CONTEXT");
    expect(serialized).toContain("Keep warm:");
  });
});
