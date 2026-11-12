import type { AgentMessage } from "./src/types.js";
import { describe, expect, it } from "vitest";
import {
  buildSessionMemoryDigest,
  formatSessionMemoryDigest,
  makeHotContextMessage,
} from "./src/session-memory.js";

describe("lean-context session memory", () => {
  it("builds a compact working-memory digest and hot-context reinjection message", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "Please finish the lean-context plugin and keep archive restore working.",
        timestamp: Date.now(),
      } as AgentMessage,
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Implemented extensions/lean-context/src/archive.ts and decided to keep archive restore lightweight. Next: wire session memory into assemble().",
          },
        ],
        timestamp: Date.now(),
      } as AgentMessage,
      {
        role: "toolResult",
        toolName: "exec",
        isError: true,
        content: [
          {
            type: "text",
            text: "error: smoke test failed while importing engine.js",
          },
        ],
        timestamp: Date.now(),
      } as AgentMessage,
    ];

    const digest = buildSessionMemoryDigest({
      messages,
      maxItems: 4,
      maxRecords: 10,
      absoluteMessageCount: messages.length,
    });

    expect(digest.goal).toContain("lean-context plugin");
    expect(digest.active_files.join(" ")).toContain("archive.ts");
    expect(digest.next_steps.join(" ")).toContain("session memory");
    expect(digest.blockers.join(" ")).toContain("error");
    expect(digest.records.some((record) => record.type === "decision")).toBe(true);
    expect(digest.records.some((record) => record.type === "failure_pattern")).toBe(true);
    expect(digest.records.some((record) => record.type === "tool_affordance")).toBe(true);

    const formatted = formatSessionMemoryDigest(digest);
    expect(formatted).toContain("LEAN CONTEXT SESSION MEMORY");
    expect(formatted).toContain("Tool Affordances");

    const hotContext = makeHotContextMessage({
      memory: digest,
      compactedHistory: true,
      maxTokens: 120,
      pressure: "hard",
    });
    expect(JSON.stringify(hotContext)).toContain("LEAN CONTEXT HOT CONTEXT");
    expect(JSON.stringify(hotContext)).toContain("archive.ts");

    const warmHotContext = makeHotContextMessage({
      memory: digest,
      compactedHistory: false,
      allowPreCompact: true,
      maxTokens: 120,
      pressure: "soft",
    });
    expect(JSON.stringify(warmHotContext)).toContain("LEAN CONTEXT HOT CONTEXT");
  });

  it("deduplicates repeated memory records and keeps typed memories fresh", () => {
    const firstTurn: AgentMessage[] = [
      {
        role: "user",
        content: "Prefer qwen for drafting and avoid using read directly on spreadsheets.",
        timestamp: Date.now(),
      } as AgentMessage,
      {
        role: "assistant",
        content: "First use the spreadsheet tool, then summarize the workbook.",
        timestamp: Date.now() + 1,
      } as unknown as AgentMessage,
    ];

    const firstDigest = buildSessionMemoryDigest({
      messages: firstTurn,
      maxItems: 4,
      maxRecords: 8,
      absoluteMessageCount: 2,
    });

    const secondTurn: AgentMessage[] = [
      {
        role: "assistant",
        content: "Prefer qwen for drafting and avoid using read directly on spreadsheets.",
        timestamp: Date.now() + 2,
      } as unknown as AgentMessage,
      {
        role: "toolResult",
        toolName: "spreadsheet",
        content: "Used spreadsheet tool successfully.",
        timestamp: Date.now() + 3,
      } as unknown as AgentMessage,
    ];

    const secondDigest = buildSessionMemoryDigest({
      messages: secondTurn,
      previous: firstDigest,
      maxItems: 4,
      maxRecords: 8,
      absoluteMessageCount: 4,
    });

    const preferences = secondDigest.records.filter((record) => record.type === "preference");
    expect(preferences.length).toBe(1);
    const procedures = secondDigest.records.filter((record) => record.type === "procedure");
    expect(procedures.length).toBeGreaterThan(0);
    const toolAffordances = secondDigest.records.filter(
      (record) => record.type === "tool_affordance",
    );
    expect(toolAffordances.length).toBeGreaterThan(0);
    expect(secondDigest.sourceMessageCount).toBe(4);
  });
});
