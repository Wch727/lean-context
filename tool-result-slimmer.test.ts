import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LEAN_CONTEXT_CONFIG } from "./src/config.js";
import { slimToolResultForPersistence } from "./src/tool-result-slimmer.js";
import type { AgentMessage } from "./src/types.js";

let tempRoot = "";

function createToolResultText(): string {
  const stdout = Array.from({ length: 120 }, (_, index) => `line ${index + 1}: working...`).join(
    "\n",
  );
  return JSON.stringify({
    exitCode: 1,
    stdout,
    stderr: "fatal: missing file\nstack trace line 1\nstack trace line 2",
  });
}

function firstTextBlock(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  const block = content.find(
    (entry): entry is { type: string; text?: string } =>
      Boolean(entry) && typeof entry === "object" && (entry as { type?: unknown }).type === "text",
  );
  return block?.text ?? "";
}

describe("lean-context tool_result_persist", () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lean-context-"));
  });

  afterEach(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("slims large tool results before transcript persistence", async () => {
    const result = slimToolResultForPersistence({
      config: {
        ...DEFAULT_LEAN_CONTEXT_CONFIG,
        maxToolResultTokens: 20,
        enableMemoryRecall: false,
        persistLargeToolResults: true,
      },
      stateRootDir: tempRoot,
      sessionId: "session-1",
      sessionKey: "agent:main:test",
      toolName: "exec",
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "exec",
        content: [{ type: "text", text: createToolResultText() }],
        isError: true,
        timestamp: Date.now(),
      } as AgentMessage,
    });

    expect(result.changed).toBe(true);
    expect(result.events.length).toBeGreaterThan(0);

    const text = firstTextBlock(result.message);
    expect(text).toContain("LEAN TOOL RESULT: exec");
    expect(text).toContain("exit_code=1");
    expect(text).toContain("stderr_excerpt:");
    expect(text).toContain("stdout_tail:");
    expect(text).toContain("full_output_saved=");
    expect(text).not.toContain('"line 1: working..."');
    expect(text.length).toBeLessThan(createToolResultText().length / 3);

    const archivedPath = /full_output_saved=(.+)/.exec(text)?.[1]?.trim();
    expect(archivedPath).toBeTruthy();
    await expect(fs.stat(archivedPath as string)).resolves.toBeTruthy();
  });
});
