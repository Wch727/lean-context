import {
  clipText,
  estimateUnknownTokens,
  normalizeWhitespace,
  pickString,
  uniqueStrings,
} from "./helpers.js";
import type { AgentContentBlock, AgentMessage } from "./types.js";

export type PreCompactionStripStats = {
  rawTokens: number;
  sanitizedTokens: number;
  attachmentTrimmedTokens: number;
  thinkingTrimmedTokens: number;
  toolCallSimplifiedTokens: number;
  attachmentMarkerCount: number;
  thinkingBlockCount: number;
  toolCallCount: number;
  notes: string[];
};

export type PreCompactionStripResult = {
  messages: AgentMessage[];
  stats: PreCompactionStripStats;
};

type BlockSanitization = {
  blocks: AgentContentBlock[];
  rawTokens: number;
  sanitizedTokens: number;
  attachmentTrimmedTokens: number;
  thinkingTrimmedTokens: number;
  toolCallSimplifiedTokens: number;
  attachmentMarkerCount: number;
  thinkingBlockCount: number;
  toolCallCount: number;
};

function emptyBlockSanitization(): BlockSanitization {
  return {
    blocks: [],
    rawTokens: 0,
    sanitizedTokens: 0,
    attachmentTrimmedTokens: 0,
    thinkingTrimmedTokens: 0,
    toolCallSimplifiedTokens: 0,
    attachmentMarkerCount: 0,
    thinkingBlockCount: 0,
    toolCallCount: 0,
  };
}

function mergeBlockStats(base: BlockSanitization, delta: BlockSanitization): BlockSanitization {
  return {
    blocks: [...base.blocks, ...delta.blocks],
    rawTokens: base.rawTokens + delta.rawTokens,
    sanitizedTokens: base.sanitizedTokens + delta.sanitizedTokens,
    attachmentTrimmedTokens: base.attachmentTrimmedTokens + delta.attachmentTrimmedTokens,
    thinkingTrimmedTokens: base.thinkingTrimmedTokens + delta.thinkingTrimmedTokens,
    toolCallSimplifiedTokens: base.toolCallSimplifiedTokens + delta.toolCallSimplifiedTokens,
    attachmentMarkerCount: base.attachmentMarkerCount + delta.attachmentMarkerCount,
    thinkingBlockCount: base.thinkingBlockCount + delta.thinkingBlockCount,
    toolCallCount: base.toolCallCount + delta.toolCallCount,
  };
}

function makeTextBlock(text: string): AgentContentBlock {
  return {
    type: "text",
    text: normalizeWhitespace(text),
  };
}

function simplifyToolInput(input: unknown): string {
  if (!input || typeof input !== "object") {
    return "";
  }
  const record = input as Record<string, unknown>;
  const hints = uniqueStrings(
    [
      pickString(record, ["path", "filePath", "file_path", "targetPath"]),
      pickString(record, ["url", "href"]),
      pickString(record, ["sheet", "sheetName", "worksheet", "tab"]),
      pickString(record, ["query", "pattern", "glob"]),
      pickString(record, ["command"]),
      pickString(record, ["target", "destination"]),
    ].filter((value): value is string => Boolean(value)),
    3,
  );
  return hints
    .map((value) => clipText(normalizeWhitespace(value), 120))
    .filter(Boolean)
    .join(" | ");
}

function attachmentMarker(kind: string, block: Record<string, unknown>): string {
  const target = clipText(
    normalizeWhitespace(
      [
        pickString(block, ["path", "filePath", "file_path", "name"]),
        pickString(block, ["url", "href"]),
      ]
        .filter((value): value is string => Boolean(value))
        .join(" "),
    ),
    120,
  );
  return target
    ? `[${kind} omitted during structured compaction] ${target}`
    : `[${kind} omitted during structured compaction]`;
}

function sanitizeNestedContent(content: unknown): BlockSanitization {
  if (!Array.isArray(content)) {
    return emptyBlockSanitization();
  }
  return content.reduce<BlockSanitization>((acc, item) => {
    if (!item || typeof item !== "object") {
      return acc;
    }
    return mergeBlockStats(acc, sanitizeBlock(item as AgentContentBlock));
  }, emptyBlockSanitization());
}

