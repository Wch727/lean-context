import {
  clipText,
  createEmptyStructuredSessionState,
  extractFilePaths,
  extractUrls,
  flattenMessageText,
  normalizeWhitespace,
  uniqueStrings,
} from "./helpers.js";
import type { AgentMessage, StructuredSessionState } from "./types.js";

type MessageEntry = {
  role: string;
  line: string;
  messageText: string;
};

// English patterns
const DONE_PATTERNS = [
  /\b(done|fixed|implemented|added|updated|completed|shipped|finished|created|saved|wrote|generated|resolved|accomplished|merged|committed|pushed|deployed)\b/i,
  /\b(has been|have been)\s+(done|fixed|implemented|added|updated|completed|created|saved|resolved)\b/i,
  /\b(finished|completed)\s+(implementing|adding|updating|fixing|creating|writing)\b/i,
];
const TODO_PATTERNS = [
  /\b(todo|next|follow[- ]up|pending|remaining|left to do|need to|still need|should do|plan to|going to|will)\b/i,
  /\b(remaining|outstanding|open)\s+(tasks?|items?|issues?|work)\b/i,
];
const CONSTRAINT_PATTERNS = [
  /\b(must|must not|should not|cannot|can't|avoid|required|need to preserve|keep\b|do not|don't|never|always|only|ensure|make sure)\b/i,
  /\b(important|critical|essential|mandatory|necessary)\s+(to|that|for)\b/i,
];
const DECISION_PATTERNS = [
  /\b(decided|decision|go with|switch to|keep using|chosen|plan is|we'll use|let's use|opted for|selected|prefer)\b/i,
  /\b(agreed|consensus|concluded)\s+(to|on|that)\b/i,
];
const BLOCKER_PATTERNS = [
  /\b(blocked|blocker|failed|failure|unable to|timeout|forbidden|permission denied|not found|no such|missing|traceback|exception|enoent|eacces)\b/i,
  /\b(error|fail|crash|broken|bug|issue|problem|wrong|invalid)\b[\s\w]{0,30}(?:occurred|found|detected|happened|prevented)/i,
  /\berror:\b/i,
  /\bexit[ _-]?code[:= ]*[1-9]\d*\b/i,
  /\b(doesn't|does not|won't|will not|can't|cannot)\s+(work|compile|run|execute|start)\b/i,
];
const IMPORTANT_OUTPUT_PATTERNS = [
  /\b(saved|wrote|created|generated|updated|produced|output|artifact|report|summary|exported|built|compiled|deployed)\b/i,
  /\b(output|result|return|value|file|path|location)\s+(is|was|:\s*)["']?\S+/i,
  /\b(error|warning|failed|failure|timeout|forbidden|not found)\b/i,
  /\bexit[ _-]?code[:= ]*[1-9]\d*\b/i,
];

// Chinese patterns - 中文模式
const DONE_PATTERNS_CN = [
  /(?:已经|已|完成|修好|实现|添加|更新|写完|保存|创建|生成|解决|合并|提交|部署)了?/,
  /(?:fix|done|complete)[了d]/i,
];
const TODO_PATTERNS_CN = [
  /(?:接下来|下一步|还需要|还要|待办|待完成|未完成|剩余|遗留|计划|准备|将要)/,
];
const CONSTRAINT_PATTERNS_CN = [
  /(?:必须|务必|一定|不能|不可|不要|避免|禁止|需要保持|注意|确保|保证)/,
];
const DECISION_PATTERNS_CN = [/(?:决定|选定|选择|采用|使用|继续|保持|改为|换成|方案是|策略是)/];
const BLOCKER_PATTERNS_CN = [
  /(?:阻塞|阻塞了|失败|出错|报错|错误|异常|找不到|缺失|无法|不能|超时|禁止|无权限)/,
];
const IMPORTANT_OUTPUT_PATTERNS_CN = [
  /(?:已保存|已写入|已创建|已生成|输出|结果|产物|文件|路径|位置)/,
];

const IGNORE_BLOCKER_PATTERNS = [
  /\berror budget\b/i,
  /\berror handling\b/i,
  /\berror message\b/i,
  /(?:没有|无)\s*(?:错误|问题|异常)/, // 中文: 没有错误
  /error[\s\w]*(?:free|handled|expected)/i,
];
const IGNORE_IMPORTANT_OUTPUT_PATTERNS = [
  /^\s*exit[ _-]?code[:= ]*0\s*$/i,
  /^\s*completed successfully\s*$/i,
  /^\s*ok\s*$/i,
  /(?:成功|完成|正常|ok)\s*$/i, // 中文成功标记
];

function summarizeLine(line: string): string {
  return clipText(normalizeWhitespace(line.replace(/^[*\-•]\s*/, "")), 220);
}

function collectEntries(messages: AgentMessage[]): MessageEntry[] {
  const entries: MessageEntry[] = [];
  for (const message of messages) {
    const role = typeof message?.role === "string" ? message.role : "";
    const messageText = normalizeWhitespace(flattenMessageText(message));
    if (!messageText) {
      continue;
    }
    const lines = messageText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      entries.push({ role, line: messageText, messageText });
      continue;
    }
    for (const line of lines) {
      entries.push({ role, line, messageText });
    }
  }
  return entries;
}

function latestUserGoal(messages: AgentMessage[], previous?: StructuredSessionState): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") {
      continue;
    }
    const text = clipText(normalizeWhitespace(flattenMessageText(message)), 220);
    if (text) {
      return text;
    }
  }
  return previous?.goal ?? "";
}

