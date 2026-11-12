import { describe, expect, it } from "vitest";
import {
  buildArchiveRecoveryMessage,
  buildArchivedHistorySegment,
  formatArchiveIndexForCommand,
  formatArchiveRestoreForCommand,
  searchArchivedHistory,
} from "./src/archive.js";
import { DEFAULT_LEAN_CONTEXT_CONFIG } from "./src/config.js";
import type { AgentMessage, LeanContextConfig } from "./src/types.js";

function buildMessage(role: "user" | "assistant", text: string): AgentMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as AgentMessage;
}

describe("lean-context archive recovery", () => {
  it("builds searchable compacted history segments and formats restore results", () => {
    const segment = buildArchivedHistorySegment({
      sessionId: "session-1",
      sessionKey: "agent:main:test",
      startMessageIndex: 0,
      createdAt: new Date().toISOString(),
      messages: [
        buildMessage("user", "Please update src/module-7.ts and keep the decision documented."),
        buildMessage(
          "assistant",
          "We decided to keep src/module-7.ts on the structured state path because it keeps the transcript smaller.",
        ),
      ],
    });
    expect(segment).not.toBeNull();

    const config: LeanContextConfig = {
      ...DEFAULT_LEAN_CONTEXT_CONFIG,
      archiveRecoveryMinScore: 2,
      archiveRecoveryMaxSegments: 1,
    };
    const hits = searchArchivedHistory({
      segments: segment ? [segment] : [],
      query: "What did we say earlier about src/module-7.ts?",
      config,
    });
    expect(hits.length).toBe(1);
    expect(hits[0]?.matchedTerms.join(" ")).toContain("src/module-7.ts");

    const message = buildArchiveRecoveryMessage({
      hits,
      maxTokens: 320,
    });
    expect(JSON.stringify(message)).toContain("LEAN CONTEXT ARCHIVE BACKGROUND");

    const archiveIndex = formatArchiveIndexForCommand(segment ? [segment] : []);
    expect(archiveIndex).toContain("Lean Context Archive");
    expect(archiveIndex).toContain("src/module-7.ts");

    const restoreText = formatArchiveRestoreForCommand({
      query: "src/module-7.ts",
      hits,
    });
    expect(restoreText).toContain("Lean Context Restore");
    expect(restoreText).toContain("src/module-7.ts");
  });

  it("penalizes long archive segments and prefers denser recovery hits", () => {
    const concise = buildArchivedHistorySegment({
      sessionId: "session-2",
      sessionKey: "agent:main:test",
      startMessageIndex: 0,
      createdAt: new Date().toISOString(),
      messages: [
        buildMessage("user", "Please keep the rollback plan for src/router.ts."),
        buildMessage("assistant", "Decision: keep the rollback plan for src/router.ts."),
      ],
    });
    const verbose = buildArchivedHistorySegment({
      sessionId: "session-2",
      sessionKey: "agent:main:test",
      startMessageIndex: 2,
      createdAt: new Date().toISOString(),
      messages: [
        buildMessage(
          "assistant",
          `We discussed src/router.ts in a very long way. ${"rollback plan details ".repeat(120)}`,
        ),
      ],
    });
    const hits = searchArchivedHistory({
      segments: [verbose, concise].filter(
        (segment): segment is NonNullable<typeof segment> => segment != null,
      ),
      query: "what was the rollback plan for src/router.ts",
      config: {
        ...DEFAULT_LEAN_CONTEXT_CONFIG,
        archiveRecoveryMinScore: 1,
        archiveRecoveryMaxSegments: 2,
        archiveRecoveryTokenCostWeight: 0.8,
      } satisfies LeanContextConfig,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.segment.archiveId).toBe(concise?.archiveId);

    const recoveryMessage = buildArchiveRecoveryMessage({
      hits,
      maxTokens: 120,
    });
    expect(JSON.stringify(recoveryMessage)).toContain("BACKGROUND");
    expect(JSON.stringify(recoveryMessage)).not.toContain("messages 1-");
  });
});
