import {
  ESTIMATED_SAVINGS_NOTE,
  categoryLabel,
  clipText,
  formatNumber,
  makeSavingsTotals,
  mergeTopContributors,
  sumSavingsTotals,
} from "./helpers.js";
import type {
  SavingsEvent,
  SavingsTotals,
  SessionSavingsSummary,
  TurnSavingsReport,
} from "./types.js";

type LeanContextInteractiveReply = {
  blocks: Array<{ type: "text"; text: string }>;
};

function topCategoryEntries(report: TurnSavingsReport, maxItems: number) {
  return Object.entries(report.categorySavings)
    .filter(([, value]) => value > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, Math.max(1, maxItems));
}

function renderBar(value: number, maxValue: number, width = 16): string {
  if (value <= 0 || maxValue <= 0) {
    return `[${"-".repeat(width)}]`;
  }
  const filled = Math.max(1, Math.min(width, Math.round((value / maxValue) * width)));
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

export function buildCategorySavings(partial: Partial<SavingsTotals>): SavingsTotals {
  const next = makeSavingsTotals();
  for (const [key, value] of Object.entries(partial)) {
    const safe =
      typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
    next[key as keyof SavingsTotals] = safe;
  }
  return next;
}

export function buildExplanation(params: {
  totalSavedTokens: number;
  categorySavings: SavingsTotals;
  topContributors: SavingsEvent[];
}): string {
  const dominantCategories = Object.entries(params.categorySavings)
    .filter(([, value]) => value > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(
      ([category, value]) =>
        `${categoryLabel(category as keyof SavingsTotals)} (${formatNumber(value)})`,
    );
  const topItems = params.topContributors
    .slice(0, 3)
    .map((item) => `${clipText(item.label, 80)} (${formatNumber(item.tokensSaved)})`);
  if (params.totalSavedTokens <= 0) {
    return "No estimated context savings were detected for this turn.";
  }
  if (dominantCategories.length === 0) {
    return `Estimated context savings: ${formatNumber(params.totalSavedTokens)} tokens.`;
  }
  const parts = [
    `Estimated context savings: ${formatNumber(params.totalSavedTokens)} tokens.`,
    `Largest categories: ${dominantCategories.join(", ")}.`,
  ];
  if (topItems.length > 0) {
    parts.push(`Largest items: ${topItems.join(", ")}.`);
  }
  return parts.join(" ");
}

export function buildTurnSavingsReport(params: {
  turnId: string;
  createdAt: string;
  sessionId: string;
  sessionKey?: string;
  activityLabel?: string;
  activityDetail?: string;
  statusNotices?: string[];
  rawSnapshot: TurnSavingsReport["rawSnapshot"];
  assembledSnapshot: TurnSavingsReport["assembledSnapshot"];
  compactedSnapshot?: TurnSavingsReport["compactedSnapshot"];
  categorySavings: SavingsTotals;
  topContributors: SavingsEvent[];
}): TurnSavingsReport {
  const categorySavings = buildCategorySavings(params.categorySavings);
  const totalSavedTokens = sumSavingsTotals(categorySavings);
  const topContributors = mergeTopContributors([], params.topContributors, 8);
  return {
    version: 1,
    turnId: params.turnId,
    createdAt: params.createdAt,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    activityLabel: params.activityLabel,
    activityDetail: params.activityDetail,
    ...(params.statusNotices?.length ? { statusNotices: params.statusNotices } : {}),
    note: ESTIMATED_SAVINGS_NOTE,
    rawSnapshot: params.rawSnapshot,
    assembledSnapshot: params.assembledSnapshot,
    ...(params.compactedSnapshot ? { compactedSnapshot: params.compactedSnapshot } : {}),
    totalSavedTokens,
    categorySavings,
    topContributors,
    explanation: buildExplanation({
      totalSavedTokens,
      categorySavings,
      topContributors,
    }),
  };
}

export function updateSessionSummary(params: {
  current: SessionSavingsSummary;
  report: TurnSavingsReport;
  maxItems: number;
}): SessionSavingsSummary {
  const categoryTotals = { ...params.current.categoryTotals };
  for (const [category, value] of Object.entries(params.report.categorySavings)) {
    categoryTotals[category as keyof SavingsTotals] =
      (categoryTotals[category as keyof SavingsTotals] ?? 0) + Math.max(0, Math.round(value));
  }
  return {
    ...params.current,
    updatedAt: params.report.createdAt,
    statusNotices: params.report.statusNotices,
    turnCount: params.current.turnCount + 1,
    totalSavedTokens: params.current.totalSavedTokens + params.report.totalSavedTokens,
    categoryTotals,
    topContributors: mergeTopContributors(
      params.current.topContributors,
      params.report.topContributors,
      params.maxItems,
    ),
    lastReport: params.report,
  };
}

export function formatTurnReportForCommand(report: TurnSavingsReport): string {
  const lines = [
    "Lean Context Report",
    `Turn: ${report.turnId}`,
    ...(report.activityLabel ? [`Activity: ${report.activityLabel}`] : []),
    ...(report.statusNotices?.map((notice) => `Status: ${notice}`) ?? []),
    `Estimated raw context: ${formatNumber(report.rawSnapshot.estimatedTokens)} tokens`,
    `Estimated assembled context: ${formatNumber(report.assembledSnapshot.estimatedTokens)} tokens`,
  ];
  if (report.compactedSnapshot) {
    lines.push(
      `Estimated compacted context: ${formatNumber(report.compactedSnapshot.estimatedTokens)} tokens`,
    );
  }
  lines.push(`Estimated saved: ${formatNumber(report.totalSavedTokens)} tokens`);
  lines.push("");
  lines.push("By category:");
  for (const [category, value] of Object.entries(report.categorySavings)) {
    lines.push(`- ${category}: ${formatNumber(value)}`);
  }
  if (report.topContributors.length > 0) {
    lines.push("");
    lines.push("Top contributors:");
    for (const event of report.topContributors) {
      lines.push(`- ${clipText(event.label, 100)}: ${formatNumber(event.tokensSaved)}`);
    }
  }
  lines.push("");
  lines.push(report.explanation);
  lines.push(report.note);
  return lines.join("\n");
}

export function formatSessionSummaryForCommand(summary: SessionSavingsSummary): string {
  const lines = [
    "Lean Context Session Summary",
    ...(summary.statusNotices?.map((notice) => `Status: ${notice}`) ?? []),
    `Turns reported: ${formatNumber(summary.turnCount)}`,
    `Estimated saved tokens: ${formatNumber(summary.totalSavedTokens)}`,
    `Updated: ${summary.updatedAt}`,
    "",
    "Category totals:",
  ];
  for (const [category, value] of Object.entries(summary.categoryTotals)) {
    lines.push(`- ${category}: ${formatNumber(value)}`);
  }
  if (summary.topContributors.length > 0) {
    lines.push("");
    lines.push("Largest contributors:");
    for (const event of summary.topContributors) {
      lines.push(`- ${clipText(event.label, 100)}: ${formatNumber(event.tokensSaved)}`);
    }
  }
  lines.push("");
  lines.push(ESTIMATED_SAVINGS_NOTE);
  return lines.join("\n");
}

export function formatTurnReportForFooter(
  report: TurnSavingsReport,
  options: { maxCategories?: number } = {},
): string | null {
  if (report.totalSavedTokens <= 0 && !report.statusNotices?.length) {
    return null;
  }
  const topCategories = topCategoryEntries(report, options.maxCategories ?? 2).map(
    ([category, value]) =>
      `${categoryLabel(category as keyof SavingsTotals)} ${formatNumber(value)}`,
  );
  return [
    `[Lean Context]${report.activityLabel ? ` ${report.activityLabel}.` : ""}${report.totalSavedTokens > 0 ? ` Estimated saved ${formatNumber(report.totalSavedTokens)} tokens this turn.` : ""}`,
    ...(report.statusNotices?.slice(0, 1) ?? []),
    topCategories.length > 0 ? `Top: ${topCategories.join(", ")}.` : undefined,
    "Use /lean-context for details.",
  ]
    .filter(Boolean)
    .join(" ");
}

export function formatTurnReportVisualization(
  report: TurnSavingsReport,
  options: { maxCategories?: number; maxContributors?: number } = {},
): string {
  const maxCategories = Math.max(1, options.maxCategories ?? 4);
  const maxContributors = Math.max(1, options.maxContributors ?? 3);
  const topCategories = topCategoryEntries(report, maxCategories);
  const maxCategoryValue = Math.max(...topCategories.map(([, value]) => value), 0);
  const lines = [
    "Lean Context Board",
    ...(report.activityLabel ? [`Activity: ${report.activityLabel}`] : []),
    ...(report.statusNotices?.map((notice) => `Status: ${notice}`) ?? []),
    `Saved this turn: ${formatNumber(report.totalSavedTokens)} tokens`,
    `Raw -> Assembled: ${formatNumber(report.rawSnapshot.estimatedTokens)} -> ${formatNumber(report.assembledSnapshot.estimatedTokens)}`,
  ];
  if (report.compactedSnapshot) {
    lines.push(`Compacted snapshot: ${formatNumber(report.compactedSnapshot.estimatedTokens)}`);
  }
  if (topCategories.length > 0) {
    lines.push("");
    lines.push("Category breakdown:");
    for (const [category, value] of topCategories) {
      lines.push(
        `- ${clipText(categoryLabel(category as keyof SavingsTotals), 28)} ${renderBar(value, maxCategoryValue)} ${formatNumber(value)}`,
      );
    }
  }
  if (report.topContributors.length > 0) {
    lines.push("");
    lines.push("Top contributors:");
    for (const event of report.topContributors.slice(0, maxContributors)) {
      lines.push(`- ${clipText(event.label, 72)} (${formatNumber(event.tokensSaved)})`);
    }
  }
  return lines.join("\n");
}

export function buildTurnReportInteractiveReply(
  report: TurnSavingsReport,
  options: { maxCategories?: number; maxContributors?: number } = {},
): LeanContextInteractiveReply | undefined {
  if (report.totalSavedTokens <= 0 && !report.statusNotices?.length) {
    return undefined;
  }
  const maxCategories = Math.max(1, options.maxCategories ?? 4);
  const maxContributors = Math.max(1, options.maxContributors ?? 3);
  const topCategories = topCategoryEntries(report, maxCategories);
  const maxCategoryValue = Math.max(...topCategories.map(([, value]) => value), 0);
  const blocks: LeanContextInteractiveReply["blocks"] = [
    {
      type: "text",
      text: [
        "Lean Context Board",
        report.activityLabel ? `Activity: ${report.activityLabel}` : undefined,
        ...(report.statusNotices ?? []).map((notice) => `Status: ${notice}`),
        `Saved this turn: ${formatNumber(report.totalSavedTokens)} tokens`,
        `Raw -> Assembled: ${formatNumber(report.rawSnapshot.estimatedTokens)} -> ${formatNumber(report.assembledSnapshot.estimatedTokens)}`,
        report.compactedSnapshot
          ? `Compacted snapshot: ${formatNumber(report.compactedSnapshot.estimatedTokens)}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
  if (topCategories.length > 0) {
    blocks.push({
      type: "text",
      text: [
        "Category breakdown",
        ...topCategories.map(
          ([category, value]) =>
            `${clipText(categoryLabel(category as keyof SavingsTotals), 28)} ${renderBar(value, maxCategoryValue)} ${formatNumber(value)}`,
        ),
      ].join("\n"),
    });
  }
  if (report.topContributors.length > 0) {
    blocks.push({
      type: "text",
      text: [
        "Top contributors",
        ...report.topContributors
          .slice(0, maxContributors)
          .map((event) => `${clipText(event.label, 72)} (${formatNumber(event.tokensSaved)})`),
      ].join("\n"),
    });
  }
  blocks.push({
    type: "text",
    text: ESTIMATED_SAVINGS_NOTE,
  });
  return { blocks };
}
