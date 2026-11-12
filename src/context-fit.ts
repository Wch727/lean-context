import {
  clipText,
  createEmptyStructuredSessionState,
  estimateMessagesTokens,
  estimateTextTokens,
  formatStructuredSessionState,
  isStructuredStateEmpty,
} from "./helpers.js";
import { repairToolUseResultPairing } from "./transcript-utils.js";
import type { AgentMessage, StructuredSessionState } from "./types.js";

export type FittedContext = {
  stateMessage: AgentMessage | null;
  hotContextMessage: AgentMessage | null;
  recoveryMessage: AgentMessage | null;
  recallMessage: AgentMessage | null;
  recentMessages: AgentMessage[];
  systemPromptAddition?: string;
  estimatedTokens: number;
  bootstrapTrimmedTokens: number;
  rescueApplied: boolean;
  rescueNotes: string[];
};

function makeStateMessage(state: StructuredSessionState): AgentMessage | null {
  if (isStructuredStateEmpty(state)) {
    return null;
  }
  return {
    role: "assistant",
    content: [{ type: "text", text: formatStructuredSessionState(state) }],
    timestamp: Date.now(),
  } as AgentMessage;
}

function makeSessionMemoryMessage(state: StructuredSessionState): AgentMessage | null {
  const lines = [
    "LEAN CONTEXT SESSION MEMORY",
    state.goal ? `Goal: ${clipText(state.goal, 72)}` : undefined,
    state.open_todos[0] ? `Next: ${clipText(state.open_todos[0], 56)}` : undefined,
    state.blockers[0] ? `Blocker: ${clipText(state.blockers[0], 56)}` : undefined,
    state.changed_files[0] ? `File: ${clipText(state.changed_files[0], 56)}` : undefined,
  ].filter(Boolean);
  if (lines.length <= 1) {
    return null;
  }
  return {
    role: "assistant",
    content: [{ type: "text", text: lines.join("\n") }],
    timestamp: Date.now(),
  } as AgentMessage;
}

function trimmedItems(values: string[], maxItems: number, maxChars = 180): string[] {
  return values.slice(0, Math.max(0, maxItems)).map((value) => clipText(value, maxChars));
}

function buildStateVariant(state: StructuredSessionState, level: number): StructuredSessionState {
  const empty = createEmptyStructuredSessionState();
  switch (level) {
    case 0:
      return {
        goal: clipText(state.goal, 240),
        done: trimmedItems(state.done, 8),
        open_todos: trimmedItems(state.open_todos, 8),
        changed_files: trimmedItems(state.changed_files, 12, 140),
        important_outputs: trimmedItems(state.important_outputs, 8),
        constraints: trimmedItems(state.constraints, 8),
        decisions: trimmedItems(state.decisions, 8),
        blockers: trimmedItems(state.blockers, 8),
      };
    case 1:
      return {
        goal: clipText(state.goal, 220),
        done: trimmedItems(state.done, 4),
        open_todos: trimmedItems(state.open_todos, 4),
        changed_files: trimmedItems(state.changed_files, 8, 120),
        important_outputs: trimmedItems(state.important_outputs, 4),
        constraints: trimmedItems(state.constraints, 4),
        decisions: trimmedItems(state.decisions, 4),
        blockers: trimmedItems(state.blockers, 4),
      };
    case 2:
      return {
        ...empty,
        goal: clipText(state.goal, 200),
        open_todos: trimmedItems(state.open_todos, 4),
        changed_files: trimmedItems(state.changed_files, 6, 120),
        decisions: trimmedItems(state.decisions, 3),
        blockers: trimmedItems(state.blockers, 4),
      };
    case 3:
      return {
        ...empty,
        goal: clipText(state.goal, 180),
        open_todos: trimmedItems(state.open_todos, 3),
        blockers: trimmedItems(state.blockers, 3),
      };
    default:
      return {
        ...empty,
        goal: clipText(state.goal, 160),
      };
  }
}

