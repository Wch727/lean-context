import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { buildArchivedHistorySegment, searchArchivedHistory } from "./src/archive.js";
import { buildBackgroundContextMessage } from "./src/background-context.js";
import { DEFAULT_LEAN_CONTEXT_CONFIG } from "./src/config.js";
import { buildProceduralMemoryDigest } from "./src/session-memory.js";

describe("lean-context background synthesis", () => {
  it("builds compact background knowledge from procedural memory and archive hits", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content:
          "Prefer qwen for drafting. First use the spreadsheet tool, then summarize the workbook.",
        timestamp: Date.now(),
      } as AgentMessage,
      {
        role: "toolResult",
        toolName: "spreadsheet",
        content: "error: revised budget was not extracted on the first pass",
        timestamp: Date.now() + 1,
      } as unknown as AgentMessage,
    ];
    const proceduralMemory = buildProceduralMemoryDigest({
      messages,
      maxItems: 4,
      absoluteMessageCount: messages.length,
    });
    const segment = buildArchivedHistorySegment({
      sessionId: "session-bg",
      sessionKey: "agent:test",
      startMessageIndex: 0,
      createdAt: new Date().toISOString(),
      messages: [
        {
          role: "assistant",
          content:
            "Decision: keep the revised budget and original budget both explicit in the final summary.",
          timestamp: Date.now() + 2,
        } as unknown as AgentMessage,
      ],
    });
    const archiveHits = searchArchivedHistory({
      segments: segment ? [segment] : [],
      query: "revised budget summary",
      config: {
        ...DEFAULT_LEAN_CONTEXT_CONFIG,
        archiveRecoveryMinScore: 1,
      },
    });

    const message = buildBackgroundContextMessage({
      proceduralMemory,
      archiveHits,
      recallSnippets: [
        {
          source: "memory",
          snippet: "User prefers qwen for drafting financial summaries.",
        },
      ],
      maxTokens: 180,
    });

    expect(JSON.stringify(proceduralMemory)).toContain("spreadsheet");
    expect(JSON.stringify(message)).toContain("BACKGROUND KNOWLEDGE");
    expect(JSON.stringify(message)).toContain("Workflow");
    expect(JSON.stringify(message)).toContain("Archived context");
  });
});
