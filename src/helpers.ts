import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  type AgentMessage,
  SAVINGS_CATEGORIES,
  type MessageLike,
  type SavingsCategory,
  type SavingsEvent,
  type SavingsTotals,
  type StructuredSessionState,
  type TokenEstimatorCalibration,
} from "./types.js";

export const ESTIMATED_SAVINGS_NOTE =
  "Estimated context token savings only. These numbers are not billed input tokens and may differ from provider usage.";

const FILE_PATH_RE =
  /(?:[A-Za-z]:[\\/][^\s"'`<>|]+|(?:\.{0,2}[\\/])?[A-Za-z0-9_.@-]+(?:[\\/][A-Za-z0-9_.@-]+)*\.[A-Za-z0-9]{1,10})/g;

const URL_RE = /\bhttps?:\/\/[^\s)]+/gi;

// Enhanced regex for different character classes
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/gu; // CJK Unified Ideographs
const HIRAGANA_RE = /[\u3040-\u309f]/gu; // Hiragana
const KATAKANA_RE = /[\u30a0-\u30ff]/gu; // Katakana
const HANGUL_RE = /[\uac00-\ud7af]/gu; // Hangul Syllables
const NON_LATIN_RE = /[\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7AF\uF900-\uFAFF\u{20000}-\u{2FA1F}]/gu;
const CJK_SURROGATE_HIGH_RE = /[\uD840-\uD87E][\uDC00-\uDFFF]/g;
const ESTIMATE_SEGMENT_RE =
  /[\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7AF\uF900-\uFAFF\u{20000}-\u{2FA1F}]+|https?:\/\/[^\s)]+|[A-Za-z0-9_./:\\-]+|[^\s]/gu;