function sanitizeBlock(block: AgentContentBlock): BlockSanitization {
  const rawTokens = estimateUnknownTokens(block);
  const type = typeof block.type === "string" ? block.type : "";

  if (type === "thinking" || type === "redacted_thinking") {
    return {
      ...emptyBlockSanitization(),
      rawTokens,
      thinkingTrimmedTokens: rawTokens,
      thinkingBlockCount: 1,
    };
  }

  if (type === "image" || type === "document" || type === "file") {
    const text = attachmentMarker(type, block as Record<string, unknown>);
    const replacement = makeTextBlock(text);
    const sanitizedTokens = estimateUnknownTokens(replacement);
    return {
      ...emptyBlockSanitization(),
      blocks: [replacement],
      rawTokens,
      sanitizedTokens,
      attachmentTrimmedTokens: Math.max(0, rawTokens - sanitizedTokens),
      attachmentMarkerCount: 1,
    };
  }

  if (type === "toolCall" || type === "toolUse" || type === "functionCall") {
    const toolName =
      typeof block.name === "string" && block.name.trim() ? block.name.trim() : "unknown";
    const hint = simplifyToolInput(block.input);
    const replacement = makeTextBlock(hint ? `[tool:${toolName}] ${hint}` : `[tool:${toolName}]`);
    const sanitizedTokens = estimateUnknownTokens(replacement);
    return {
      ...emptyBlockSanitization(),
      blocks: [replacement],
      rawTokens,
      sanitizedTokens,
      toolCallSimplifiedTokens: Math.max(0, rawTokens - sanitizedTokens),
      toolCallCount: 1,
    };
  }

  if (type === "tool_result" && Array.isArray((block as { content?: unknown }).content)) {
    const nested = sanitizeNestedContent((block as { content?: unknown }).content);
    const sanitizedBlock = {
      ...block,
      content: nested.blocks,
    };
    const sanitizedTokens = estimateUnknownTokens(sanitizedBlock);
    return {
      ...nested,
      blocks: [sanitizedBlock],
      rawTokens,
      sanitizedTokens,
    };
  }

  return {
    ...emptyBlockSanitization(),
    blocks: [block],
    rawTokens,
    sanitizedTokens: rawTokens,
  };
}

function sanitizeMessage(message: AgentMessage): {
  message: AgentMessage;
  stats: Omit<PreCompactionStripStats, "notes">;
} {
  const record = message as unknown as Record<string, unknown>;
  const content = record.content;

  if (!Array.isArray(content)) {
    const rawTokens = estimateUnknownTokens(message);
    const sanitized =
      message.role === "toolResult" && "details" in record
        ? ({ ...record, details: undefined } as unknown as AgentMessage)
        : message;
    return {
      message: sanitized,
      stats: {
        rawTokens,
        sanitizedTokens: estimateUnknownTokens(sanitized),
        attachmentTrimmedTokens: 0,
        thinkingTrimmedTokens: 0,
        toolCallSimplifiedTokens: 0,
        attachmentMarkerCount: 0,
        thinkingBlockCount: 0,
        toolCallCount: 0,
      },
    };
  }

  const aggregated = content.reduce<BlockSanitization>((acc: BlockSanitization, block: unknown) => {
    if (!block || typeof block !== "object") {
      return acc;
    }
    return mergeBlockStats(acc, sanitizeBlock(block as AgentContentBlock));
  }, emptyBlockSanitization());

  const baseMessage =
    message.role === "toolResult" && "details" in record
      ? ({ ...record, details: undefined } as unknown as AgentMessage)
      : message;
  const sanitizedMessage = {
    ...baseMessage,
    content: aggregated.blocks,
  } as AgentMessage;

  return {
    message: sanitizedMessage,
    stats: {
      rawTokens: estimateUnknownTokens(message),
      sanitizedTokens: estimateUnknownTokens(sanitizedMessage),
      attachmentTrimmedTokens: aggregated.attachmentTrimmedTokens,
      thinkingTrimmedTokens: aggregated.thinkingTrimmedTokens,
      toolCallSimplifiedTokens: aggregated.toolCallSimplifiedTokens,
      attachmentMarkerCount: aggregated.attachmentMarkerCount,
      thinkingBlockCount: aggregated.thinkingBlockCount,
      toolCallCount: aggregated.toolCallCount,
    },
  };
}

export function stripMessagesForStructuredCompaction(
  messages: AgentMessage[],
): PreCompactionStripResult {
  const sanitizedMessages: AgentMessage[] = [];
  const totals = {
    rawTokens: 0,
    sanitizedTokens: 0,
    attachmentTrimmedTokens: 0,
    thinkingTrimmedTokens: 0,
    toolCallSimplifiedTokens: 0,
    attachmentMarkerCount: 0,
    thinkingBlockCount: 0,
    toolCallCount: 0,
  };

  for (const message of messages) {
    const sanitized = sanitizeMessage(message);
    sanitizedMessages.push(sanitized.message);
    totals.rawTokens += sanitized.stats.rawTokens;
    totals.sanitizedTokens += sanitized.stats.sanitizedTokens;
    totals.attachmentTrimmedTokens += sanitized.stats.attachmentTrimmedTokens;
    totals.thinkingTrimmedTokens += sanitized.stats.thinkingTrimmedTokens;
    totals.toolCallSimplifiedTokens += sanitized.stats.toolCallSimplifiedTokens;
    totals.attachmentMarkerCount += sanitized.stats.attachmentMarkerCount;
    totals.thinkingBlockCount += sanitized.stats.thinkingBlockCount;
    totals.toolCallCount += sanitized.stats.toolCallCount;
  }

  const notes: string[] = [];
  if (totals.thinkingBlockCount > 0) {
    notes.push(
      `Omitted ${totals.thinkingBlockCount} thinking block(s) before structured compaction.`,
    );
  }
  if (totals.attachmentMarkerCount > 0) {
    notes.push(
      `Replaced ${totals.attachmentMarkerCount} attachment block(s) with lightweight markers.`,
    );
  }
  if (totals.toolCallCount > 0) {
    notes.push(`Simplified ${totals.toolCallCount} tool call block(s) into short markers.`);
  }

  return {
    messages: sanitizedMessages,
    stats: {
      ...totals,
      notes,
    },
  };
}
