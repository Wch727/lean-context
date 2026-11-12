import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "openclaw/plugin-sdk/core";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import {
  formatArchiveIndexForCommand,
  formatArchiveRestoreForCommand,
  searchArchivedHistory,
} from "./src/archive.js";
import { resolveLeanContextConfig } from "./src/config.js";
import { LeanContextEngine, recordPendingSlimming } from "./src/engine.js";
import {
  applyPendingReplyFooter,
  clearPendingReplyFooter,
  forgetSessionConversationMappings,
  rememberConversationSession,
} from "./src/reply-footer.js";
import {
  buildTurnReportInteractiveReply,
  formatSessionSummaryForCommand,
  formatTurnReportForCommand,
  formatTurnReportVisualization,
} from "./src/reporting.js";
import {
  ensurePluginStateDirs,
  readArchivedHistorySegments,
  readLatestTurnReport,
  readSessionSummary,
} from "./src/store.js";
import { slimToolResultForPersistence } from "./src/tool-result-slimmer.js";

async function resolvePluginStateDir(api: OpenClawPluginApi): Promise<string> {
  return await ensurePluginStateDirs(api.runtime.state.resolveStateDir());
}

function formatCommandUsage(): string {
  return [
    "Lean Context commands:",
    "- /lean-context",
    "- /lean-context board [sessionId] [sessionKey]",
    "- /lean-context archive [sessionId] [sessionKey]",
    "- /lean-context restore <query>",
    "- /lean-context restore <sessionId> [sessionKey] -- <query>",
    "- /lean-context latest <sessionId> [sessionKey]",
    "- /lean-context summary <sessionId> [sessionKey]",
  ].join("\n");
}

function resolveSessionIdentity(sessionId?: string, sessionKey?: string): string | undefined {
  const key = sessionKey?.trim();
  if (key) {
    return key;
  }
  const id = sessionId?.trim();
  return id || undefined;
}

async function resolveArchiveCommandTarget(params: {
  pluginStateDir: string;
  sessionId?: string;
  sessionKey?: string;
}) {
  if (params.sessionId) {
    return {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    };
  }
  const latest = await readLatestTurnReport({
    pluginStateDir: params.pluginStateDir,
  });
  if (!latest) {
    return null;
  }
  return {
    sessionId: latest.sessionId,
    sessionKey: latest.sessionKey,
  };
}

async function handleLeanContextCommand(
  api: OpenClawPluginApi,
  ctx: PluginCommandContext,
): Promise<ReplyPayload> {
  const pluginStateDir = await resolvePluginStateDir(api);
  const rawArgs = (ctx.args ?? "").trim();
  const args = rawArgs.split(/\s+/).filter(Boolean);
  const action = args[0]?.toLowerCase() ?? "latest";
  if (action === "help") {
    return { text: formatCommandUsage() };
  }
  if (action === "summary") {
    const sessionId = args[1];
    const sessionKey = args[2];
    if (!sessionId) {
      return {
        text:
          "Provide a session id for /lean-context summary <sessionId> [sessionKey].\n\n" +
          formatCommandUsage(),
      };
    }
    const summary = await readSessionSummary({
      pluginStateDir,
      sessionId,
      sessionKey,
    });
    return {
      text: summary
        ? formatSessionSummaryForCommand(summary)
        : "No lean-context session summary is available for that session yet.",
    };
  }
  if (action === "archive") {
    const target = await resolveArchiveCommandTarget({
      pluginStateDir,
      sessionId: args[1],
      sessionKey: args[2],
    });
    if (!target) {
      return {
        text: "No lean-context archive is available yet.\n\n" + formatCommandUsage(),
      };
    }
    const segments = await readArchivedHistorySegments({
      pluginStateDir,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
    });
    return {
      text: formatArchiveIndexForCommand(segments),
    };
  }
  if (action === "restore") {
    const delimiterIndex = args.indexOf("--");
    const beforeDelimiter = delimiterIndex >= 0 ? args.slice(1, delimiterIndex) : args.slice(1);
    const afterDelimiter = delimiterIndex >= 0 ? args.slice(delimiterIndex + 1) : [];
    const explicitQuery =
      delimiterIndex >= 0 ? afterDelimiter.join(" ").trim() : rawArgs.slice(8).trim();
    const query =
      delimiterIndex >= 0
        ? explicitQuery
        : beforeDelimiter.length >= 1 && args.length > 1
          ? args.slice(1).join(" ").trim()
          : "";
    if (!query) {
      return {
        text:
          "Provide a query for /lean-context restore. Example: /lean-context restore what did we say about module-1?\n\n" +
          formatCommandUsage(),
      };
    }
    const target =
      delimiterIndex >= 0
        ? await resolveArchiveCommandTarget({
            pluginStateDir,
            sessionId: beforeDelimiter[0],
            sessionKey: beforeDelimiter[1],
          })
        : await resolveArchiveCommandTarget({
            pluginStateDir,
          });
    if (!target) {
      return {
        text: "No lean-context archive is available yet.\n\n" + formatCommandUsage(),
      };
    }
    const segments = await readArchivedHistorySegments({
      pluginStateDir,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
    });
    const hits = searchArchivedHistory({
      segments,
      query,
      config: resolveLeanContextConfig(api.pluginConfig),
    });
    return {
      text: formatArchiveRestoreForCommand({
        query,
        hits,
      }),
    };
  }

  const isBoard = action === "board";
  const sessionId =
    action === "latest" || action === "board"
      ? args[1]
      : args[0] !== "latest" && args[0] !== "board"
        ? args[0]
        : undefined;
  const sessionKey =
    action === "latest" || action === "board"
      ? args[2]
      : args[0] !== "latest" && args[0] !== "board"
        ? args[1]
        : undefined;
  const report = await readLatestTurnReport({
    pluginStateDir,
    ...(sessionId ? { sessionId, sessionKey } : {}),
  });
  if (!report) {
    return {
      text: "No lean-context turn report has been written yet.",
    };
  }
  if (isBoard) {
    return {
      text: formatTurnReportVisualization(report),
      interactive: buildTurnReportInteractiveReply(report),
    };
  }
  return {
    text: formatTurnReportForCommand(report),
    interactive: buildTurnReportInteractiveReply(report),
  };
}