// Code-specific patterns
const CODE_BLOCK_RE = /```[\s\S]*?```|`[^`]+`/g;

type EstimateTokenOptions = {
  model?: string;
  calibration?: TokenEstimatorCalibration;
};

type TokenEstimatorProfile = {
  modelFamily: string;
  latinCharsPerToken: number;
  urlCharsPerToken: number;
  cjkTokensPerCodePoint: number;
  symbolTokenCost: number;
};

type NormalizedUsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

const DEFAULT_ESTIMATOR_PROFILE: TokenEstimatorProfile = {
  modelFamily: "default",
  latinCharsPerToken: 3.8,
  urlCharsPerToken: 3.1,
  cjkTokensPerCodePoint: 1,
  symbolTokenCost: 1,
};

const TOKEN_ESTIMATOR_PROFILES: Record<string, TokenEstimatorProfile> = {
  default: DEFAULT_ESTIMATOR_PROFILE,
  openai: {
    modelFamily: "openai",
    latinCharsPerToken: 3.9,
    urlCharsPerToken: 3.2,
    cjkTokensPerCodePoint: 0.95,
    symbolTokenCost: 1,
  },
  anthropic: {
    modelFamily: "anthropic",
    latinCharsPerToken: 4.1,
    urlCharsPerToken: 3.4,
    cjkTokensPerCodePoint: 1.05,
    symbolTokenCost: 1,
  },
  qwen: {
    modelFamily: "qwen",
    latinCharsPerToken: 3.5,
    urlCharsPerToken: 3,
    cjkTokensPerCodePoint: 1.05,
    symbolTokenCost: 1,
  },
  kimi: {
    modelFamily: "kimi",
    latinCharsPerToken: 3.6,
    urlCharsPerToken: 3,
    cjkTokensPerCodePoint: 1,
    symbolTokenCost: 1,
  },
  gemini: {
    modelFamily: "gemini",
    latinCharsPerToken: 4.0,
    urlCharsPerToken: 3.3,
    cjkTokensPerCodePoint: 1.0,
    symbolTokenCost: 1,
  },
  deepseek: {
    modelFamily: "deepseek",
    latinCharsPerToken: 3.7,
    urlCharsPerToken: 3.1,
    cjkTokensPerCodePoint: 1.0,
    symbolTokenCost: 1,
  },
};

export function makeSavingsTotals(): SavingsTotals {
  return {
    tool_result_slimming: 0,
    history_compaction: 0,
    history_exclusion: 0,
    tool_schema_avoidance: 0,
    bootstrap_trim: 0,
    attachment_trimming: 0,
  };
}

export function addSavingsTotals(
  base: SavingsTotals,
  delta: Partial<SavingsTotals>,
): SavingsTotals {
  const next = { ...base };
  for (const category of SAVINGS_CATEGORIES) {
    next[category] = Math.max(0, (next[category] ?? 0) + (delta[category] ?? 0));
  }
  return next;
}

export function sumSavingsTotals(totals: SavingsTotals): number {
  return SAVINGS_CATEGORIES.reduce((sum, category) => sum + Math.max(0, totals[category] ?? 0), 0);
}

export function createEmptyTokenEstimatorCalibration(): TokenEstimatorCalibration {
  return {
    promptScale: 1,
    sampleCount: 0,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function detectTokenEstimatorModelFamily(model?: string): string {
  const normalized = model?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return DEFAULT_ESTIMATOR_PROFILE.modelFamily;
  }
  if (
    normalized.includes("qwen") ||
    normalized.includes("dashscope") ||
    normalized.includes("modelstudio")
  ) {
    return "qwen";
  }
  if (normalized.includes("kimi") || normalized.includes("moonshot")) {
    return "kimi";
  }
  if (normalized.includes("claude") || normalized.includes("anthropic")) {
    return "anthropic";
  }
  if (
    normalized.includes("gpt") ||
    normalized.includes("openai") ||
    normalized.includes("o1") ||
    normalized.includes("o3") ||
    normalized.includes("o4")
  ) {
    return "openai";
  }
  if (
    normalized.includes("gemini") ||
    normalized.includes("google") ||
    normalized.includes("palm")
  ) {
    return "gemini";
  }
  if (normalized.includes("deepseek") || normalized.includes("deep-seek")) {
    return "deepseek";
  }
  return DEFAULT_ESTIMATOR_PROFILE.modelFamily;
}

function resolveTokenEstimatorProfile(options?: EstimateTokenOptions): TokenEstimatorProfile {
  const modelFamily =
    options?.calibration?.modelFamily ?? detectTokenEstimatorModelFamily(options?.model);
  return TOKEN_ESTIMATOR_PROFILES[modelFamily] ?? DEFAULT_ESTIMATOR_PROFILE;
}

function calibrationScale(options?: EstimateTokenOptions): number {
  const scale = options?.calibration?.promptScale;
  if (!(typeof scale === "number") || !Number.isFinite(scale)) {
    return 1;
  }
  return clamp(scale, 0.5, 2.5);
}

export function estimateUnknownTokens(value: unknown, options?: EstimateTokenOptions): number {
  const strippedToolResult =
    value && typeof value === "object" ? stripToolResultDetails(value as AgentMessage) : value;
  return estimateTextTokens(stringifyForEstimate(strippedToolResult), options);
}

function detectTextType(text: string): "code" | "mixed" | "text" {
  const codeMatches = text.match(CODE_BLOCK_RE);
  const codeChars = codeMatches ? codeMatches.reduce((sum, m) => sum + m.length, 0) : 0;
  const codeRatio = codeChars / Math.max(1, text.length);
  if (codeRatio > 0.5) return "code";
  if (codeRatio > 0.1) return "mixed";
  return "text";
}

function countCjkTokens(text: string, profile: TokenEstimatorProfile): number {
  // Different CJK scripts may have different tokenization characteristics
  const cjkCount = (text.match(CJK_RE) ?? []).length;
  const hiraganaCount = (text.match(HIRAGANA_RE) ?? []).length;
  const katakanaCount = (text.match(KATAKANA_RE) ?? []).length;
  const hangulCount = (text.match(HANGUL_RE) ?? []).length;

  // Hiragana/Katakana often tokenize differently than Han characters
  const totalCodepoints = cjkCount + hiraganaCount + katakanaCount + hangulCount;

  // Adjust for surrogate pairs
  const surrogates = (text.match(CJK_SURROGATE_HIGH_RE) ?? []).length;
  const adjustedCount = totalCodepoints - surrogates;

  return Math.max(1, Math.ceil(adjustedCount * profile.cjkTokensPerCodePoint));
}

export function estimateTextTokens(text: string, options?: EstimateTokenOptions): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }

  const profile = resolveTokenEstimatorProfile(options);
  const textType = detectTextType(trimmed);

  // Adjust profile based on text type
  const adjustedProfile: TokenEstimatorProfile = {
    ...profile,
    // Code tends to have different tokenization (more tokens per char due to symbols)
    latinCharsPerToken:
      textType === "code" ? profile.latinCharsPerToken * 0.85 : profile.latinCharsPerToken,
    symbolTokenCost: textType === "code" ? 1.2 : profile.symbolTokenCost,
  };

  const segments = trimmed.match(ESTIMATE_SEGMENT_RE) ?? [];
  let estimated = 0;

  for (const segment of segments) {
    const nonLatinMatches = segment.match(NON_LATIN_RE) ?? [];
    if (nonLatinMatches.length > 0) {
      estimated += countCjkTokens(segment, adjustedProfile);
      continue;
    }
    if (/^https?:\/\//i.test(segment)) {
      estimated += Math.max(1, Math.ceil(segment.length / adjustedProfile.urlCharsPerToken));
      continue;
    }
    if (/^[A-Za-z0-9_./:\\-]+$/.test(segment)) {
      estimated += Math.max(1, Math.ceil(segment.length / adjustedProfile.latinCharsPerToken));
      continue;
    }
    estimated += adjustedProfile.symbolTokenCost;
  }

  return Math.max(1, Math.ceil(estimated * calibrationScale(options)));
}

export function stripToolResultDetails(message: AgentMessage): AgentMessage {
  if (!message || typeof message !== "object" || message.role !== "toolResult") {
    return message;
  }
  if (!("details" in message)) {
    return message;
  }
  const sanitized = { ...(message as unknown as Record<string, unknown>) };
  delete sanitized.details;
  return sanitized as unknown as AgentMessage;
}

export function estimateMessagesTokens(
  messages: AgentMessage[],
  options?: EstimateTokenOptions,
): number {
  return messages.reduce((sum, message) => sum + estimateUnknownTokens(message, options), 0);
}

function countCodePoints(text: string, nonLatinCount: number): number {
  if (nonLatinCount === 0) {
    return text.length;
  }
  const cjkSurrogates = (text.match(CJK_SURROGATE_HIGH_RE) ?? []).length;
  return text.length - cjkSurrogates;
}

export function stringifyForEstimate(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function toPlainText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return stringifyForEstimate(value);
  }
  const parts: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      if (typeof item === "string") {
        parts.push(item);
      }
      continue;
    }
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    if (block.type === "thinking" && typeof block.thinking === "string") {
      parts.push(block.thinking);
      continue;
    }
    if (typeof block.url === "string") {
      parts.push(block.url);
    }
    if (typeof block.path === "string") {
      parts.push(block.path);
    }
  }
  return parts.join("\n");
}

export function flattenMessageText(message: MessageLike): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const record = message as Record<string, unknown>;
  const body = toPlainText(record.content);
  const parts = [body];
  if (record.role === "compactionSummary" && typeof record.summary === "string") {
    parts.push(record.summary);
  }
  if (record.toolName && typeof record.toolName === "string") {
    parts.unshift(`[tool:${record.toolName}]`);
  }
  return parts.filter(Boolean).join("\n").trim();
}

export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function uniqueStrings(values: Iterable<string>, maxItems?: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
    if (typeof maxItems === "number" && out.length >= maxItems) {
      break;
    }
  }
  return out;
}

export function takeLastMeaningfulLines(text: string, lineCount: number): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-Math.max(1, lineCount));
}

export function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function pickNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      return Number.parseInt(value.trim(), 10);
    }
  }
  return undefined;
}

export function safeJsonParse(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed || !(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

export function normalizeUsageLike(raw?: unknown): NormalizedUsageLike | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const input = asFiniteNumber(
    record.input ??
      record.inputTokens ??
      record.input_tokens ??
      record.promptTokens ??
      record.prompt_tokens,
  );
  const output = asFiniteNumber(
    record.output ??
      record.outputTokens ??
      record.output_tokens ??
      record.completionTokens ??
      record.completion_tokens,
  );
  const cacheRead = asFiniteNumber(
    record.cacheRead ??
      record.cache_read ??
      record.cache_read_input_tokens ??
      record.cached_tokens ??
      (record.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens ??
      undefined,
  );
  const cacheWrite = asFiniteNumber(
    record.cacheWrite ?? record.cache_write ?? record.cache_creation_input_tokens,
  );
  const total = asFiniteNumber(record.total ?? record.totalTokens ?? record.total_tokens);
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    total === undefined
  ) {
    return undefined;
  }
  return {
    input: input != null && input < 0 ? 0 : input,
    output,
    cacheRead,
    cacheWrite,
    total,
  };
}

export function derivePromptTokensFromUsage(raw?: unknown): number | undefined {
  const usage = normalizeUsageLike(raw);
  if (!usage) {
    return undefined;
  }
  const total = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return total > 0 ? total : undefined;
}

function extractPromptTokensFromRecord(record: Record<string, unknown>): number | undefined {
  const direct = pickNumber(record, [
    "promptTokens",
    "prompt_tokens",
    "contextTokens",
    "context_tokens",
    "inputTokens",
    "input_tokens",
  ]);
  if (typeof direct === "number" && direct > 0) {
    return direct;
  }
  return (
    derivePromptTokensFromUsage(record.usage) ??
    derivePromptTokensFromUsage(record.lastCallUsage) ??
    derivePromptTokensFromUsage(record.meta) ??
    derivePromptTokensFromUsage(
      (record.meta as Record<string, unknown> | undefined)?.usage ?? undefined,
    ) ??
    derivePromptTokensFromUsage(
      (record.meta as Record<string, unknown> | undefined)?.agentMeta ?? undefined,
    )
  );
}

export function extractObservedPromptTokensFromMessages(
  messages: AgentMessage[],
): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }
    const observed = extractPromptTokensFromRecord(message as unknown as Record<string, unknown>);
    if (typeof observed === "number" && observed > 0) {
      return observed;
    }
  }
  return undefined;
}

export function updateTokenEstimatorCalibration(params: {
  current?: TokenEstimatorCalibration;
  estimatedPromptTokens?: number;
  observedPromptTokens?: number;
  model?: string;
  alpha?: number;
}): TokenEstimatorCalibration {
  const current = params.current ?? createEmptyTokenEstimatorCalibration();
  const estimated = params.estimatedPromptTokens;
  const observed = params.observedPromptTokens;
  const alpha = clamp(params.alpha ?? 0.25, 0.05, 1);
  if (
    !(typeof estimated === "number") ||
    !Number.isFinite(estimated) ||
    estimated <= 0 ||
    !(typeof observed === "number") ||
    !Number.isFinite(observed) ||
    observed <= 0
  ) {
    return {
      ...current,
      modelFamily: detectTokenEstimatorModelFamily(params.model),
    };
  }
  const nextRatio = clamp(observed / estimated, 0.5, 2.5);
  const base = clamp(current.promptScale || 1, 0.5, 2.5);
  return {
    promptScale: clamp(base * (1 - alpha) + nextRatio * alpha, 0.5, 2.5),
    sampleCount: Math.max(0, current.sampleCount ?? 0) + 1,
    modelFamily: detectTokenEstimatorModelFamily(params.model),
    lastEstimatedPromptTokens: Math.max(0, Math.round(estimated)),
    lastObservedPromptTokens: Math.max(0, Math.round(observed)),
    updatedAt: nowIso(),
  };
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(value)));
}

export function sessionStorageKey(sessionId: string, sessionKey?: string): string {
  return createHash("sha1")
    .update(`${sessionKey ?? ""}\n${sessionId}`, "utf8")
    .digest("hex");
}

export function buildPluginStateDir(rootStateDir: string): string {
  return path.join(rootStateDir, "plugins", "lean-context");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function buildTurnId(): string {
  return randomUUID();
}

export function buildEventId(): string {
  return randomUUID();
}

export function isStructuredStateEmpty(state: StructuredSessionState): boolean {
  return (
    !state.goal &&
    state.done.length === 0 &&
    state.open_todos.length === 0 &&
    state.changed_files.length === 0 &&
    state.important_outputs.length === 0 &&
    state.constraints.length === 0 &&
    state.decisions.length === 0 &&
    state.blockers.length === 0
  );
}

export function createEmptyStructuredSessionState(): StructuredSessionState {
  return {
    goal: "",
    done: [],
    open_todos: [],
    changed_files: [],
    important_outputs: [],
    constraints: [],
    decisions: [],
    blockers: [],
  };
}

export function formatStructuredSessionState(state: StructuredSessionState): string {
  const sections: Array<[string, string[]]> = [
    ["Goal", state.goal ? [state.goal] : []],
    ["Done", state.done],
    ["Open Todos", state.open_todos],
    ["Changed Files", state.changed_files],
    ["Important Outputs", state.important_outputs],
    ["Constraints", state.constraints],
    ["Decisions", state.decisions],
    ["Blockers", state.blockers],
  ];
  const lines = ["LEAN CONTEXT SESSION STATE"];
  for (const [label, items] of sections) {
    if (items.length === 0) {
      continue;
    }
    lines.push(`${label}:`);
    for (const item of items) {
      lines.push(`- ${item}`);
    }
  }
  return lines.join("\n");
}

export function extractFilePaths(text: string, maxItems = 8): string[] {
  const matches = text.match(FILE_PATH_RE) ?? [];
  return uniqueStrings(matches, maxItems);
}

export function extractUrls(text: string, maxItems = 6): string[] {
  const matches = text.match(URL_RE) ?? [];
  return uniqueStrings(matches, maxItems);
}

export function lineHasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function mergeTopContributors(
  current: SavingsEvent[],
  incoming: SavingsEvent[],
  maxItems: number,
): SavingsEvent[] {
  const merged = [...current];
  for (const event of incoming) {
    const existingIndex = merged.findIndex(
      (entry) => entry.itemKey && event.itemKey && entry.itemKey === event.itemKey,
    );
    if (existingIndex >= 0) {
      if ((merged[existingIndex]?.tokensSaved ?? 0) < event.tokensSaved) {
        merged[existingIndex] = event;
      }
      continue;
    }
    merged.push(event);
  }
  return merged
    .toSorted((left, right) => right.tokensSaved - left.tokensSaved)
    .slice(0, Math.max(1, maxItems));
}

export function categoryLabel(category: SavingsCategory): string {
  switch (category) {
    case "tool_result_slimming":
      return "tool result slimming";
    case "history_compaction":
      return "structured history compaction";
    case "history_exclusion":
      return "old-history exclusion";
    case "tool_schema_avoidance":
      return "tool schema avoidance";
    case "bootstrap_trim":
      return "bootstrap trim";
    case "attachment_trimming":
      return "attachment trimming";
  }
}
