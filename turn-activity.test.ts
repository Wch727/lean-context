import { describe, expect, it } from "vitest";
import { deriveTurnActivity } from "./src/turn-activity.js";
import type { AgentMessage, SavingsEvent } from "./src/types.js";

describe("lean-context turn activity", () => {
  it("derives a concise label from tool usage", () => {
    const messages = [
      {
        role: "toolResult",
        toolName: "text_collection",
        content: [{ type: "text", text: "Mapped emails and notes" }],
        timestamp: Date.now(),
      } as AgentMessage,
    ];
    const events = [
      {
        id: "1",
        turnId: "turn-1",
        ts: Date.now(),
        sessionId: "session-1",
        category: "tool_result_slimming",
        tokensSaved: 120,
        label: "text_collection transcript slimming",
        toolName: "text_collection",
      } as SavingsEvent,
    ];

    const activity = deriveTurnActivity({
      messages,
      savingsEvents: events,
    });

    expect(activity.label).toBe("Scanned text collection");
    expect(activity.detail).toContain("emails, notes, or reports");
  });
});
