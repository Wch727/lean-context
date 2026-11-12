import { clipText, estimateTextTokens } from "./helpers.js";
import type {
  AgentMessage,
  ArchiveSearchHit,
  ProceduralMemoryDigest,
  RecentRecallSnippet,
} from "./types.js";

function pushLineWithinBudget(lines: string[], line: string, maxTokens: number): boolean {
  const candidate = [...lines, line].join("\n");
  if (estimateTextTokens(candidate) > maxTokens) {
    return false;
  }
  lines.push(line);
  return true;
}

export function buildBackgroundContextMessage(params: {
  proceduralMemory: ProceduralMemoryDigest;
  archiveHits: ArchiveSearchHit[];
  recallSnippets: RecentRecallSnippet[];
  maxTokens: number;
}): AgentMessage | null {
  const lines = [
    "LEAN CONTEXT BACKGROUND KNOWLEDGE",
    "Recovered background knowledge distilled from procedural memory, archived history, and memory recall.",
  ];

  if (params.proceduralMemory.summary) {
    pushLineWithinBudget(
      lines,
      `Workflow: ${clipText(params.proceduralMemory.summary, 180)}`,
      params.maxTokens,
    );
  }

  for (const item of params.proceduralMemory.procedures.slice(0, 2)) {
    if (!pushLineWithinBudget(lines, `Procedure: ${clipText(item, 140)}`, params.maxTokens)) {
      break;
    }
  }
  for (const item of params.proceduralMemory.tool_affordances.slice(0, 2)) {
    if (!pushLineWithinBudget(lines, `Tool: ${clipText(item, 132)}`, params.maxTokens)) {
      break;
    }
  }
  for (const item of params.proceduralMemory.failure_patterns.slice(0, 1)) {
    if (!pushLineWithinBudget(lines, `Failure pattern: ${clipText(item, 136)}`, params.maxTokens)) {
      break;
    }
  }

  for (const hit of params.archiveHits.slice(0, 2)) {
    if (
      !pushLineWithinBudget(
        lines,
        `Archived context: ${clipText(hit.segment.summary, 150)}`,
        params.maxTokens,
      )
    ) {
      break;
    }
    const evidence = hit.excerpts[0]?.replace(/^\[[^\]]+\]\s*/, "");
    if (evidence) {
      pushLineWithinBudget(lines, `Evidence: ${clipText(evidence, 120)}`, params.maxTokens);
    }
  }

  for (const snippet of params.recallSnippets.slice(0, 2)) {
    const source = snippet.path ?? snippet.source ?? "memory";
    if (
      !pushLineWithinBudget(
        lines,
        `Memory cue (${clipText(source, 32)}): ${clipText(snippet.snippet, 120)}`,
        params.maxTokens,
      )
    ) {
      break;
    }
  }

  if (lines.length <= 2) {
    return null;
  }

  return {
    role: "assistant",
    content: [{ type: "text", text: lines.join("\n") }],
    timestamp: Date.now(),
  } as AgentMessage;
}
