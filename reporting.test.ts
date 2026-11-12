import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildTurnReportInteractiveReply,
  buildTurnSavingsReport,
  formatTurnReportVisualization,
  updateSessionSummary,
} from "./src/reporting.js";
import {
  appendTurnReport,
  createEmptySummary,
  ensurePluginStateDirs,
  readLatestTurnReport,
} from "./src/store.js";

let tempRoot = "";

describe("lean-context reporting", () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lean-report-"));
  });

  afterEach(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("computes category attribution and persists turn reports", async () => {
    const report = buildTurnSavingsReport({
      turnId: "turn-1",
      createdAt: new Date().toISOString(),
      sessionId: "session-1",
      sessionKey: "agent:main:test",
      activityLabel: "Scanned text collection",
      rawSnapshot: {
        kind: "raw",
        estimatedTokens: 2400,
        messageCount: 18,
      },
      assembledSnapshot: {
        kind: "assembled",
        estimatedTokens: 1100,
        messageCount: 6,
      },
      categorySavings: {
        tool_result_slimming: 220,
        history_compaction: 700,
        history_exclusion: 380,
        tool_schema_avoidance: 0,
        bootstrap_trim: 0,
        attachment_trimming: 40,
      },
      topContributors: [
        {
          id: "a",
          turnId: "turn-1",
          ts: Date.now(),
          sessionId: "session-1",
          sessionKey: "agent:main:test",
          category: "history_compaction",
          tokensSaved: 700,
          label: "Structured session_state replaced compacted older history",
        },
      ],
    });

    expect(report.totalSavedTokens).toBe(1340);
    expect(report.explanation).toContain("Estimated context savings");

    const pluginStateDir = await ensurePluginStateDirs(tempRoot);
    await appendTurnReport({ pluginStateDir, report });
    const loaded = await readLatestTurnReport({
      pluginStateDir,
      sessionId: "session-1",
      sessionKey: "agent:main:test",
    });

    expect(loaded?.turnId).toBe("turn-1");
    expect(loaded?.categorySavings.history_compaction).toBe(700);

    const summary = updateSessionSummary({
      current: createEmptySummary("session-1", "agent:main:test"),
      report,
      maxItems: 5,
    });
    expect(summary.totalSavedTokens).toBe(1340);
    expect(summary.categoryTotals.tool_result_slimming).toBe(220);

    const board = formatTurnReportVisualization(report);
    expect(board).toContain("Lean Context Board");
    expect(board).toContain("Activity: Scanned text collection");
    expect(board).toContain("Saved this turn: 1,340 tokens");
    expect(board).toContain("structured history compac");
    expect(board).toContain("[################]");

    const interactive = buildTurnReportInteractiveReply(report);
    expect(interactive?.blocks.length).toBeGreaterThan(1);
    expect(interactive?.blocks[0]?.text).toContain("Activity: Scanned text collection");
    expect(interactive?.blocks[0]?.text).toContain("Saved this turn: 1,340 tokens");
  });
});
