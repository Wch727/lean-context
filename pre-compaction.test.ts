import type { AgentMessage } from "./src/types.js";
import { describe, expect, it } from "vitest";
import { stripMessagesForStructuredCompaction } from "./src/pre-compaction.js";

describe("lean-context pre-compaction stripping", () => {
  it("replaces attachments, drops thinking, and simplifies tool calls", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "document",
            path: "docs/spec.pdf",
            payload: "X".repeat(2400),
          },
        ],
        timestamp: Date.now(),
      } as unknown as AgentMessage,
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "secret chain of thought ".repeat(120),
          },
          {
            type: "toolCall",
            name: "read",
            input: {
              path: "docs/spec.pdf",
            },
          },
        ],
        timestamp: Date.now(),
      } as AgentMessage,
    ];

    const result = stripMessagesForStructuredCompaction(messages);

    expect(result.stats.attachmentTrimmedTokens).toBeGreaterThan(0);
    expect(result.stats.thinkingTrimmedTokens).toBeGreaterThan(0);
    expect(result.stats.toolCallCount).toBe(1);
    expect(JSON.stringify(result.messages)).not.toContain("secret chain of thought");
    expect(JSON.stringify(result.messages)).toContain(
      "[document omitted during structured compaction]",
    );
    expect(JSON.stringify(result.messages)).toContain("[tool:read]");
  });
});
