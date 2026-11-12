/**
 * Command authorization scope for lean-context.
 *
 * OpenClaw 2026.4.1's PluginCommandContext does not expose the caller's
 * sessionId/sessionKey, so the plugin cannot bind a command to the caller's
 * conversation. Commands are therefore gated on `isAuthorizedSender`, and any
 * explicit cross-session argument is opt-in via `allowCrossSessionCommands`.
 */

export type CommandScopeDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export function checkCommandScope(params: {
  isAuthorizedSender: boolean;
  allowCrossSessionCommands: boolean;
  hasExplicitSessionArgs: boolean;
}): CommandScopeDecision {
  if (!params.isAuthorizedSender) {
    return {
      allowed: false,
      reason: "lean-context commands are restricted to authorized senders.",
    };
  }
  if (params.hasExplicitSessionArgs && !params.allowCrossSessionCommands) {
    return {
      allowed: false,
      reason:
        "Cross-session command arguments are disabled. Omit <sessionId>/<sessionKey>, " +
        "or enable allowCrossSessionCommands explicitly.",
    };
  }
  return { allowed: true };
}

/**
 * Whether the parsed command arguments address a session other than the
 * caller's own (i.e. they include an explicit session id/key).
 */
export function hasExplicitSessionIdentity(action: string, args: string[]): boolean {
  if (action === "help") {
    return false;
  }
  if (action === "summary" || action === "archive" || action === "latest" || action === "board") {
    return Boolean(args[1]);
  }
  if (action === "restore") {
    const delimiterIndex = args.indexOf("--");
    // restore <sessionId> [sessionKey] -- <query>; args before "--" include the session.
    return delimiterIndex > 1;
  }
  // Any unrecognized first argument is treated as a session id by the default branch.
  return Boolean(args[0]);
}
