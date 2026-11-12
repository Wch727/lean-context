import type { LeanContextConfig } from "./types.js";

export const DEFAULT_LEAN_CONTEXT_CONFIG: LeanContextConfig = {
  keepRecentMessages: 10,
  keepRecentTokens: 1800,
  workingMemoryMinRecentTokens: 640,
  workingMemoryRecentTokenRatio: 0.6,
  backgroundContextMaxTokens: 320,
  assembleBypassMaxTokens: 256,
  minimumRecentMessagesOnRescue: 2,
  enableSessionMemory: true,
  sessionMemoryMaxItems: 4,
  sessionMemoryMaxRecords: 12,
  proceduralMemoryMaxItems: 6,
  hotContextEnabled: true,
  hotContextMaxTokens: 360,
  workingMemoryWarnTriggerTokens: 3200,
  workingMemoryWarnTriggerRatio: 0.18,
  workingMemorySoftTriggerTokens: 8000,
  workingMemorySoftTriggerRatio: 0.35,
  preCompactHotContextMinMessages: 6,
  preCompactHotContextMinTokens: 1200,
  enableArchiveRecovery: true,
  archiveRecoveryMaxSegments: 1,
  archiveRecoveryMaxTokens: 700,
  archiveRecoveryMinScore: 2,
  archiveRecoveryTokenCostWeight: 0.35,
  maxRecallResults: 2,
  recallMinScore: 0.18,
  enableMemoryRecall: true,
  autoCompactTriggerTokens: 24000,
  autoCompactTriggerRatio: 0.7,
  maxConsecutiveAutoCompactFailures: 3,
  fallbackStateSuccessTurnsToClear: 4,
  minMessagesToCompact: 10,
  maxToolResultTokens: 900,
  toolOutputTailLines: 12,
  toolOutputExcerptChars: 640,
  persistLargeToolResults: true,
  reportTopItems: 5,
  dynamicSystemPromptAddition: true,
  compressionNoticeEnabled: true,
  workflowHintsEnabled: false,
  replyFooterEnabled: true,
  replyFooterMaxCategories: 2,
  tokenCalibrationEnabled: true,
  tokenCalibrationAlpha: 0.25,
};

function readNumber(
  input: Record<string, unknown>,
  key: keyof LeanContextConfig,
  opts: { min?: number; max?: number } = {},
): number | undefined {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (typeof opts.min === "number" && value < opts.min) {
    return undefined;
  }
  if (typeof opts.max === "number" && value > opts.max) {
    return undefined;
  }
  return value;
}

function readBoolean(
  input: Record<string, unknown>,
  key: keyof LeanContextConfig,
): boolean | undefined {
  const value = input[key];
  return typeof value === "boolean" ? value : undefined;
}

