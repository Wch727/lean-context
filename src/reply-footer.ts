import { formatTurnReportForFooter } from "./reporting.js";
import type { TurnSavingsReport } from "./types.js";

type ConversationBinding = {
  sessionIdentity: string;
  updatedAt: number;
};

type PendingReplyFooter = {
  report: TurnSavingsReport;
  createdAt: number;
};

const CONVERSATION_BINDINGS_KEY = Symbol.for("openclaw.leanContext.conversationBindings");
const PENDING_REPLY_FOOTERS_KEY = Symbol.for("openclaw.leanContext.pendingReplyFooters");
const MAX_STORE_SIZE = 512;
const STALE_MS = 1000 * 60 * 60 * 12;
const FOOTER_PREFIX = "[Lean Context]";

function getGlobalStore<T>(key: symbol, create: () => T): T {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  const existing = globalRecord[key];
  if (existing) {
    return existing as T;
  }
  const next = create();
  globalRecord[key] = next;
  return next;
}

function getConversationBindings(): Map<string, ConversationBinding> {
  return getGlobalStore(CONVERSATION_BINDINGS_KEY, () => new Map<string, ConversationBinding>());
}

function getPendingReplyFooters(): Map<string, PendingReplyFooter> {
  return getGlobalStore(PENDING_REPLY_FOOTERS_KEY, () => new Map<string, PendingReplyFooter>());
}

function pruneConversationBindings(now = Date.now()): void {
  const bindings = getConversationBindings();
  for (const [key, value] of bindings) {
    if (now - value.updatedAt > STALE_MS) {
      bindings.delete(key);
    }
  }
  while (bindings.size > MAX_STORE_SIZE) {
    const oldest = bindings.entries().next().value as [string, ConversationBinding] | undefined;
    if (!oldest) {
      break;
    }
    bindings.delete(oldest[0]);
  }
}

function prunePendingReplyFooters(now = Date.now()): void {
  const pending = getPendingReplyFooters();
  for (const [key, value] of pending) {
    if (now - value.createdAt > STALE_MS) {
      pending.delete(key);
    }
  }
  while (pending.size > MAX_STORE_SIZE) {
    const oldest = pending.entries().next().value as [string, PendingReplyFooter] | undefined;
    if (!oldest) {
      break;
    }
    pending.delete(oldest[0]);
  }
}

function conversationBindingKey(params: {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
}): string | null {
  if (!params.channelId?.trim() || !params.conversationId?.trim()) {
    return null;
  }
  return `${params.channelId.trim()}::${params.accountId?.trim() ?? ""}::${params.conversationId.trim()}`;
}

export function rememberConversationSession(params: {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  sessionIdentity?: string;
}): void {
  if (!params.sessionIdentity?.trim()) {
    return;
  }
  const key = conversationBindingKey(params);
  if (!key) {
    return;
  }
  const now = Date.now();
  pruneConversationBindings(now);
  getConversationBindings().set(key, {
    sessionIdentity: params.sessionIdentity.trim(),
    updatedAt: now,
  });
}

export function queuePendingReplyFooter(params: {
  sessionIdentity?: string;
  report: TurnSavingsReport;
}): void {
  if (
    !params.sessionIdentity?.trim() ||
    (params.report.totalSavedTokens <= 0 && !params.report.statusNotices?.length)
  ) {
    return;
  }
  const now = Date.now();
  prunePendingReplyFooters(now);
  getPendingReplyFooters().set(params.sessionIdentity.trim(), {
    report: params.report,
    createdAt: now,
  });
}

export function clearPendingReplyFooter(sessionIdentity?: string): void {
  if (!sessionIdentity?.trim()) {
    return;
  }
  getPendingReplyFooters().delete(sessionIdentity.trim());
}

export function forgetSessionConversationMappings(sessionIdentity?: string): void {
  if (!sessionIdentity?.trim()) {
    return;
  }
  const trimmed = sessionIdentity.trim();
  const bindings = getConversationBindings();
  for (const [key, value] of bindings) {
    if (value.sessionIdentity === trimmed) {
      bindings.delete(key);
    }
  }
}

export function formatTurnReportFooter(
  report: TurnSavingsReport,
  options: { maxCategories?: number } = {},
): string | null {
  return formatTurnReportForFooter(report, options);
}

export function applyPendingReplyFooter(params: {
  content: string;
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  enabled: boolean;
  maxCategories?: number;
}): string {
  if (!params.enabled) {
    return params.content;
  }
  if (!params.content.trim() || params.content.includes(FOOTER_PREFIX)) {
    return params.content;
  }
  const bindingKey = conversationBindingKey({
    channelId: params.channelId,
    accountId: params.accountId,
    conversationId: params.conversationId,
  });
  if (!bindingKey) {
    return params.content;
  }
  pruneConversationBindings();
  const binding = getConversationBindings().get(bindingKey);
  if (!binding) {
    return params.content;
  }
  prunePendingReplyFooters();
  const pending = getPendingReplyFooters().get(binding.sessionIdentity);
  if (!pending) {
    return params.content;
  }
  const footer = formatTurnReportFooter(pending.report, {
    maxCategories: params.maxCategories,
  });
  if (!footer) {
    getPendingReplyFooters().delete(binding.sessionIdentity);
    return params.content;
  }
  getPendingReplyFooters().delete(binding.sessionIdentity);
  return `${params.content.trimEnd()}\n\n${footer}`;
}