function fitStateToBudget(
  state: StructuredSessionState,
  tokenBudget: number,
): { message: AgentMessage | null; levelUsed?: number | "memory" } {
  if (tokenBudget <= 0 || isStructuredStateEmpty(state)) {
    return { message: null };
  }
  for (const level of [0, 1, 2, 3]) {
    const candidate = makeStateMessage(buildStateVariant(state, level));
    const candidateTokens = candidate ? estimateMessagesTokens([candidate]) : 0;
    if (candidateTokens <= tokenBudget) {
      return { message: candidate, levelUsed: level };
    }
  }
  const memoryMessage = makeSessionMemoryMessage(state);
  const memoryTokens = memoryMessage ? estimateMessagesTokens([memoryMessage]) : 0;
  if (memoryMessage && memoryTokens <= tokenBudget) {
    return {
      message: memoryMessage,
      levelUsed: "memory",
    };
  }
  const tinyGoal = clipText(state.goal, Math.max(48, tokenBudget * 4));
  if (!tinyGoal) {
    return { message: null };
  }
  return {
    message: makeStateMessage({
      ...createEmptyStructuredSessionState(),
      goal: tinyGoal,
    }),
    levelUsed: 5,
  };
}

function estimateContextTokens(params: {
  stateMessage: AgentMessage | null;
  hotContextMessage: AgentMessage | null;
  recoveryMessage: AgentMessage | null;
  recallMessage: AgentMessage | null;
  recentMessages: AgentMessage[];
  systemPromptAddition?: string;
}): number {
  return (
    estimateMessagesTokens([
      ...(params.stateMessage ? [params.stateMessage] : []),
      ...(params.hotContextMessage ? [params.hotContextMessage] : []),
      ...(params.recoveryMessage ? [params.recoveryMessage] : []),
      ...(params.recallMessage ? [params.recallMessage] : []),
      ...params.recentMessages,
    ]) + estimateTextTokens(params.systemPromptAddition ?? "")
  );
}