function collectRoleAware(
  entries: MessageEntry[],
  predicate: (entry: MessageEntry) => boolean,
  maxItems: number,
): string[] {
  return uniqueStrings(
    entries.filter(predicate).map((entry) => summarizeLine(entry.line)),
    maxItems,
  );
}

function lineMatchesAny(line: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(line));
}

function collectDone(entries: MessageEntry[]): string[] {
  return collectRoleAware(
    entries,
    (entry) =>
      (entry.role === "assistant" || entry.role === "toolResult") &&
      (lineMatchesAny(entry.line, DONE_PATTERNS) || lineMatchesAny(entry.line, DONE_PATTERNS_CN)),
    8,
  );
}

function collectTodos(entries: MessageEntry[]): string[] {
  return collectRoleAware(
    entries,
    (entry) =>
      (entry.role === "user" || entry.role === "assistant") &&
      (lineMatchesAny(entry.line, TODO_PATTERNS) || lineMatchesAny(entry.line, TODO_PATTERNS_CN)),
    8,
  );
}

function collectConstraints(entries: MessageEntry[]): string[] {
  return collectRoleAware(
    entries,
    (entry) =>
      (entry.role === "user" || entry.role === "assistant") &&
      (lineMatchesAny(entry.line, CONSTRAINT_PATTERNS) ||
        lineMatchesAny(entry.line, CONSTRAINT_PATTERNS_CN)),
    8,
  );
}

function collectDecisions(entries: MessageEntry[]): string[] {
  return collectRoleAware(
    entries,
    (entry) =>
      (entry.role === "assistant" || entry.role === "user") &&
      (lineMatchesAny(entry.line, DECISION_PATTERNS) ||
        lineMatchesAny(entry.line, DECISION_PATTERNS_CN)),
    8,
  );
}

function collectBlockers(entries: MessageEntry[]): string[] {
  return collectRoleAware(
    entries,
    (entry) =>
      (entry.role === "assistant" || entry.role === "toolResult") &&
      !lineMatchesAny(entry.line, IGNORE_BLOCKER_PATTERNS) &&
      (lineMatchesAny(entry.line, BLOCKER_PATTERNS) ||
        lineMatchesAny(entry.line, BLOCKER_PATTERNS_CN)),
    8,
  );
}

function collectImportantOutputs(messages: AgentMessage[]): string[] {
  const outputs: string[] = [];
  for (const message of messages) {
    const text = normalizeWhitespace(flattenMessageText(message));
    if (!text) {
      continue;
    }
    outputs.push(...extractUrls(text, 3));
    outputs.push(...extractFilePaths(text, 4));
    if (message.role !== "toolResult") {
      continue;
    }
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      if (lineMatchesAny(line, IGNORE_IMPORTANT_OUTPUT_PATTERNS)) {
        continue;
      }
      if (
        !lineMatchesAny(line, IMPORTANT_OUTPUT_PATTERNS) &&
        !lineMatchesAny(line, IMPORTANT_OUTPUT_PATTERNS_CN)
      ) {
        continue;
      }
      outputs.push(summarizeLine(line));
    }
  }
  return uniqueStrings(outputs, 8);
}

function collectChangedFiles(
  messages: AgentMessage[],
  previous?: StructuredSessionState,
): string[] {
  const found: string[] = [];
  for (const message of messages) {
    const text = flattenMessageText(message);
    if (!text) {
      continue;
    }
    found.push(...extractFilePaths(text, 24));
  }
  return uniqueStrings([...(previous?.changed_files ?? []), ...found], 12);
}

export function buildStructuredSessionState(params: {
  messages: AgentMessage[];
  previous?: StructuredSessionState;
}): StructuredSessionState {
  const previous = params.previous;
  const entries = collectEntries(params.messages);
  const state = createEmptyStructuredSessionState();
  state.goal = latestUserGoal(params.messages, previous);
  state.done = uniqueStrings([...(previous?.done ?? []), ...collectDone(entries)], 8);
  state.open_todos = uniqueStrings([...(previous?.open_todos ?? []), ...collectTodos(entries)], 8);
  state.changed_files = collectChangedFiles(params.messages, previous);
  state.important_outputs = uniqueStrings(
    [...(previous?.important_outputs ?? []), ...collectImportantOutputs(params.messages)],
    8,
  );
  state.constraints = uniqueStrings(
    [...(previous?.constraints ?? []), ...collectConstraints(entries)],
    8,
  );
  state.decisions = uniqueStrings(
    [...(previous?.decisions ?? []), ...collectDecisions(entries)],
    8,
  );
  state.blockers = uniqueStrings([...(previous?.blockers ?? []), ...collectBlockers(entries)], 8);
  return state;
}
