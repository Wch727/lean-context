import type { AgentMessage } from "./types.js";

type ToolCallBlock = {
  type?: unknown;
  id?: unknown;
  name?: unknown;
};

type ExtractedToolCall = {
  id: string;
  name: string;
};

function isToolCallBlock(block: unknown): block is ToolCallBlock {
  if (!block || typeof block !== "object") {
    return false;
  }
  const type = (block as { type?: unknown }).type;
  return type === "toolCall" || type === "toolUse" || type === "functionCall";
}

export function extractToolCallsFromAssistant(message: AgentMessage): ExtractedToolCall[] {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }
  const calls: ExtractedToolCall[] = [];
  for (const block of message.content) {
    if (!isToolCallBlock(block)) {
      continue;
    }
    const id = typeof block.id === "string" ? block.id.trim() : "";
    const name = typeof block.name === "string" ? block.name.trim() : "unknown";
    if (!id) {
      continue;
    }
    calls.push({ id, name: name || "unknown" });
  }
  return calls;
}

export function extractToolResultId(message: AgentMessage): string | undefined {
  if (!message || message.role !== "toolResult") {
    return undefined;
  }
  const value = (message as { toolCallId?: unknown }).toolCallId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function makeMissingToolResult(params: {
  toolCallId: string;
  toolName: string;
}): Extract<AgentMessage, { role: "toolResult" }> {
  return {
    role: "toolResult",
    toolCallId: params.toolCallId,
    toolName: params.toolName,
    isError: true,
    content: [
      {
        type: "text",
        text: "[lean-context] missing tool result in selected recent history; inserted synthetic result to keep transcript pairing valid.",
      },
    ],
    timestamp: Date.now(),
  } as Extract<AgentMessage, { role: "toolResult" }>;
}

export function repairToolUseResultPairing(messages: AgentMessage[]): AgentMessage[] {
  const output: AgentMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") {
      if (message?.role !== "toolResult") {
        output.push(message);
      }
      continue;
    }

    const calls = extractToolCallsFromAssistant(message);
    if (calls.length === 0) {
      output.push(message);
      continue;
    }

    output.push(message);
    const callIds = new Set(calls.map((call) => call.id));
    const byId = new Map<string, Extract<AgentMessage, { role: "toolResult" }>>();
    let cursor = index + 1;
    for (; cursor < messages.length; cursor += 1) {
      const candidate = messages[cursor];
      if (!candidate || candidate.role === "assistant") {
        break;
      }
      if (candidate.role !== "toolResult") {
        output.push(candidate);
        continue;
      }
      const toolCallId = extractToolResultId(candidate);
      if (!toolCallId || !callIds.has(toolCallId)) {
        continue;
      }
      if (!byId.has(toolCallId)) {
        byId.set(toolCallId, candidate);
      }
    }

    for (const call of calls) {
      output.push(
        byId.get(call.id) ?? makeMissingToolResult({ toolCallId: call.id, toolName: call.name }),
      );
    }
    index = cursor - 1;
  }
  return output;
}