export function resolveLeanContextConfig(raw: unknown): LeanContextConfig {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    keepRecentMessages:
      readNumber(input, "keepRecentMessages", { min: 2 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.keepRecentMessages,
    keepRecentTokens:
      readNumber(input, "keepRecentTokens", { min: 256 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.keepRecentTokens,
    workingMemoryMinRecentTokens:
      readNumber(input, "workingMemoryMinRecentTokens", { min: 256 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.workingMemoryMinRecentTokens,
    workingMemoryRecentTokenRatio:
      readNumber(input, "workingMemoryRecentTokenRatio", { min: 0.1, max: 1 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.workingMemoryRecentTokenRatio,
    backgroundContextMaxTokens:
      readNumber(input, "backgroundContextMaxTokens", { min: 128 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.backgroundContextMaxTokens,
    assembleBypassMaxTokens:
      readNumber(input, "assembleBypassMaxTokens", { min: 0 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.assembleBypassMaxTokens,
    minimumRecentMessagesOnRescue:
      readNumber(input, "minimumRecentMessagesOnRescue", { min: 1 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.minimumRecentMessagesOnRescue,
    enableSessionMemory:
      readBoolean(input, "enableSessionMemory") ?? DEFAULT_LEAN_CONTEXT_CONFIG.enableSessionMemory,
    sessionMemoryMaxItems:
      readNumber(input, "sessionMemoryMaxItems", { min: 1, max: 8 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.sessionMemoryMaxItems,
    sessionMemoryMaxRecords:
      readNumber(input, "sessionMemoryMaxRecords", { min: 4, max: 24 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.sessionMemoryMaxRecords,
    proceduralMemoryMaxItems:
      readNumber(input, "proceduralMemoryMaxItems", { min: 2, max: 16 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.proceduralMemoryMaxItems,
    hotContextEnabled:
      readBoolean(input, "hotContextEnabled") ?? DEFAULT_LEAN_CONTEXT_CONFIG.hotContextEnabled,
    hotContextMaxTokens:
      readNumber(input, "hotContextMaxTokens", { min: 64 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.hotContextMaxTokens,
    workingMemoryWarnTriggerTokens:
      readNumber(input, "workingMemoryWarnTriggerTokens", { min: 256 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.workingMemoryWarnTriggerTokens,
    workingMemoryWarnTriggerRatio:
      readNumber(input, "workingMemoryWarnTriggerRatio", { min: 0.05, max: 0.9 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.workingMemoryWarnTriggerRatio,
    workingMemorySoftTriggerTokens:
      readNumber(input, "workingMemorySoftTriggerTokens", { min: 512 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.workingMemorySoftTriggerTokens,
    workingMemorySoftTriggerRatio:
      readNumber(input, "workingMemorySoftTriggerRatio", { min: 0.1, max: 0.95 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.workingMemorySoftTriggerRatio,
    preCompactHotContextMinMessages:
      readNumber(input, "preCompactHotContextMinMessages", { min: 1 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.preCompactHotContextMinMessages,
    preCompactHotContextMinTokens:
      readNumber(input, "preCompactHotContextMinTokens", { min: 0 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.preCompactHotContextMinTokens,
    enableArchiveRecovery:
      readBoolean(input, "enableArchiveRecovery") ??
      DEFAULT_LEAN_CONTEXT_CONFIG.enableArchiveRecovery,
    archiveRecoveryMaxSegments:
      readNumber(input, "archiveRecoveryMaxSegments", { min: 1, max: 4 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.archiveRecoveryMaxSegments,
    archiveRecoveryMaxTokens:
      readNumber(input, "archiveRecoveryMaxTokens", { min: 128 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.archiveRecoveryMaxTokens,
    archiveRecoveryMinScore:
      readNumber(input, "archiveRecoveryMinScore", { min: 1 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.archiveRecoveryMinScore,
    archiveRecoveryTokenCostWeight:
      readNumber(input, "archiveRecoveryTokenCostWeight", { min: 0, max: 2 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.archiveRecoveryTokenCostWeight,
    maxRecallResults:
      readNumber(input, "maxRecallResults", { min: 0 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.maxRecallResults,
    recallMinScore:
      readNumber(input, "recallMinScore", { min: 0, max: 1 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.recallMinScore,
    enableMemoryRecall:
      readBoolean(input, "enableMemoryRecall") ?? DEFAULT_LEAN_CONTEXT_CONFIG.enableMemoryRecall,
    autoCompactTriggerTokens:
      readNumber(input, "autoCompactTriggerTokens", { min: 1024 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.autoCompactTriggerTokens,
    autoCompactTriggerRatio:
      readNumber(input, "autoCompactTriggerRatio", { min: 0.1, max: 1 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.autoCompactTriggerRatio,
    maxConsecutiveAutoCompactFailures:
      readNumber(input, "maxConsecutiveAutoCompactFailures", { min: 1 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.maxConsecutiveAutoCompactFailures,
    fallbackStateSuccessTurnsToClear:
      readNumber(input, "fallbackStateSuccessTurnsToClear", { min: 1, max: 8 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.fallbackStateSuccessTurnsToClear,
    minMessagesToCompact:
      readNumber(input, "minMessagesToCompact", { min: 2 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.minMessagesToCompact,
    maxToolResultTokens:
      readNumber(input, "maxToolResultTokens", { min: 1 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.maxToolResultTokens,
    toolOutputTailLines:
      readNumber(input, "toolOutputTailLines", { min: 2 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.toolOutputTailLines,
    toolOutputExcerptChars:
      readNumber(input, "toolOutputExcerptChars", { min: 128 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.toolOutputExcerptChars,
    persistLargeToolResults:
      readBoolean(input, "persistLargeToolResults") ??
      DEFAULT_LEAN_CONTEXT_CONFIG.persistLargeToolResults,
    reportTopItems:
      readNumber(input, "reportTopItems", { min: 1 }) ?? DEFAULT_LEAN_CONTEXT_CONFIG.reportTopItems,
    dynamicSystemPromptAddition:
      readBoolean(input, "dynamicSystemPromptAddition") ??
      DEFAULT_LEAN_CONTEXT_CONFIG.dynamicSystemPromptAddition,
    compressionNoticeEnabled:
      readBoolean(input, "compressionNoticeEnabled") ??
      DEFAULT_LEAN_CONTEXT_CONFIG.compressionNoticeEnabled,
    workflowHintsEnabled:
      readBoolean(input, "workflowHintsEnabled") ??
      DEFAULT_LEAN_CONTEXT_CONFIG.workflowHintsEnabled,
    replyFooterEnabled:
      readBoolean(input, "replyFooterEnabled") ?? DEFAULT_LEAN_CONTEXT_CONFIG.replyFooterEnabled,
    replyFooterMaxCategories:
      readNumber(input, "replyFooterMaxCategories", { min: 1, max: 4 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.replyFooterMaxCategories,
    tokenCalibrationEnabled:
      readBoolean(input, "tokenCalibrationEnabled") ??
      DEFAULT_LEAN_CONTEXT_CONFIG.tokenCalibrationEnabled,
    tokenCalibrationAlpha:
      readNumber(input, "tokenCalibrationAlpha", { min: 0.05, max: 1 }) ??
      DEFAULT_LEAN_CONTEXT_CONFIG.tokenCalibrationAlpha,
  };
}
