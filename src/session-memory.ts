import {
  clipText,
  extractFilePaths,
  flattenMessageText,
  normalizeWhitespace,
  nowIso,
  uniqueStrings,
} from "./helpers.js";
import { buildStructuredSessionState } from "./structured-state.js";
import type {
  AgentMessage,
  ProceduralMemoryDigest,
  SessionMemoryDigest,
  SessionMemoryRecord,
  SessionMemoryRecordType,
  StructuredSessionState,
} from "./types.js";

type Statement = {
  role: string;
  text: string;
  toolName?: string;
};

const TYPE_PRIORITY: Record<SessionMemoryRecordType, number> = {
  constraint: 0.22,
  failure_pattern: 0.2,
  decision: 0.18,
  procedure: 0.16,
  tool_affordance: 0.14,
  preference: 0.12,
  fact: 0.1,
};

const TYPE_LIMITS: Record<SessionMemoryRecordType, number> = {
  fact: 3,
  preference: 2,
  constraint: 3,
  decision: 3,
  procedure: 2,
  failure_pattern: 2,
  tool_affordance: 2,
};

const NOVELTY_THRESHOLD: Record<SessionMemoryRecordType, number> = {
  fact: 0.92,
  preference: 0.9,
  constraint: 0.88,
  decision: 0.9,
  procedure: 0.84,
  failure_pattern: 0.84,
  tool_affordance: 0.82,
};

const PROCEDURAL_TYPES = new Set<SessionMemoryRecordType>([
  "procedure",
  "failure_pattern",
  "tool_affordance",
]);

