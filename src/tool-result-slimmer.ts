import fs from "node:fs";
import path from "node:path";
import {
  buildEventId,
  clipText,
  estimateMessagesTokens,
  estimateTextTokens,
  estimateUnknownTokens,
  normalizeWhitespace,
  pickNumber,
  pickString,
  safeJsonParse,
  sessionStorageKey,
  takeLastMeaningfulLines,
  toPlainText,
} from "./helpers.js";
import type { AgentMessage, LeanContextConfig, SavingsEvent, SavingsTotals } from "./types.js";

type SlimToolResultParams = {
  config: LeanContextConfig;
  stateRootDir: string;
  sessionId?: string;
  sessionKey?: string;
  turnId?: string;
  toolName?: string;
  message: AgentMessage;
};

type SlimToolResultResult = {
  changed: boolean;
  message: AgentMessage;
  events: SavingsEvent[];
};

// Extended tool type detection
function isExecLike(toolName?: string): boolean {
  return (
    !!toolName &&
    /\b(exec|shell|bash|powershell|terminal|command|process|run|spawn|cmd|sh|zsh|fish)\b/i.test(
      toolName,
    )
  );
}

function isBrowserLike(toolName?: string): boolean {
  return (
    !!toolName &&
    /\b(browser|read|fetch|search|web|crawl|scrape|exa|tavily|perplexity|searx|bing|google|duckduckgo)\b/i.test(
      toolName,
    )
  );
}

function isFileLike(toolName?: string): boolean {
  return (
    !!toolName && /\b(file|read|write|edit|cat|ls|dir|glob|find|stat|fs|path)\b/i.test(toolName)
  );
}

function isGitLike(toolName?: string): boolean {
  return (
    !!toolName && /\b(git|github|gh|commit|branch|merge|diff|blame|log|status)\b/i.test(toolName)
  );
}

function isDbLike(toolName?: string): boolean {
  return (
    !!toolName && /\b(db|sql|query|database|mongo|redis|postgres|mysql|sqlite)\b/i.test(toolName)
  );
}

function isApiLike(toolName?: string): boolean {
  return (
    !!toolName && /\b(api|http|request|post|get|put|delete|patch|rest|graphql)\b/i.test(toolName)
  );
}

function isTestLike(toolName?: string): boolean {
  return !!toolName && /\b(test|jest|vitest|mocha|pytest|unittest|spec)\b/i.test(toolName);
}

function countAttachmentTokens(content: unknown): number {
  if (!Array.isArray(content)) {
    return 0;
  }
  let total = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const type = (block as { type?: unknown }).type;
    if (type === "text" || type === "thinking") {
      continue;
    }
    total += estimateUnknownTokens(block);
  }
  return total;
}

function buildArchivePath(params: SlimToolResultParams): string {
  const root = path.join(
    params.stateRootDir,
    "plugins",
    "lean-context",
    "tool-results",
    sessionStorageKey(params.sessionId ?? "unknown", params.sessionKey),
  );
  fs.mkdirSync(root, { recursive: true });
  const toolPart =
    (params.toolName ?? "tool").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 40) || "tool";
  const callId =
    typeof (params.message as { toolCallId?: unknown }).toolCallId === "string"
      ? ((params.message as { toolCallId: string }).toolCallId || "call").replace(
          /[^a-zA-Z0-9._-]+/g,
          "-",
        )
      : "call";
  return path.join(root, `${Date.now()}-${toolPart}-${callId}.json`);
}

