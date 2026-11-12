import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
export type { AgentMessage };

export type AgentContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  url?: string;
  path?: string;
  [key: string]: unknown;
};

export type SavingsCategory =
  | "tool_result_slimming"
  | "history_compaction"
  | "history_exclusion"
  | "tool_schema_avoidance"
  | "bootstrap_trim"
  | "attachment_trimming";

export const SAVINGS_CATEGORIES = [
  "tool_result_slimming",
  "history_compaction",
  "history_exclusion",
  "tool_schema_avoidance",
  "bootstrap_trim",
  "attachment_trimming",
] as const satisfies readonly SavingsCategory[];

export type SavingsTotals = Record<SavingsCategory, number>;

export type SavingsEvent = {
  id: string;
  turnId: string;
  ts: number;
  sessionId: string;
  sessionKey?: string;
  category: SavingsCategory;
  tokensSaved: number;
  label: string;
  detail?: string;
  beforeTokens?: number;
  afterTokens?: number;
  toolName?: string;
  itemKey?: string;
  archivedPath?: string;
};

export type ContextSnapshot = {
  kind: "raw" | "assembled" | "compacted";
  estimatedTokens: number;
  messageCount: number;
  note?: string;
};

export type TurnSavingsReport = {
  version: 1;
  turnId: string;
  createdAt: string;
  sessionId: string;
  sessionKey?: string;
  activityLabel?: string;
  activityDetail?: string;
  statusNotices?: string[];
  note: string;
  rawSnapshot: ContextSnapshot;
  assembledSnapshot: ContextSnapshot;
  compactedSnapshot?: ContextSnapshot;
  totalSavedTokens: number;
  categorySavings: SavingsTotals;
  topContributors: SavingsEvent[];
  explanation: string;
};

export type SessionSavingsSummary = {
  version: 1;
  sessionId: string;
  sessionKey?: string;
  turnCount: number;
  updatedAt: string;
  statusNotices?: string[];
  totalSavedTokens: number;
  categoryTotals: SavingsTotals;
  topContributors: SavingsEvent[];
  lastReport?: TurnSavingsReport;
};

export type StructuredSessionState = {
  goal: string;
  done: string[];
  open_todos: string[];
  changed_files: string[];
  important_outputs: string[];
  constraints: string[];
  decisions: string[];
  blockers: string[];
};

export type SessionMemoryRecordType =
  | "fact"
  | "preference"
  | "constraint"
  | "decision"
  | "procedure"
  | "failure_pattern"
  | "tool_affordance";

export type SessionMemoryRecord = {
  type: SessionMemoryRecordType;
  text: string;
  sourceRole?: string;
  sourceToolName?: string;
  strength: number;
  lastSeenMessageCount: number;
};

export type SessionMemoryDigest = {
  summary: string;
  goal: string;
  next_steps: string[];
  active_files: string[];
  active_decisions: string[];
  blockers: string[];
  records: SessionMemoryRecord[];
  updatedAt?: string;
  sourceMessageCount: number;
};

export type ProceduralMemoryDigest = {
  summary: string;
  procedures: string[];
  tool_affordances: string[];
  failure_patterns: string[];
  records: SessionMemoryRecord[];
  updatedAt?: string;
  sourceMessageCount: number;
};

export type TokenEstimatorCalibration = {
  promptScale: number;
  sampleCount: number;
  modelFamily?: string;
  lastEstimatedPromptTokens?: number;
  lastObservedPromptTokens?: number;
  updatedAt?: string;
};

export type LeanContextConfig = {
  keepRecentMessages: number;
  keepRecentTokens: number;
  workingMemoryMinRecentTokens: number;
  workingMemoryRecentTokenRatio: number;
  backgroundContextMaxTokens: number;
  assembleBypassMaxTokens: number;
  minimumRecentMessagesOnRescue: number;
  enableSessionMemory: boolean;
  sessionMemoryMaxItems: number;
  sessionMemoryMaxRecords: number;
  proceduralMemoryMaxItems: number;
  hotContextEnabled: boolean;
  hotContextMaxTokens: number;
  workingMemoryWarnTriggerTokens: number;
  workingMemoryWarnTriggerRatio: number;
  workingMemorySoftTriggerTokens: number;
  workingMemorySoftTriggerRatio: number;
  preCompactHotContextMinMessages: number;
  preCompactHotContextMinTokens: number;
  enableArchiveRecovery: boolean;
  archiveRecoveryMaxSegments: number;
  archiveRecoveryMaxTokens: number;
  archiveRecoveryMinScore: number;
  archiveRecoveryTokenCostWeight: number;
  maxRecallResults: number;
  recallMinScore: number;
  enableMemoryRecall: boolean;
  autoCompactTriggerTokens: number;
  autoCompactTriggerRatio: number;
  maxConsecutiveAutoCompactFailures: number;
  fallbackStateSuccessTurnsToClear: number;
  minMessagesToCompact: number;
  maxToolResultTokens: number;
  toolOutputTailLines: number;
  toolOutputExcerptChars: number;
  persistLargeToolResults: boolean;
  reportTopItems: number;
  dynamicSystemPromptAddition: boolean;
  compressionNoticeEnabled: boolean;
  workflowHintsEnabled: boolean;
  replyFooterEnabled: boolean;
  replyFooterMaxCategories: number;
  tokenCalibrationEnabled: boolean;
  tokenCalibrationAlpha: number;
  allowCrossSessionCommands: boolean;
};

export type StoredSessionData = {
  version: 1;
  sessionId: string;
  sessionKey?: string;
  createdAt: string;
  updatedAt: string;
  compactedThroughMessageCount: number;
  compactedPrefixSanitizedTokens: number;
  compactedPrefixAttachmentTrimmedTokens: number;
  consecutiveAutoCompactFailures: number;
  lastAutoCompactFailureAt?: string;
  lastAutoCompactFailureReason?: string;
  lastCompactionAt?: string;
  lastCompactionTrigger?: string;
  state: StructuredSessionState;
  fallbackState: StructuredSessionState;
  fallbackStateActive: boolean;
  fallbackStateRecoveryTurns: number;
  sessionMemory: SessionMemoryDigest;
  proceduralMemory: ProceduralMemoryDigest;
  tokenEstimatorCalibration: TokenEstimatorCalibration;
  persistentCategoryTotals: SavingsTotals;
  persistentTopContributors: SavingsEvent[];
  summary: SessionSavingsSummary;
};

export type RecentRecallSnippet = {
  path?: string;
  source?: string;
  snippet: string;
  score?: number;
};

export type ArchivedHistorySegment = {
  version: 1;
  archiveId: string;
  createdAt: string;
  sessionId: string;
  sessionKey?: string;
  startMessageIndex: number;
  endMessageIndex: number;
  messageCount: number;
  estimatedTokens: number;
  summary: string;
  excerpt: string;
  keywords: string[];
  messages: AgentMessage[];
};

export type ArchiveSearchHit = {
  segment: ArchivedHistorySegment;
  score: number;
  matchedTerms: string[];
  excerpts: string[];
};

export type PendingTurnContext = {
  report: TurnSavingsReport;
};

export type MessageLike = AgentMessage | Record<string, unknown>;
