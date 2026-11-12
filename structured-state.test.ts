import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { buildStructuredSessionState } from "./src/structured-state.js";

describe("lean-context structured session state", () => {
  it("extracts goal, changed files, decisions, and blockers", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "Goal: build a lean-context plugin and keep token usage low.",
        timestamp: Date.now(),
      } as AgentMessage,
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Implemented extensions/lean-context/index.ts and updated extensions/lean-context/README.md. We decided to use structured session_state instead of a free-form summary.",
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
            text: "error: missing report file\nwrote C:/repo/openclaw/extensions/lean-context/index.ts",
          },
        ],
        timestamp: Date.now(),
      } as AgentMessage,
    ];

    const state = buildStructuredSessionState({ messages });

    expect(state.goal).toContain("lean-context plugin");
    expect(state.changed_files).toEqual(
      expect.arrayContaining([
        "extensions/lean-context/index.ts",
        "extensions/lean-context/README.md",
      ]),
    );
    expect(state.done.some((item) => /Implemented/.test(item))).toBe(true);
    expect(state.decisions.some((item) => /structured session_state/i.test(item))).toBe(true);
    expect(state.blockers.some((item) => /error/i.test(item))).toBe(true);
  });

  it("treats user constraints separately from tool blockers", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: "We must keep src/app.ts stable and avoid deleting the old migration.",
        timestamp: Date.now(),
      } as AgentMessage,
      {
        role: "assistant",
        content: "Decision: switch to lean-context archive recovery for older details.",
        timestamp: Date.now() + 1,
      } as unknown as AgentMessage,
      {
        role: "toolResult",
        toolName: "exec",
        content: "error: permission denied while writing dist/output.txt",
        timestamp: Date.now() + 2,
      } as unknown as AgentMessage,
    ];

    const state = buildStructuredSessionState({ messages });

    expect(state.constraints.join(" ")).toContain("keep src/app.ts stable");
    expect(state.decisions.join(" ")).toContain("archive recovery");
    expect(state.blockers.join(" ")).toContain("permission denied");
  });
});