// Archive cleanup - remove old archives to prevent unbounded growth
function cleanupOldArchives(
  stateRootDir: string,
  maxAgeDays: number = 7,
  maxFiles: number = 100,
): void {
  try {
    const toolResultsDir = path.join(stateRootDir, "plugins", "lean-context", "tool-results");
    if (!fs.existsSync(toolResultsDir)) return;

    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

    // Get all archive files with stats
    const entries: { path: string; mtime: number }[] = [];
    for (const sessionDir of fs.readdirSync(toolResultsDir)) {
      const sessionPath = path.join(toolResultsDir, sessionDir);
      if (!fs.statSync(sessionPath).isDirectory()) continue;

      for (const file of fs.readdirSync(sessionPath)) {
        const filePath = path.join(sessionPath, file);
        const stat = fs.statSync(filePath);
        entries.push({ path: filePath, mtime: stat.mtimeMs });
      }
    }

    // Sort by modification time (oldest first)
    entries.sort((a, b) => a.mtime - b.mtime);

    // Remove old files
    for (const entry of entries) {
      const age = now - entry.mtime;
      if (age > maxAgeMs || entries.length > maxFiles) {
        try {
          fs.unlinkSync(entry.path);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  } catch {
    // Cleanup errors are non-critical
  }
}

function maybeArchiveOriginal(params: SlimToolResultParams): string | undefined {
  if (!params.config.persistLargeToolResults) {
    return undefined;
  }

  // Periodically cleanup old archives
  if (Math.random() < 0.1) {
    // 10% chance
    cleanupOldArchives(params.stateRootDir);
  }

  const file = buildArchivePath(params);
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        savedAt: new Date().toISOString(),
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        toolName: params.toolName,
        message: params.message,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return file;
}

function parseCommonPayload(message: AgentMessage): {
  parsed?: Record<string, unknown>;
  rawText: string;
} {
  const rawText = normalizeWhitespace(toPlainText((message as { content?: unknown }).content));
  const parsedFromText = safeJsonParse(rawText);
  if (parsedFromText && typeof parsedFromText === "object" && !Array.isArray(parsedFromText)) {
    return { parsed: parsedFromText as Record<string, unknown>, rawText };
  }
  const details = (message as { details?: unknown }).details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    return { parsed: details as Record<string, unknown>, rawText };
  }
  return { rawText };
}

function buildExecSummary(params: {
  message: AgentMessage;
  parsed?: Record<string, unknown>;
  rawText: string;
  config: LeanContextConfig;
  archivedPath?: string;
}): string {
  const parsed = params.parsed ?? {};
  const stdout = pickString(parsed, ["stdout", "output", "result"]) ?? params.rawText;
  const stderr = pickString(parsed, ["stderr", "error", "errors"]);
  const exitCode = pickNumber(parsed, ["exitCode", "exit_code", "code", "status"]);
  const stdoutLines = takeLastMeaningfulLines(stdout, params.config.toolOutputTailLines);
  const stderrLines = stderr
    ? takeLastMeaningfulLines(
        stderr,
        Math.max(3, Math.floor(params.config.toolOutputTailLines / 2)),
      )
    : [];
  const lines = ["LEAN TOOL RESULT: exec"];
  if (typeof exitCode === "number") {
    lines.push(`exit_code=${exitCode}`);
  }
  if (stderrLines.length > 0) {
    lines.push("stderr_excerpt:");
    lines.push(
      ...stderrLines.map((line) => `  ${clipText(line, params.config.toolOutputExcerptChars)}`),
    );
  }
  if (stdoutLines.length > 0) {
    lines.push("stdout_tail:");
    lines.push(
      ...stdoutLines.map((line) => `  ${clipText(line, params.config.toolOutputExcerptChars)}`),
    );
  }
  lines.push(
    `counts: stdout_lines=${stdout ? stdout.split(/\r?\n/).length : 0}, stderr_lines=${
      stderr ? stderr.split(/\r?\n/).length : 0
    }, chars=${stdout.length + (stderr?.length ?? 0)}`,
  );
  if (params.archivedPath) {
    lines.push(`full_output_saved=${params.archivedPath}`);
  }
  return lines.join("\n");
}

function stringifySnippet(value: unknown, maxChars: number): string {
  if (typeof value === "string") {
    return clipText(normalizeWhitespace(value), maxChars);
  }
  return clipText(normalizeWhitespace(JSON.stringify(value)), maxChars);
}

function buildSearchSummary(params: {
  message: AgentMessage;
  parsed?: Record<string, unknown>;
  rawText: string;
  config: LeanContextConfig;
  archivedPath?: string;
}): string {
  const parsed = params.parsed ?? {};
  const items =
    (Array.isArray(parsed.results) && parsed.results) ||
    (Array.isArray(parsed.items) && parsed.items) ||
    (Array.isArray(parsed.matches) && parsed.matches) ||
    (Array.isArray(parsed.hits) && parsed.hits) ||
    [];
  const lines = ["LEAN TOOL RESULT: document/web"];
  const title = pickString(parsed, ["title", "name"]);
  const url = pickString(parsed, ["url"]);
  const source = pickString(parsed, ["source", "provider", "domain"]);
  const filePath = pickString(parsed, ["path", "filePath", "relPath"]);
  const summary = pickString(parsed, ["summary", "answer", "abstract"]);
  const query = pickString(parsed, ["query", "q"]);
  if (query) {
    lines.push(`query=${query}`);
  }
  if (title) {
    lines.push(`title=${title}`);
  }
  if (source) {
    lines.push(`source=${source}`);
  }
  if (url) {
    lines.push(`url=${url}`);
  }
  if (filePath) {
    lines.push(`path=${filePath}`);
  }
  if (summary) {
    lines.push(`summary=${clipText(summary, params.config.toolOutputExcerptChars)}`);
  }
  if (items.length > 0) {
    lines.push(`result_count=${items.length}`);
    for (const item of items.slice(0, 3)) {
      const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const itemTitle =
        pickString(record, ["title", "name"]) ?? pickString(record, ["url", "path"]) ?? "result";
      const snippet =
        pickString(record, ["snippet", "excerpt", "summary", "text"]) ??
        stringifySnippet(item, params.config.toolOutputExcerptChars);
      lines.push(`- ${itemTitle}`);
      lines.push(`  ${clipText(snippet, params.config.toolOutputExcerptChars)}`);
    }
  } else if (params.rawText) {
    const excerpt = takeLastMeaningfulLines(
      params.rawText,
      Math.max(4, Math.floor(params.config.toolOutputTailLines / 2)),
    )
      .map((line) => clipText(line, params.config.toolOutputExcerptChars))
      .join("\n");
    if (excerpt) {
      lines.push("excerpt:");
      lines.push(excerpt);
    }
  }
  if (params.archivedPath) {
    lines.push(`full_output_saved=${params.archivedPath}`);
  }
  return lines.join("\n");
}

function buildFileSummary(params: {
  message: AgentMessage;
  parsed?: Record<string, unknown>;
  rawText: string;
  config: LeanContextConfig;
  archivedPath?: string;
}): string {
  const parsed = params.parsed ?? {};
  const lines = ["LEAN TOOL RESULT: file"];

  const path = pickString(parsed, ["path", "filePath", "file", "filename"]);
  const size = pickNumber(parsed, ["size", "fileSize", "bytes"]);
  const lines_ = pickNumber(parsed, ["lines", "lineCount"]);
  const encoding = pickString(parsed, ["encoding", "charset"]);

  if (path) lines.push(`path=${path}`);
  if (size != null) lines.push(`size=${size} bytes`);
  if (lines_ != null) lines.push(`lines=${lines_}`);
  if (encoding) lines.push(`encoding=${encoding}`);

  // Add brief excerpt if it's a text file
  const content = pickString(parsed, ["content", "text", "data"]);
  if (content) {
    const excerpt = takeLastMeaningfulLines(content, 6)
      .map((line) => clipText(line, params.config.toolOutputExcerptChars))
      .join("\n");
    if (excerpt) {
      lines.push("excerpt:");
      lines.push(excerpt);
    }
  }

  if (params.archivedPath) {
    lines.push(`full_content_saved=${params.archivedPath}`);
  }
  return lines.join("\n");
}

function buildGitSummary(params: {
  message: AgentMessage;
  parsed?: Record<string, unknown>;
  rawText: string;
  config: LeanContextConfig;
  archivedPath?: string;
}): string {
  const parsed = params.parsed ?? {};
  const lines = ["LEAN TOOL RESULT: git"];

  const operation = pickString(parsed, ["operation", "command", "action"]);
  const branch = pickString(parsed, ["branch", "currentBranch"]);
  const commit = pickString(parsed, ["commit", "commitHash", "hash"]);
  const status = pickString(parsed, ["status", "result"]);

  if (operation) lines.push(`operation=${operation}`);
  if (branch) lines.push(`branch=${branch}`);
  if (commit) lines.push(`commit=${commit.slice(0, 16)}...`);
  if (status) lines.push(`status=${status}`);

  // Show changed files if available
  const changed = parsed.changed;
  if (Array.isArray(changed)) {
    lines.push(`changed_files=${changed.length}`);
    for (const file of changed.slice(0, 5)) {
      lines.push(`  ${String(file)}`);
    }
  }

  if (params.archivedPath) {
    lines.push(`full_output_saved=${params.archivedPath}`);
  }
  return lines.join("\n");
}

function buildDbSummary(params: {
  message: AgentMessage;
  parsed?: Record<string, unknown>;
  rawText: string;
  config: LeanContextConfig;
  archivedPath?: string;
}): string {
  const parsed = params.parsed ?? {};
  const lines = ["LEAN TOOL RESULT: database"];

  const query = pickString(parsed, ["query", "sql", "command"]);
  const rowCount = pickNumber(parsed, ["rowCount", "rows", "count", "affectedRows"]);
  const duration = pickNumber(parsed, ["duration", "time", "elapsed"]);
  const error = pickString(parsed, ["error", "errorMessage"]);

  if (query) {
    lines.push(`query=${clipText(query, 100)}`);
  }
  if (rowCount != null) lines.push(`rows=${rowCount}`);
  if (duration != null) lines.push(`duration=${duration}ms`);
  if (error) lines.push(`error=${clipText(error, 200)}`);

  // Show sample results
  const results = parsed.results;
  if (Array.isArray(results) && results.length > 0) {
    lines.push(`sample_results:`);
    for (const row of results.slice(0, 3)) {
      lines.push(`  ${clipText(JSON.stringify(row), 150)}`);
    }
  }

  if (params.archivedPath) {
    lines.push(`full_output_saved=${params.archivedPath}`);
  }
  return lines.join("\n");
}

function buildApiSummary(params: {
  message: AgentMessage;
  parsed?: Record<string, unknown>;
  rawText: string;
  config: LeanContextConfig;
  archivedPath?: string;
}): string {
  const parsed = params.parsed ?? {};
  const lines = ["LEAN TOOL RESULT: api"];

  const method = pickString(parsed, ["method", "httpMethod", "verb"]);
  const url = pickString(parsed, ["url", "endpoint", "uri"]);
  const status = pickNumber(parsed, ["status", "statusCode"]);
  const statusText = pickString(parsed, ["statusText"]);
  const duration = pickNumber(parsed, ["duration", "responseTime"]);

  if (method) lines.push(`${method} ${url ?? ""}`);
  else if (url) lines.push(`url=${url}`);

  if (status != null) {
    lines.push(`status=${status}${statusText ? ` (${statusText})` : ""}`);
  }
  if (duration != null) lines.push(`response_time=${duration}ms`);

  // Show response summary
  const response = parsed.response ?? parsed.data ?? parsed.body;
  if (response && typeof response === "object") {
    const keys = Object.keys(response).slice(0, 5);
    lines.push(`response_keys: ${keys.join(", ")}`);
  }

  if (params.archivedPath) {
    lines.push(`full_output_saved=${params.archivedPath}`);
  }
  return lines.join("\n");
}

function buildTestSummary(params: {
  message: AgentMessage;
  parsed?: Record<string, unknown>;
  rawText: string;
  config: LeanContextConfig;
  archivedPath?: string;
}): string {
  const parsed = params.parsed ?? {};
  const lines = ["LEAN TOOL RESULT: test"];

  const passed = pickNumber(parsed, ["passed", "pass", "success"]) ?? 0;
  const failed = pickNumber(parsed, ["failed", "fail", "failure"]) ?? 0;
  const skipped = pickNumber(parsed, ["skipped", "skip", "pending"]) ?? 0;
  const duration = pickNumber(parsed, ["duration", "time"]);
  const testFile = pickString(parsed, ["testFile", "file", "spec"]);

  lines.push(`results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (duration != null) lines.push(`duration=${duration}ms`);
  if (testFile) lines.push(`file=${testFile}`);

  // Show failed test details
  if (failed > 0) {
    const failures = parsed.failures ?? parsed.failedTests;
    if (Array.isArray(failures)) {
      lines.push("failures:");
      for (const failure of failures.slice(0, 3)) {
        const f =
          failure && typeof failure === "object" ? (failure as Record<string, unknown>) : {};
        const name = pickString(f, ["name", "test", "title", "fullTitle"]);
        const err = pickString(f, ["error", "message", "err"]);
        if (name) lines.push(`  ❌ ${name}`);
        if (err) lines.push(`     ${clipText(err, 120)}`);
      }
    }
  }

  if (params.archivedPath) {
    lines.push(`full_output_saved=${params.archivedPath}`);
  }
  return lines.join("\n");
}

function buildGenericSummary(params: {
  toolName?: string;
  rawText: string;
  config: LeanContextConfig;
  archivedPath?: string;
}): string {
  const tail = takeLastMeaningfulLines(params.rawText, params.config.toolOutputTailLines);
  const lines = [`LEAN TOOL RESULT: ${params.toolName ?? "tool"}`];
  if (tail.length > 0) {
    lines.push("tail_excerpt:");
    lines.push(...tail.map((line) => `  ${clipText(line, params.config.toolOutputExcerptChars)}`));
  }
  lines.push(
    `counts: lines=${params.rawText ? params.rawText.split(/\r?\n/).length : 0}, chars=${params.rawText.length}`,
  );
  if (params.archivedPath) {
    lines.push(`full_output_saved=${params.archivedPath}`);
  }
  return lines.join("\n");
}

function buildSlimmedMessage(
  message: AgentMessage,
  summaryText: string,
  archivedPath?: string,
): AgentMessage {
  const base = {
    ...(message as unknown as Record<string, unknown>),
    content: [{ type: "text", text: summaryText }],
  } as Record<string, unknown>;
  delete base.details;
  if (archivedPath) {
    base.details = {
      leanContext: {
        archivedPath,
      },
    };
  }
  return base as unknown as AgentMessage;
}

function buildSavingsEvent(params: {
  category: keyof SavingsTotals;
  tokensSaved: number;
  label: string;
  detail?: string;
  beforeTokens: number;
  afterTokens: number;
  toolName?: string;
  turnId?: string;
  sessionId?: string;
  sessionKey?: string;
  archivedPath?: string;
}): SavingsEvent {
  return {
    id: buildEventId(),
    turnId: params.turnId ?? "pending",
    ts: Date.now(),
    sessionId: params.sessionId ?? "unknown",
    sessionKey: params.sessionKey,
    category: params.category,
    tokensSaved: Math.max(0, Math.round(params.tokensSaved)),
    label: params.label,
    detail: params.detail,
    beforeTokens: params.beforeTokens,
    afterTokens: params.afterTokens,
    toolName: params.toolName,
    itemKey: `${params.category}:${params.toolName ?? "tool"}:${params.label}`,
    archivedPath: params.archivedPath,
  };
}

export function slimToolResultForPersistence(params: SlimToolResultParams): SlimToolResultResult {
  if (!params.message || params.message.role !== "toolResult") {
    return { changed: false, message: params.message, events: [] };
  }

  const beforeTokens = estimateMessagesTokens([params.message]);
  const attachmentTokens = countAttachmentTokens((params.message as { content?: unknown }).content);
  const { parsed, rawText } = parseCommonPayload(params.message);
  const shouldSlim = beforeTokens >= params.config.maxToolResultTokens || attachmentTokens > 0;
  if (!shouldSlim) {
    return { changed: false, message: params.message, events: [] };
  }

  const archivedPath =
    rawText.length > params.config.toolOutputExcerptChars
      ? maybeArchiveOriginal(params)
      : undefined;
  // Select appropriate summary builder based on tool type
  let summaryText: string;
  if (isExecLike(params.toolName)) {
    summaryText = buildExecSummary({
      message: params.message,
      parsed,
      rawText,
      config: params.config,
      archivedPath,
    });
  } else if (isBrowserLike(params.toolName)) {
    summaryText = buildSearchSummary({
      message: params.message,
      parsed,
      rawText,
      config: params.config,
      archivedPath,
    });
  } else if (isFileLike(params.toolName)) {
    summaryText = buildFileSummary({
      message: params.message,
      parsed,
      rawText,
      config: params.config,
      archivedPath,
    });
  } else if (isGitLike(params.toolName)) {
    summaryText = buildGitSummary({
      message: params.message,
      parsed,
      rawText,
      config: params.config,
      archivedPath,
    });
  } else if (isDbLike(params.toolName)) {
    summaryText = buildDbSummary({
      message: params.message,
      parsed,
      rawText,
      config: params.config,
      archivedPath,
    });
  } else if (isApiLike(params.toolName)) {
    summaryText = buildApiSummary({
      message: params.message,
      parsed,
      rawText,
      config: params.config,
      archivedPath,
    });
  } else if (isTestLike(params.toolName)) {
    summaryText = buildTestSummary({
      message: params.message,
      parsed,
      rawText,
      config: params.config,
      archivedPath,
    });
  } else {
    summaryText = buildGenericSummary({
      toolName: params.toolName,
      rawText,
      config: params.config,
      archivedPath,
    });
  }
  const slimmedMessage = buildSlimmedMessage(params.message, summaryText, archivedPath);
  const afterTokens = estimateMessagesTokens([slimmedMessage]);
  if (afterTokens >= beforeTokens && attachmentTokens <= 0) {
    return { changed: false, message: params.message, events: [] };
  }

  const totalSaved = Math.max(0, beforeTokens - afterTokens);
  const attachmentSaved = Math.min(
    totalSaved,
    Math.max(0, attachmentTokens - estimateTextTokens("[attachment]")),
  );
  const generalSaved = Math.max(0, totalSaved - attachmentSaved);
  const events: SavingsEvent[] = [];
  if (generalSaved > 0) {
    events.push(
      buildSavingsEvent({
        category: "tool_result_slimming",
        tokensSaved: generalSaved,
        label: `${params.toolName ?? "tool"} transcript slimming`,
        detail: clipText(summaryText, 220),
        beforeTokens,
        afterTokens,
        toolName: params.toolName,
        turnId: params.turnId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        archivedPath,
      }),
    );
  }
  if (attachmentSaved > 0) {
    events.push(
      buildSavingsEvent({
        category: "attachment_trimming",
        tokensSaved: attachmentSaved,
        label: `${params.toolName ?? "tool"} attachment trimming`,
        detail: "Non-text attachment blocks were replaced with compact placeholders.",
        beforeTokens,
        afterTokens,
        toolName: params.toolName,
        turnId: params.turnId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        archivedPath,
      }),
    );
  }
  return {
    changed: true,
    message: slimmedMessage,
    events,
  };
}
