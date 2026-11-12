import { clipText, flattenMessageText } from "./helpers.js";
import type { AgentMessage, SavingsEvent } from "./types.js";

type ActivitySummary = {
  label?: string;
  detail?: string;
};

function normalizeToolName(value: string): string {
  return value.trim().toLowerCase();
}

function collectToolNames(messages: AgentMessage[], events: SavingsEvent[]): string[] {
  const names = new Set<string>();
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const toolName =
      typeof (message as { toolName?: unknown }).toolName === "string"
        ? (message as { toolName: string }).toolName
        : undefined;
    if (toolName?.trim()) {
      names.add(normalizeToolName(toolName));
    }
    const text = flattenMessageText(message);
    const toolHint = text.match(/\[tool:([^\]]+)\]/i)?.[1];
    if (toolHint?.trim()) {
      names.add(normalizeToolName(toolHint));
    }
  }
  for (const event of events) {
    if (event.toolName?.trim()) {
      names.add(normalizeToolName(event.toolName));
    }
  }
  return Array.from(names);
}

function hasAny(tools: string[], patterns: RegExp[]): boolean {
  return tools.some((tool) => patterns.some((pattern) => pattern.test(tool)));
}

function summarizeToolActivity(toolNames: string[]): ActivitySummary {
  if (toolNames.length === 0) {
    return {};
  }
  if (hasAny(toolNames, [/\b(write|edit|apply_patch|file_edit|file_write)\b/])) {
    return {
      label: "Updated workspace files",
      detail: "This turn primarily wrote or edited files in the workspace.",
    };
  }
  if (hasAny(toolNames, [/\bspreadsheet\b|\bcsv\b|\bxlsx\b/])) {
    return {
      label: "Analyzed spreadsheet data",
      detail: "This turn inspected spreadsheet structure and numeric data.",
    };
  }
  if (hasAny(toolNames, [/\bpdf\b/])) {
    return {
      label: "Reviewed PDF content",
      detail: "This turn extracted and summarized PDF content.",
    };
  }
  if (hasAny(toolNames, [/\btext_collection\b/])) {
    return {
      label: "Scanned text collection",
      detail: "This turn mapped a local folder of emails, notes, or reports before deeper reading.",
    };
  }
  if (hasAny(toolNames, [/\bmemory_write\b/])) {
    return {
      label: "Saved session memory",
      detail: "This turn persisted information for future sessions.",
    };
  }
  if (hasAny(toolNames, [/\bmemory_search\b|\bmemory_get\b/])) {
    return {
      label: "Looked up prior memory",
      detail: "This turn recalled previously stored memory context.",
    };
  }
  if (hasAny(toolNames, [/\b(browser|web_fetch|web_search|fetch|search)\b/])) {
    return {
      label: "Researched external sources",
      detail: "This turn searched or fetched web content.",
    };
  }
  if (hasAny(toolNames, [/\b(read|grep|find|ls|glob)\b/])) {
    return {
      label: "Inspected local files",
      detail: "This turn read or searched local project files.",
    };
  }
  if (hasAny(toolNames, [/\b(exec|shell|bash|powershell|process|terminal|run)\b/])) {
    return {
      label: "Ran shell commands",
      detail: "This turn executed commands and inspected their results.",
    };
  }
  const pretty = toolNames.slice(0, 2).join(" + ");
  return {
    label: clipText(`Used ${pretty}`, 42),
    detail: `This turn primarily used: ${toolNames.slice(0, 4).join(", ")}.`,
  };
}

export function deriveTurnActivity(params: {
  messages: AgentMessage[];
  savingsEvents?: SavingsEvent[];
}): ActivitySummary {
  const toolNames = collectToolNames(params.messages, params.savingsEvents ?? []);
  return summarizeToolActivity(toolNames);
}
