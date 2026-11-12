import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { createEmptyPluginRegistry } from "openclaw/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardSessionManager } from "../../src/agents/session-tool-result-guard-wrapper.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../src/plugins/hook-runner-global.js";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import plugin from "./index.js";

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

function getPersistedToolResult(sm: ReturnType<typeof SessionManager.inMemory>) {
  return sm
    .getEntries()
    .filter((entry) => entry.type === "message")
    .map((entry) => (entry as { message: AgentMessage }).message)
    .find((message) => message.role === "toolResult");
}

function registerToolPersistHook() {
  let handler:
    | ((
        event: { message: AgentMessage; toolName?: string },
        ctx: { sessionKey?: string; agentId?: string },
      ) => { message?: AgentMessage } | void)
    | undefined;
  plugin.register(
    createTestPluginApi({
      id: "lean-context",
      name: "Lean Context",
      source: "test",
      config: {} as never,
      pluginConfig: {
        maxToolResultTokens: 20,
        enableMemoryRecall: false,
        persistLargeToolResults: true,
      },
      runtime: {
        state: {
          resolveStateDir: () => tempRoot,
        },
      } as never,
      on: (hookName, nextHandler) => {
        if (hookName === "tool_result_persist") {
          handler = nextHandler as typeof handler;
        }
      },
      registerContextEngine() {},
      registerCommand() {},
    }) as never,
  );
  if (!handler) {
    throw new Error("lean-context did not register tool_result_persist");
  }
  return handler;
}

describe("lean-context tool_result_persist", () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lean-context-"));
  });

  afterEach(async () => {
    resetGlobalHookRunner();
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("slims large tool results before transcript persistence", async () => {
    const handler = registerToolPersistHook();
    const registry = createEmptyPluginRegistry();
    registry.plugins.push({ id: "lean-context", status: "loaded" } as never);
    registry.typedHooks.push({
      pluginId: "lean-context",
      hookName: "tool_result_persist",
      handler,
      priority: 90,
      source: "test",
    } as never);
    initializeGlobalHookRunner(registry as never);

    const sm = guardSessionManager(SessionManager.inMemory(), {
      agentId: "main",
      sessionKey: "agent:main:test",
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
      timestamp: Date.now(),
    } as AgentMessage);
    appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "exec",
      content: [{ type: "text", text: createToolResultText() }],
      isError: true,
      timestamp: Date.now(),
    } as AgentMessage);

    const persisted = getPersistedToolResult(sm) as Extract<AgentMessage, { role: "toolResult" }>;
    const text = ((persisted.content as Array<{ type: string; text?: string }>)[0]?.text ??
      "") as string;

    expect(text).toContain("LEAN TOOL RESULT: exec");
    expect(text).toContain("exit_code=1");
    expect(text).toContain("stderr_excerpt:");
    expect(text).toContain("stdout_tail:");
    expect(text).toContain("full_output_saved=");
    expect(text).not.toContain('"line 1: working..."');
    expect(text.length).toBeLessThan(createToolResultText().length / 3);
  });
});