export default definePluginEntry({
  id: "lean-context",
  name: "Lean Context",
  description: "Structured context assembly with transcript slimming and token savings reporting",
  kind: "context-engine",
  register(api) {
    const config = resolveLeanContextConfig(api.pluginConfig);
    api.registerContextEngine(
      "lean-context",
      () =>
        new LeanContextEngine({
          stateRootDir: api.runtime.state.resolveStateDir(),
          logger: api.logger,
          cfg: api.config,
          config,
        }),
    );

    api.on(
      "tool_result_persist",
      (event, hookCtx) => {
        const result = slimToolResultForPersistence({
          config,
          stateRootDir: api.runtime.state.resolveStateDir(),
          sessionId: hookCtx.sessionKey ?? hookCtx.agentId,
          sessionKey: hookCtx.sessionKey,
          toolName: event.toolName ?? hookCtx.toolName,
          message: event.message,
        });
        if (!result.changed) {
          return;
        }
        const identity = hookCtx.sessionKey ?? hookCtx.agentId;
        if (identity) {
          recordPendingSlimming({
            stateRootDir: api.runtime.state.resolveStateDir(),
            sessionIdentity: identity,
            events: result.events,
          });
        }
        return { message: result.message };
      },
      { priority: 90 },
    );

    api.on("before_dispatch", (_event, hookCtx) => {
      const sessionIdentity = hookCtx.sessionKey?.trim();
      if (!sessionIdentity) {
        return;
      }
      clearPendingReplyFooter(sessionIdentity);
      rememberConversationSession({
        channelId: hookCtx.channelId,
        accountId: hookCtx.accountId,
        conversationId: hookCtx.conversationId,
        sessionIdentity,
      });
      return;
    });

    api.on("message_sending", (event, hookCtx) => {
      const nextContent = applyPendingReplyFooter({
        content: event.content,
        channelId: hookCtx.channelId,
        accountId: hookCtx.accountId,
        conversationId: event.to,
        enabled: config.replyFooterEnabled,
        maxCategories: config.replyFooterMaxCategories,
      });
      if (nextContent === event.content) {
        return;
      }
      return { content: nextContent };
    });

    api.on("before_reset", (_event, hookCtx) => {
      const sessionIdentity = resolveSessionIdentity(hookCtx.sessionId, hookCtx.sessionKey);
      if (!sessionIdentity) {
        return;
      }
      clearPendingReplyFooter(sessionIdentity);
      forgetSessionConversationMappings(sessionIdentity);
    });

    api.on("session_end", (_event, hookCtx) => {
      const sessionIdentity = resolveSessionIdentity(hookCtx.sessionId, hookCtx.sessionKey);
      if (!sessionIdentity) {
        return;
      }
      clearPendingReplyFooter(sessionIdentity);
      forgetSessionConversationMappings(sessionIdentity);
    });

    const command: OpenClawPluginCommandDefinition = {
      name: "lean-context",
      description: "Show the latest lean-context savings report or a session summary.",
      acceptsArgs: true,
      handler: async (ctx) => await handleLeanContextCommand(api, ctx),
    };
    api.registerCommand(command);
  },
});
