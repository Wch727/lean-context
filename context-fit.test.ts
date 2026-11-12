import { describe, expect, it } from "vitest";
import { fitContextToBudget } from "./src/context-fit.js";
import type { AgentMessage, StructuredSessionState } from "./src/types.js";

function buildMessage(role: "user" | "assistant", text: string): AgentMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as AgentMessage;
}

describe("lean-context context fitting", () => {
  it("rescues oversized assembled context by trimming bootstrap guidance and state", () => {
    const state: StructuredSessionState = {
      goal: "Finish Project Alpha summary with explicit original and revised budget, timeline, and client feedback coverage.",
      done: [
        "Read several long documents and transcripts about Project Alpha.".repeat(4),
        "Collected cost, delivery, and risk details from multiple files.".repeat(4),
      ],
      open_todos: [
        "Write a concise summary with original and revised numbers.".repeat(4),
        "Mention multiple customers instead of one generic client.".repeat(4),
      ],
      changed_files: ["reports/alpha.md", "notes/alpha-summary.md", "memory/2026-04-03.md"],
      important_outputs: ["Budget moved from $340K to $432K before savings were found.".repeat(4)],
      constraints: ["Do not lose the latest user request or the newest work context.".repeat(3)],
      decisions: ["Use text_collection before opening files one by one.".repeat(3)],
      blockers: ["The current assembled context is too large for the tiny test budget.".repeat(4)],
    };
    const result = fitContextToBudget({
      state,
      hotContextMessage: null,
      recoveryMessage: null,
      recallMessage: buildMessage(
        "assistant",
        "LEAN CONTEXT RECALL\n- memory/alpha.md\n  earlier note",
      ),
      recentMessages: [
        buildMessage("user", "Please summarize Project Alpha."),
        buildMessage("assistant", "Working through the budget and timeline changes now."),
      ],
      systemPromptAddition:
        "Lean-context compressed the older transcript before this turn. ".repeat(40),
      tokenBudget: 140,
      minimumRecentMessages: 1,
    });

    expect(result.rescueApplied).toBe(true);
    expect(result.estimatedTokens).toBeLessThanOrEqual(140);
    expect(result.bootstrapTrimmedTokens).toBeGreaterThan(0);
    expect(result.systemPromptAddition).toBeUndefined();
    expect(result.recentMessages.length).toBeGreaterThanOrEqual(1);
  });

  it("falls back to a tiny session memory digest before dropping state entirely", () => {
    const state: StructuredSessionState = {
      goal: "Ship the lean-context plugin with resilient compaction and clear savings reporting.",
      done: ["Implemented transcript slimming.".repeat(8)],
      open_todos: ["Verify the next benchmark run with the new compaction rescue path.".repeat(4)],
      changed_files: ["extensions/lean-context/src/engine.ts"],
      important_outputs: ["Saved 40k tokens in one benchmark task.".repeat(4)],
      constraints: ["Do not drop the latest user goal.".repeat(4)],
      decisions: ["Prefer a concise memory digest over dropping all prior state.".repeat(3)],
      blockers: ["The token budget in this test is intentionally tiny.".repeat(4)],
    };

    const result = fitContextToBudget({
      state,
      hotContextMessage: null,
      recoveryMessage: null,
      recallMessage: null,
      recentMessages: [buildMessage("user", "Continue.")],
      tokenBudget: 140,
      minimumRecentMessages: 1,
    });

    expect(result.stateMessage).not.toBeNull();
    expect(JSON.stringify(result.stateMessage)).toContain("LEAN CONTEXT SESSION MEMORY");
    expect(result.rescueNotes.join(" ")).toContain("session memory digest");
  });
});