const PREFERENCE_PATTERNS = [
  /\b(prefer|preferred|like to|likes to|want to|wants to|would rather|avoid|don't want|do not want|stick with)\b/i,
  /(?:喜欢|偏好|更想|希望|想要|倾向于|不要|避免|最好)/,
];

const PROCEDURE_PATTERNS = [
  /\b(first|then|after that|start by|begin with|use .* first|prefer .* first)\b/i,
  /(?:先|然后|接着|之后|优先|先用|先看|先读)/,
];

const FAILURE_PATTERNS = [
  /\b(error|failed|failure|timeout|forbidden|permission denied|not found|traceback|exception|enoent|eacces)\b/i,
  /(?:失败|报错|错误|异常|超时|无权限|找不到|缺失|阻塞)/,
];

const TOOL_AFFORDANCE_PATTERNS = [
  /\b(use|using|prefer|start with)\s+([a-z0-9_/-]+)\s+(tool|first|for)\b/i,
  /(?:用|使用|先用)\s*([A-Za-z0-9_/-]+)\s*(?:工具)?/,
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeRecordText(text: string): string {
  return normalizeWhitespace(text)
    .toLowerCase()
    .replace(/[`"'“”‘’()[\]{}:;,.!?/\\<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function statementSimilarity(left: string, right: string): number {
  const a = normalizeRecordText(left);
  const b = normalizeRecordText(right);
  if (!a || !b) {
    return 0;
  }
  if (a === b) {
    return 1;
  }
  if (a.includes(b) || b.includes(a)) {
    return 0.92;
  }
  const leftTerms = new Set(a.split(" ").filter(Boolean));
  const rightTerms = new Set(b.split(" ").filter(Boolean));
  if (leftTerms.size === 0 || rightTerms.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const term of leftTerms) {
    if (rightTerms.has(term)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(leftTerms.size, rightTerms.size);
}

function splitStatements(text: string): string[] {
  return text
    .split(/\r?\n+/)
    .flatMap((line) => line.split(/(?<=[.!?。！？])\s+/))
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
}

function collectStatements(messages: AgentMessage[]): Statement[] {
  const statements: Statement[] = [];
  for (const message of messages) {
    const text = flattenMessageText(message);
    if (!text) {
      continue;
    }
    const role = typeof message.role === "string" ? message.role : "";
    const toolName =
      typeof (message as { toolName?: unknown }).toolName === "string"
        ? ((message as { toolName?: string }).toolName ?? "")
        : undefined;
    for (const statement of splitStatements(text)) {
      statements.push({
        role,
        text: clipText(statement, 220),
        toolName,
      });
    }
  }
  return statements;
}

function groupRecordTexts(
  records: SessionMemoryRecord[],
): Record<SessionMemoryRecordType, string[]> {
  const grouped: Record<SessionMemoryRecordType, string[]> = {
    fact: [],
    preference: [],
    constraint: [],
    decision: [],
    procedure: [],
    failure_pattern: [],
    tool_affordance: [],
  };
  for (const record of records) {
    grouped[record.type].push(record.text);
  }
  return grouped;
}

function makeRecord(
  type: SessionMemoryRecordType,
  text: string,
  lastSeenMessageCount: number,
  sourceRole?: string,
  sourceToolName?: string,
  strength = 0.7,
): SessionMemoryRecord {
  return {
    type,
    text: clipText(normalizeWhitespace(text), 180),
    sourceRole,
    sourceToolName,
    strength: clamp(strength, 0.1, 1),
    lastSeenMessageCount: Math.max(0, lastSeenMessageCount),
  };
}

function extractCandidateRecords(params: {
  messages: AgentMessage[];
  state?: StructuredSessionState;
  currentMessageCount: number;
}): SessionMemoryRecord[] {
  const statements = collectStatements(params.messages);
  const records: SessionMemoryRecord[] = [];
  const effectiveState =
    params.state ??
    buildStructuredSessionState({
      messages: params.messages.slice(-10),
    });

  if (effectiveState.goal) {
    records.push(
      makeRecord("fact", effectiveState.goal, params.currentMessageCount, "user", undefined, 0.76),
    );
  }

  for (const item of effectiveState.constraints.slice(0, 4)) {
    records.push(
      makeRecord("constraint", item, params.currentMessageCount, "user", undefined, 0.82),
    );
  }
  for (const item of effectiveState.decisions.slice(0, 4)) {
    records.push(
      makeRecord("decision", item, params.currentMessageCount, "assistant", undefined, 0.8),
    );
  }
  for (const item of effectiveState.blockers.slice(0, 3)) {
    records.push(
      makeRecord(
        "failure_pattern",
        item,
        params.currentMessageCount,
        "toolResult",
        undefined,
        0.84,
      ),
    );
  }
  for (const item of effectiveState.important_outputs.slice(0, 3)) {
    records.push(
      makeRecord("fact", item, params.currentMessageCount, "toolResult", undefined, 0.66),
    );
  }

  for (const statement of statements) {
    if (PREFERENCE_PATTERNS.some((pattern) => pattern.test(statement.text))) {
      records.push(
        makeRecord(
          "preference",
          statement.text,
          params.currentMessageCount,
          statement.role,
          statement.toolName,
          0.72,
        ),
      );
    }
    if (PROCEDURE_PATTERNS.some((pattern) => pattern.test(statement.text))) {
      records.push(
        makeRecord(
          "procedure",
          statement.text,
          params.currentMessageCount,
          statement.role,
          statement.toolName,
          0.7,
        ),
      );
    }
    if (FAILURE_PATTERNS.some((pattern) => pattern.test(statement.text))) {
      records.push(
        makeRecord(
          "failure_pattern",
          statement.text,
          params.currentMessageCount,
          statement.role,
          statement.toolName,
          0.78,
        ),
      );
    }

    for (const pattern of TOOL_AFFORDANCE_PATTERNS) {
      const match = statement.text.match(pattern);
      if (!match) {
        continue;
      }
      const toolName = clipText(match[1] ?? statement.toolName ?? "", 48);
      if (!toolName) {
        continue;
      }
      records.push(
        makeRecord(
          "tool_affordance",
          statement.toolName
            ? `Use ${statement.toolName} for this workflow.`
            : `Use ${toolName} for this workflow.`,
          params.currentMessageCount,
          statement.role,
          statement.toolName ?? toolName,
          0.7,
        ),
      );
    }

    if (statement.role === "toolResult" && statement.toolName) {
      records.push(
        makeRecord(
          "tool_affordance",
          `Recent workflow relied on ${statement.toolName}.`,
          params.currentMessageCount,
          statement.role,
          statement.toolName,
          0.62,
        ),
      );
    }
  }

  const fileFacts = uniqueStrings(
    params.messages.flatMap((message) => extractFilePaths(flattenMessageText(message), 6)),
    6,
  );
  for (const file of fileFacts) {
    records.push(
      makeRecord(
        "fact",
        `Active file: ${file}`,
        params.currentMessageCount,
        "assistant",
        undefined,
        0.58,
      ),
    );
  }

  return records.filter((record) => record.text.trim().length >= 6);
}

function mergeRecords(params: {
  previous: SessionMemoryRecord[];
  incoming: SessionMemoryRecord[];
  currentMessageCount: number;
  maxRecords: number;
}): SessionMemoryRecord[] {
  const merged = params.previous
    .map((record) => {
      const age = Math.max(0, params.currentMessageCount - record.lastSeenMessageCount);
      const decayedStrength = clamp(record.strength - Math.min(0.45, age * 0.018), 0, 1);
      if (decayedStrength <= 0.12) {
        return null;
      }
      return {
        ...record,
        strength: decayedStrength,
      };
    })
    .filter(Boolean) as SessionMemoryRecord[];

  for (const candidate of params.incoming) {
    const strongestSimilar = merged
      .filter((record) => record.type === candidate.type)
      .map((record) => ({
        record,
        similarity: statementSimilarity(record.text, candidate.text),
      }))
      .toSorted((left, right) => right.similarity - left.similarity)[0];
    if (
      strongestSimilar &&
      strongestSimilar.similarity >= NOVELTY_THRESHOLD[candidate.type] &&
      strongestSimilar.record.strength >= candidate.strength - 0.04
    ) {
      const refreshedStrength = clamp(
        Math.max(strongestSimilar.record.strength, candidate.strength) + 0.04,
        0.1,
        1,
      );
      const existingIndex = merged.findIndex((record) => record === strongestSimilar.record);
      merged[existingIndex] = {
        ...strongestSimilar.record,
        strength: refreshedStrength,
        lastSeenMessageCount: params.currentMessageCount,
      };
      continue;
    }
    const existingIndex = merged.findIndex((record) => {
      if (record.type !== candidate.type) {
        return false;
      }
      return statementSimilarity(record.text, candidate.text) >= 0.84;
    });
    if (existingIndex >= 0) {
      const existing = merged[existingIndex];
      merged[existingIndex] = {
        ...existing,
        text: candidate.text.length > existing.text.length ? candidate.text : existing.text,
        sourceRole: candidate.sourceRole ?? existing.sourceRole,
        sourceToolName: candidate.sourceToolName ?? existing.sourceToolName,
        strength: clamp(Math.max(existing.strength, candidate.strength) + 0.08, 0.1, 1),
        lastSeenMessageCount: params.currentMessageCount,
      };
      continue;
    }
    merged.push(candidate);
  }

  const perTypeCounts: Record<SessionMemoryRecordType, number> = {
    fact: 0,
    preference: 0,
    constraint: 0,
    decision: 0,
    procedure: 0,
    failure_pattern: 0,
    tool_affordance: 0,
  };

  return merged
    .toSorted((left, right) => {
      const leftScore = left.strength + TYPE_PRIORITY[left.type];
      const rightScore = right.strength + TYPE_PRIORITY[right.type];
      return rightScore - leftScore;
    })
    .filter((record) => {
      const limit = TYPE_LIMITS[record.type];
      if (perTypeCounts[record.type] >= limit) {
        return false;
      }
      perTypeCounts[record.type] += 1;
      return true;
    })
    .slice(0, Math.max(4, params.maxRecords));
}

function proceduralPriority(record: SessionMemoryRecord): number {
  const typeBonus =
    record.type === "failure_pattern" ? 0.18 : record.type === "tool_affordance" ? 0.14 : 0.12;
  return record.strength + typeBonus;
}

function compactLines(values: string[], maxItems: number, maxChars: number): string[] {
  return uniqueStrings(
    values
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => clipText(value, maxChars)),
    maxItems,
  );
}

function buildSummary(params: {
  goal: string;
  nextSteps: string[];
  activeFiles: string[];
  activeDecisions: string[];
  blockers: string[];
  records: SessionMemoryRecord[];
}): string {
  const parts: string[] = [];
  const grouped = groupRecordTexts(params.records);

  if (params.goal) {
    parts.push(`Goal: ${clipText(params.goal, 120)}`);
  }
  if (params.blockers.length > 0) {
    parts.push(`Blocker: ${clipText(params.blockers.slice(0, 2).join("; "), 100)}`);
  } else if (grouped.failure_pattern.length > 0) {
    parts.push(`Failure: ${clipText(grouped.failure_pattern[0], 96)}`);
  }
  if (params.nextSteps.length > 0) {
    parts.push(`Next: ${clipText(params.nextSteps.slice(0, 2).join("; "), 96)}`);
  }
  if (grouped.constraint.length > 0) {
    parts.push(`Constraint: ${clipText(grouped.constraint[0], 88)}`);
  }
  if (params.activeFiles.length > 0) {
    parts.push(`Files: ${clipText(params.activeFiles.slice(0, 3).join(", "), 80)}`);
  }
  if (grouped.tool_affordance.length > 0) {
    parts.push(`Tool: ${clipText(grouped.tool_affordance[0], 84)}`);
  } else if (grouped.procedure.length > 0) {
    parts.push(`Procedure: ${clipText(grouped.procedure[0], 84)}`);
  }
  if (params.activeDecisions.length > 0) {
    parts.push(`Decision: ${clipText(params.activeDecisions[0], 90)}`);
  }

  return parts.join(" | ");
}

export function createEmptySessionMemoryDigest(): SessionMemoryDigest {
  return {
    summary: "",
    goal: "",
    next_steps: [],
    active_files: [],
    active_decisions: [],
    blockers: [],
    records: [],
    sourceMessageCount: 0,
  };
}

export function createEmptyProceduralMemoryDigest(): ProceduralMemoryDigest {
  return {
    summary: "",
    procedures: [],
    tool_affordances: [],
    failure_patterns: [],
    records: [],
    sourceMessageCount: 0,
  };
}

export function isSessionMemoryEmpty(memory: SessionMemoryDigest): boolean {
  return (
    !memory.summary &&
    !memory.goal &&
    memory.next_steps.length === 0 &&
    memory.active_files.length === 0 &&
    memory.active_decisions.length === 0 &&
    memory.blockers.length === 0 &&
    memory.records.length === 0
  );
}

export function isProceduralMemoryEmpty(memory: ProceduralMemoryDigest): boolean {
  return (
    !memory.summary &&
    memory.procedures.length === 0 &&
    memory.tool_affordances.length === 0 &&
    memory.failure_patterns.length === 0 &&
    memory.records.length === 0
  );
}

export function buildSessionMemoryDigest(params: {
  messages: AgentMessage[];
  previous?: SessionMemoryDigest;
  state?: StructuredSessionState;
  maxItems: number;
  maxRecords?: number;
  absoluteMessageCount?: number;
}): SessionMemoryDigest {
  const previous = params.previous ?? createEmptySessionMemoryDigest();
  const currentMessageCount = Math.max(
    params.absoluteMessageCount ?? params.messages.length,
    previous.sourceMessageCount,
  );
  const derivedState = buildStructuredSessionState({
    messages: params.messages.slice(-Math.max(1, params.maxItems * 3)),
  });
  const state = params.state;
  const records = mergeRecords({
    previous: previous.records ?? [],
    incoming: extractCandidateRecords({
      messages: params.messages,
      state: state ?? derivedState,
      currentMessageCount,
    }),
    currentMessageCount,
    maxRecords: params.maxRecords ?? Math.max(8, params.maxItems * 3),
  });
  const groupedRecords = groupRecordTexts(records);
  const goal = clipText(
    derivedState.goal || state?.goal || previous.goal || groupedRecords.fact[0] || "",
    180,
  );
  const nextSteps = compactLines(
    [
      ...derivedState.open_todos,
      ...(state?.open_todos ?? []),
      ...previous.next_steps,
      ...groupedRecords.procedure,
    ],
    params.maxItems,
    120,
  );
  const activeFiles = compactLines(
    [...derivedState.changed_files, ...(state?.changed_files ?? []), ...previous.active_files],
    params.maxItems + 1,
    120,
  );
  const activeDecisions = compactLines(
    [
      ...derivedState.decisions,
      ...(state?.decisions ?? []),
      ...previous.active_decisions,
      ...groupedRecords.decision,
    ],
    params.maxItems,
    120,
  );
  const blockers = compactLines(
    [
      ...derivedState.blockers,
      ...(state?.blockers ?? []),
      ...previous.blockers,
      ...groupedRecords.failure_pattern,
    ],
    params.maxItems,
    120,
  );

  return {
    summary: buildSummary({
      goal,
      nextSteps,
      activeFiles,
      activeDecisions,
      blockers,
      records,
    }),
    goal,
    next_steps: nextSteps,
    active_files: activeFiles,
    active_decisions: activeDecisions,
    blockers,
    records,
    updatedAt: nowIso(),
    sourceMessageCount: currentMessageCount,
  };
}

export function buildProceduralMemoryDigest(params: {
  messages: AgentMessage[];
  previous?: ProceduralMemoryDigest;
  state?: StructuredSessionState;
  maxItems: number;
  absoluteMessageCount?: number;
}): ProceduralMemoryDigest {
  const previous = params.previous ?? createEmptyProceduralMemoryDigest();
  const currentMessageCount = Math.max(
    params.absoluteMessageCount ?? params.messages.length,
    previous.sourceMessageCount,
  );
  const proceduralRecords = mergeRecords({
    previous: previous.records ?? [],
    incoming: extractCandidateRecords({
      messages: params.messages,
      state: params.state,
      currentMessageCount,
    }).filter((record) => PROCEDURAL_TYPES.has(record.type)),
    currentMessageCount,
    maxRecords: Math.max(params.maxItems * 3, 6),
  })
    .filter((record) => PROCEDURAL_TYPES.has(record.type))
    .toSorted((left, right) => proceduralPriority(right) - proceduralPriority(left));

  const procedures = compactLines(
    proceduralRecords.filter((record) => record.type === "procedure").map((record) => record.text),
    params.maxItems,
    120,
  );
  const toolAffordances = compactLines(
    proceduralRecords
      .filter((record) => record.type === "tool_affordance")
      .map((record) => record.text),
    params.maxItems,
    120,
  );
  const failurePatterns = compactLines(
    proceduralRecords
      .filter((record) => record.type === "failure_pattern")
      .map((record) => record.text),
    params.maxItems,
    120,
  );

  const summaryBits = [
    failurePatterns[0] ? `Failure: ${clipText(failurePatterns[0], 88)}` : undefined,
    procedures[0] ? `Procedure: ${clipText(procedures[0], 88)}` : undefined,
    toolAffordances[0] ? `Tool: ${clipText(toolAffordances[0], 84)}` : undefined,
  ].filter(Boolean);

  return {
    summary: summaryBits.join(" | "),
    procedures,
    tool_affordances: toolAffordances,
    failure_patterns: failurePatterns,
    records: proceduralRecords,
    updatedAt: nowIso(),
    sourceMessageCount: currentMessageCount,
  };
}

function appendRecordSection(lines: string[], label: string, values: string[]): void {
  if (values.length === 0) {
    return;
  }
  lines.push(`${label}:`);
  for (const value of values) {
    lines.push(`- ${value}`);
  }
}

export function formatSessionMemoryDigest(memory: SessionMemoryDigest): string {
  const lines = ["LEAN CONTEXT SESSION MEMORY"];
  if (memory.summary) {
    lines.push(memory.summary);
  }
  if (memory.next_steps.length > 0) {
    lines.push("Next Steps:");
    for (const item of memory.next_steps) {
      lines.push(`- ${item}`);
    }
  }
  if (memory.active_files.length > 0) {
    lines.push("Active Files:");
    for (const item of memory.active_files) {
      lines.push(`- ${item}`);
    }
  }
  if (memory.active_decisions.length > 0) {
    lines.push("Active Decisions:");
    for (const item of memory.active_decisions) {
      lines.push(`- ${item}`);
    }
  }
  if (memory.blockers.length > 0) {
    lines.push("Current Blockers:");
    for (const item of memory.blockers) {
      lines.push(`- ${item}`);
    }
  }

  const grouped = groupRecordTexts(memory.records);
  appendRecordSection(lines, "Facts", grouped.fact.slice(0, 2));
  appendRecordSection(lines, "Preferences", grouped.preference.slice(0, 2));
  appendRecordSection(lines, "Constraints", grouped.constraint.slice(0, 2));
  appendRecordSection(lines, "Procedures", grouped.procedure.slice(0, 2));
  appendRecordSection(lines, "Failure Patterns", grouped.failure_pattern.slice(0, 2));
  appendRecordSection(lines, "Tool Affordances", grouped.tool_affordance.slice(0, 2));

  return lines.join("\n");
}

export function makeSessionMemoryMessage(memory: SessionMemoryDigest): AgentMessage | null {
  if (isSessionMemoryEmpty(memory)) {
    return null;
  }
  return {
    role: "assistant",
    content: [{ type: "text", text: formatSessionMemoryDigest(memory) }],
    timestamp: Date.now(),
  } as AgentMessage;
}

function prioritizeMemoryItems(params: {
  memory: SessionMemoryDigest;
  proceduralMemory?: ProceduralMemoryDigest;
  pressure: "warm" | "soft" | "hard";
}): {
  summary: string;
  criticalItems: string[];
  contextItems: string[];
} {
  const grouped = groupRecordTexts(params.memory.records);
  const criticalItems: string[] = [];
  const contextItems: string[] = [];
  const procedural = params.proceduralMemory;

  if (params.memory.blockers.length > 0) {
    criticalItems.push(...params.memory.blockers.slice(0, 2).map((item) => `Blocker: ${item}`));
  } else if (grouped.failure_pattern.length > 0) {
    criticalItems.push(...grouped.failure_pattern.slice(0, 2).map((item) => `Failure: ${item}`));
  }
  if (procedural?.failure_patterns.length) {
    criticalItems.push(
      ...procedural.failure_patterns.slice(0, 1).map((item) => `Failure: ${item}`),
    );
  }

  if (params.memory.next_steps.length > 0) {
    criticalItems.push(...params.memory.next_steps.slice(0, 2).map((item) => `Next: ${item}`));
  }
  if (grouped.constraint.length > 0) {
    criticalItems.push(...grouped.constraint.slice(0, 2).map((item) => `Constraint: ${item}`));
  }

  if (params.memory.active_files.length > 0) {
    contextItems.push(`Files: ${params.memory.active_files.slice(0, 3).join(", ")}`);
  }
  if (params.memory.active_decisions.length > 0) {
    contextItems.push(`Decision: ${params.memory.active_decisions[0]}`);
  }
  if (procedural?.procedures.length) {
    contextItems.push(`Procedure: ${procedural.procedures[0]}`);
  } else if (grouped.procedure.length > 0) {
    contextItems.push(`Procedure: ${grouped.procedure[0]}`);
  }
  if (procedural?.tool_affordances.length) {
    contextItems.push(`Tool: ${procedural.tool_affordances[0]}`);
  } else if (grouped.tool_affordance.length > 0) {
    contextItems.push(`Tool: ${grouped.tool_affordance[0]}`);
  }
  if (params.pressure !== "warm" && grouped.preference.length > 0) {
    contextItems.push(`Preference: ${grouped.preference[0]}`);
  }

  return {
    summary: params.memory.summary,
    criticalItems,
    contextItems,
  };
}

export function makeHotContextMessage(params: {
  memory: SessionMemoryDigest;
  proceduralMemory?: ProceduralMemoryDigest;
  compactedHistory: boolean;
  allowPreCompact?: boolean;
  maxTokens?: number;
  pressure?: "warm" | "soft" | "hard";
}): AgentMessage | null {
  if (
    (!params.compactedHistory && !params.allowPreCompact) ||
    isSessionMemoryEmpty(params.memory)
  ) {
    return null;
  }

  const pressure = params.pressure ?? (params.compactedHistory ? "hard" : "soft");
  const maxChars =
    typeof params.maxTokens === "number" && params.maxTokens > 0
      ? params.maxTokens * (pressure === "warm" ? 2.4 : pressure === "soft" ? 3 : 4)
      : pressure === "warm"
        ? 220
        : pressure === "soft"
          ? 280
          : 420;

  const { summary, criticalItems, contextItems } = prioritizeMemoryItems({
    memory: params.memory,
    proceduralMemory: params.proceduralMemory,
    pressure,
  });

  const lines: string[] = ["LEAN CONTEXT HOT CONTEXT"];
  if (summary) {
    lines.push(clipText(summary, Math.max(72, Math.floor(maxChars / 2))));
  }

  for (const item of criticalItems) {
    const candidate = [...lines, item].join("\n");
    if (candidate.length > maxChars) {
      break;
    }
    lines.push(item);
  }

  for (const item of contextItems) {
    const candidate = [...lines, item].join("\n");
    if (candidate.length > maxChars) {
      break;
    }
    lines.push(item);
  }

  if (lines.length <= 1) {
    return null;
  }

  return {
    role: "assistant",
    content: [{ type: "text", text: lines.join("\n") }],
    timestamp: Date.now(),
  } as AgentMessage;
}