export function fitContextToBudget(params: {
  state: StructuredSessionState;
  hotContextMessage: AgentMessage | null;
  recoveryMessage: AgentMessage | null;
  recallMessage: AgentMessage | null;
  recentMessages: AgentMessage[];
  systemPromptAddition?: string;
  tokenBudget?: number;
  minimumRecentMessages?: number;
}): FittedContext {
  let stateMessage = makeStateMessage(params.state);
  let hotContextMessage = params.hotContextMessage;
  let recoveryMessage = params.recoveryMessage;
  let recallMessage = params.recallMessage;
  let recentMessages = [...params.recentMessages];
  let systemPromptAddition = params.systemPromptAddition;
  let bootstrapTrimmedTokens = 0;
  const rescueNotes: string[] = [];
  const minimumRecentMessages = Math.max(
    1,
    Math.min(params.minimumRecentMessages ?? 2, Math.max(1, recentMessages.length)),
  );
  const tokenBudget = params.tokenBudget;

  if (!(typeof tokenBudget === "number" && tokenBudget > 0)) {
    return {
      stateMessage,
      hotContextMessage,
      recoveryMessage,
      recallMessage,
      recentMessages,
      systemPromptAddition,
      bootstrapTrimmedTokens,
      estimatedTokens: estimateContextTokens({
        stateMessage,
        hotContextMessage,
        recoveryMessage,
        recallMessage,
        recentMessages,
        systemPromptAddition,
      }),
      rescueApplied: false,
      rescueNotes,
    };
  }

  let estimatedTokens = estimateContextTokens({
    stateMessage,
    hotContextMessage,
    recoveryMessage,
    recallMessage,
    recentMessages,
    systemPromptAddition,
  });

  if (estimatedTokens > tokenBudget && recallMessage) {
    recallMessage = null;
    rescueNotes.push("Dropped recall snippets to stay within the token budget.");
    estimatedTokens = estimateContextTokens({
      stateMessage,
      hotContextMessage,
      recoveryMessage,
      recallMessage,
      recentMessages,
      systemPromptAddition,
    });
  }

  if (estimatedTokens > tokenBudget && systemPromptAddition) {
    bootstrapTrimmedTokens = estimateTextTokens(systemPromptAddition);
    systemPromptAddition = undefined;
    rescueNotes.push("Dropped dynamic systemPromptAddition under token pressure.");
    estimatedTokens = estimateContextTokens({
      stateMessage,
      hotContextMessage,
      recoveryMessage,
      recallMessage,
      recentMessages,
      systemPromptAddition,
    });
  }

  if (estimatedTokens > tokenBudget && stateMessage) {
    const tokensWithoutState = estimateContextTokens({
      stateMessage: null,
      hotContextMessage,
      recoveryMessage,
      recallMessage,
      recentMessages,
      systemPromptAddition,
    });
    const fittedState = fitStateToBudget(
      params.state,
      Math.max(0, tokenBudget - tokensWithoutState),
    );
    const nextStateMessage = fittedState.message;
    const currentStateTokens = estimateMessagesTokens([stateMessage]);
    const nextStateTokens = nextStateMessage ? estimateMessagesTokens([nextStateMessage]) : 0;
    if (nextStateTokens < currentStateTokens) {
      stateMessage = nextStateMessage;
      rescueNotes.push(
        fittedState.levelUsed === "memory"
          ? "Collapsed structured session_state into a compact session memory digest."
          : "Trimmed structured session_state to fit the token budget.",
      );
      estimatedTokens = estimateContextTokens({
        stateMessage,
        hotContextMessage,
        recoveryMessage,
        recallMessage,
        recentMessages,
        systemPromptAddition,
      });
    }
  }

  let droppedRecentCount = 0;
  while (estimatedTokens > tokenBudget && recentMessages.length > minimumRecentMessages) {
    recentMessages = repairToolUseResultPairing(recentMessages.slice(1));
    droppedRecentCount += 1;
    estimatedTokens = estimateContextTokens({
      stateMessage,
      hotContextMessage,
      recoveryMessage,
      recallMessage,
      recentMessages,
      systemPromptAddition,
    });
  }
  if (droppedRecentCount > 0) {
    rescueNotes.push(
      `Dropped ${droppedRecentCount} older recent message(s) to keep the assembled context under budget.`,
    );
  }

  if (estimatedTokens > tokenBudget && stateMessage) {
    const tokensWithoutState = estimateContextTokens({
      stateMessage: null,
      hotContextMessage,
      recoveryMessage,
      recallMessage,
      recentMessages,
      systemPromptAddition,
    });
    if (tokensWithoutState <= tokenBudget) {
      stateMessage = null;
      rescueNotes.push("Dropped structured session_state entirely under severe token pressure.");
      estimatedTokens = tokensWithoutState;
    }
  }

  if (estimatedTokens > tokenBudget && recoveryMessage) {
    const tokensWithoutRecovery = estimateContextTokens({
      stateMessage,
      hotContextMessage,
      recoveryMessage: null,
      recallMessage,
      recentMessages,
      systemPromptAddition,
    });
    if (tokensWithoutRecovery <= tokenBudget) {
      recoveryMessage = null;
      rescueNotes.push("Dropped recovered archive excerpts under severe token pressure.");
      estimatedTokens = tokensWithoutRecovery;
    }
  }

  if (estimatedTokens > tokenBudget && hotContextMessage) {
    const tokensWithoutHotContext = estimateContextTokens({
      stateMessage,
      hotContextMessage: null,
      recoveryMessage,
      recallMessage,
      recentMessages,
      systemPromptAddition,
    });
    if (tokensWithoutHotContext <= tokenBudget) {
      hotContextMessage = null;
      rescueNotes.push("Dropped reinjected hot context under severe token pressure.");
      estimatedTokens = tokensWithoutHotContext;
    }
  }

  return {
    stateMessage,
    hotContextMessage,
    recoveryMessage,
    recallMessage,
    recentMessages,
    systemPromptAddition,
    bootstrapTrimmedTokens,
    estimatedTokens,
    rescueApplied: rescueNotes.length > 0,
    rescueNotes,
  };
}
