import { afterEach, describe, expect, it } from "vitest";
import {
  applyPendingReplyFooter,
  clearPendingReplyFooter,
  forgetSessionConversationMappings,
  queuePendingReplyFooter,
  rememberConversationSession,
} from "./src/reply-footer.js";
import { buildTurnSavingsReport } from "./src/reporting.js";

function buildReport() {
  return buildTurnSavingsReport({
    turnId: "turn-footer",
    createdAt: new Date().toISOString(),
    sessionId: "session-footer",
    sessionKey: "agent:main:footer",
    rawSnapshot: {
      kind: "raw",
      estimatedTokens: 2400,
      messageCount: 18,
    },
    assembledSnapshot: {
      kind: "assembled",
      estimatedTokens: 1520,
      messageCount: 7,
    },
    categorySavings: {
      tool_result_slimming: 180,
      history_compaction: 700,
      history_exclusion: 0,
      tool_schema_avoidance: 0,
      bootstrap_trim: 0,
      attachment_trimming: 0,
    },
    topContributors: [
      {
        id: "footer-history",
        turnId: "turn-footer",
        ts: Date.now(),
        sessionId: "session-footer",
        sessionKey: "agent:main:footer",
        category: "history_compaction",
        tokensSaved: 700,
        label: "Structured session_state replaced compacted older history",
      },
    ],
  });
}

describe("lean-context reply footer", () => {
  const sessionIdentity = "agent:main:footer";

  afterEach(() => {
    clearPendingReplyFooter(sessionIdentity);
    forgetSessionConversationMappings(sessionIdentity);
  });

  it("appends a one-shot footer to the next visible reply for the mapped conversation", () => {
    rememberConversationSession({
      channelId: "web",
      accountId: "main",
      conversationId: "chat-1",
      sessionIdentity,
    });
    queuePendingReplyFooter({
      sessionIdentity,
      report: buildReport(),
    });

    const content = applyPendingReplyFooter({
      content: "Finished the change.",
      channelId: "web",
      accountId: "main",
      conversationId: "chat-1",
      enabled: true,
      maxCategories: 2,
    });

    expect(content).toContain("Finished the change.");
    expect(content).toContain("[Lean Context]");
    expect(content).toContain("Estimated saved 880 tokens this turn.");
    expect(content).toContain("structured history compaction 700");
    expect(content).toContain("tool result slimming 180");

    const second = applyPendingReplyFooter({
      content: "Second chunk",
      channelId: "web",
      accountId: "main",
      conversationId: "chat-1",
      enabled: true,
      maxCategories: 2,
    });

    expect(second).toBe("Second chunk");
  });

  it("skips footer injection when disabled", () => {
    rememberConversationSession({
      channelId: "web",
      accountId: "main",
      conversationId: "chat-2",
      sessionIdentity,
    });
    queuePendingReplyFooter({
      sessionIdentity,
      report: buildReport(),
    });

    const content = applyPendingReplyFooter({
      content: "No footer please.",
      channelId: "web",
      accountId: "main",
      conversationId: "chat-2",
      enabled: false,
      maxCategories: 2,
    });

    expect(content).toBe("No footer please.");
  });

  it("still appends a footer when only a status notice is present", () => {
    rememberConversationSession({
      channelId: "web",
      accountId: "main",
      conversationId: "chat-3",
      sessionIdentity,
    });
    const report = buildTurnSavingsReport({
      turnId: "turn-breaker",
      createdAt: new Date().toISOString(),
      sessionId: "session-footer",
      sessionKey: "agent:main:footer",
      statusNotices: ["Auto-compaction is paused after 3 consecutive failures."],
      rawSnapshot: {
        kind: "raw",
        estimatedTokens: 800,
        messageCount: 4,
      },
      assembledSnapshot: {
        kind: "assembled",
        estimatedTokens: 800,
        messageCount: 4,
      },
      categorySavings: {
        tool_result_slimming: 0,
        history_compaction: 0,
        history_exclusion: 0,
        tool_schema_avoidance: 0,
        bootstrap_trim: 0,
        attachment_trimming: 0,
      },
      topContributors: [],
    });
    queuePendingReplyFooter({
      sessionIdentity,
      report,
    });

    const content = applyPendingReplyFooter({
      content: "Still working.",
      channelId: "web",
      accountId: "main",
      conversationId: "chat-3",
      enabled: true,
      maxCategories: 2,
    });

    expect(content).toContain("[Lean Context]");
    expect(content).toContain("Auto-compaction is paused");
  });
});
