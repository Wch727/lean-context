import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  buildPluginStateDir,
  createEmptyTokenEstimatorCalibration,
  createEmptyStructuredSessionState,
  makeSavingsTotals,
  nowIso,
  sessionStorageKey,
} from "./helpers.js";
import {
  createEmptyProceduralMemoryDigest,
  createEmptySessionMemoryDigest,
} from "./session-memory.js";
import type {
  ArchivedHistorySegment,
  SavingsEvent,
  SessionSavingsSummary,
  StoredSessionData,
  TurnSavingsReport,
} from "./types.js";

const SECURE_FILE_MODE = 0o600;
const SECURE_DIR_MODE = 0o700;

function hardenModeSync(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // Best effort: chmod is a no-op or unsupported on some platforms (e.g. Windows).
  }
}

async function hardenMode(target: string, mode: number): Promise<void> {
  await fsp.chmod(target, mode).catch(() => undefined);
}

function ensureSecureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: SECURE_DIR_MODE });
  hardenModeSync(dir, SECURE_DIR_MODE);
}

async function ensureSecureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true, mode: SECURE_DIR_MODE });
  await hardenMode(dir, SECURE_DIR_MODE);
}

function resolveSessionsDir(pluginStateDir: string): string {
  return path.join(pluginStateDir, "sessions");
}

function resolveLedgersDir(pluginStateDir: string): string {
  return path.join(pluginStateDir, "ledger");
}

function resolveSessionLedgerDir(pluginStateDir: string): string {
  return path.join(resolveLedgersDir(pluginStateDir), "sessions");
}

function resolveArchivesDir(pluginStateDir: string): string {
  return path.join(pluginStateDir, "archives");
}

function resolvePendingDir(pluginStateDir: string): string {
  return path.join(pluginStateDir, "pending");
}

export function ensurePluginStateDirsSync(stateRootDir: string): string {
  const pluginStateDir = buildPluginStateDir(stateRootDir);
  ensureSecureDirSync(resolveSessionsDir(pluginStateDir));
  ensureSecureDirSync(resolveSessionLedgerDir(pluginStateDir));
  ensureSecureDirSync(resolveArchivesDir(pluginStateDir));
  ensureSecureDirSync(resolvePendingDir(pluginStateDir));
  return pluginStateDir;
}

export async function ensurePluginStateDirs(stateRootDir: string): Promise<string> {
  const pluginStateDir = buildPluginStateDir(stateRootDir);
  await ensureSecureDir(resolveSessionsDir(pluginStateDir));
  await ensureSecureDir(resolveSessionLedgerDir(pluginStateDir));
  await ensureSecureDir(resolveArchivesDir(pluginStateDir));
  await ensureSecureDir(resolvePendingDir(pluginStateDir));
  return pluginStateDir;
}

function sessionFilePath(pluginStateDir: string, sessionId: string, sessionKey?: string): string {
  return path.join(
    resolveSessionsDir(pluginStateDir),
    `${sessionStorageKey(sessionId, sessionKey)}.json`,
  );
}

function sessionLedgerPath(pluginStateDir: string, sessionId: string, sessionKey?: string): string {
  return path.join(
    resolveSessionLedgerDir(pluginStateDir),
    `${sessionStorageKey(sessionId, sessionKey)}.jsonl`,
  );
}

function globalLedgerPath(pluginStateDir: string): string {
  return path.join(resolveLedgersDir(pluginStateDir), "turns.jsonl");
}

function sessionArchivePath(
  pluginStateDir: string,
  sessionId: string,
  sessionKey?: string,
): string {
  return path.join(
    resolveArchivesDir(pluginStateDir),
    `${sessionStorageKey(sessionId, sessionKey)}.jsonl`,
  );
}

function pendingSlimmingPath(pluginStateDir: string, sessionIdentity: string): string {
  return path.join(
    resolvePendingDir(pluginStateDir),
    `${sessionStorageKey(sessionIdentity)}.jsonl`,
  );
}

export function createEmptySummary(sessionId: string, sessionKey?: string): SessionSavingsSummary {
  return {
    version: 1,
    sessionId,
    sessionKey,
    turnCount: 0,
    updatedAt: nowIso(),
    totalSavedTokens: 0,
    categoryTotals: makeSavingsTotals(),
    topContributors: [],
  };
}

export function createEmptySessionData(sessionId: string, sessionKey?: string): StoredSessionData {
  return {
    version: 1,
    sessionId,
    sessionKey,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    compactedThroughMessageCount: 0,
    compactedPrefixSanitizedTokens: 0,
    compactedPrefixAttachmentTrimmedTokens: 0,
    consecutiveAutoCompactFailures: 0,
    state: createEmptyStructuredSessionState(),
    fallbackState: createEmptyStructuredSessionState(),
    fallbackStateActive: false,
    fallbackStateRecoveryTurns: 0,
    sessionMemory: createEmptySessionMemoryDigest(),
    proceduralMemory: createEmptyProceduralMemoryDigest(),
    tokenEstimatorCalibration: createEmptyTokenEstimatorCalibration(),
    persistentCategoryTotals: makeSavingsTotals(),
    persistentTopContributors: [],
    summary: createEmptySummary(sessionId, sessionKey),
  };
}

export async function loadSessionData(params: {
  pluginStateDir: string;
  sessionId: string;
  sessionKey?: string;
}): Promise<StoredSessionData> {
  const file = sessionFilePath(params.pluginStateDir, params.sessionId, params.sessionKey);
  try {
    const raw = await fsp.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as StoredSessionData;
    const defaults = createEmptySessionData(params.sessionId, params.sessionKey);
    return {
      ...defaults,
      ...parsed,
      state: {
        ...defaults.state,
        ...(parsed.state ?? {}),
      },
      fallbackState: {
        ...defaults.fallbackState,
        ...(parsed.fallbackState ?? {}),
      },
      sessionMemory: {
        ...defaults.sessionMemory,
        ...(parsed.sessionMemory ?? {}),
      },
      proceduralMemory: {
        ...defaults.proceduralMemory,
        ...(parsed.proceduralMemory ?? {}),
      },
      tokenEstimatorCalibration: {
        ...defaults.tokenEstimatorCalibration,
        ...(parsed.tokenEstimatorCalibration ?? {}),
      },
      persistentCategoryTotals: {
        ...defaults.persistentCategoryTotals,
        ...(parsed.persistentCategoryTotals ?? {}),
      },
      summary: {
        ...defaults.summary,
        ...(parsed.summary ?? {}),
      },
      sessionId: params.sessionId,
      sessionKey: params.sessionKey ?? parsed.sessionKey,
    };
  } catch {
    return createEmptySessionData(params.sessionId, params.sessionKey);
  }
}

export async function saveSessionData(params: {
  pluginStateDir: string;
  sessionData: StoredSessionData;
}): Promise<void> {
  const file = sessionFilePath(
    params.pluginStateDir,
    params.sessionData.sessionId,
    params.sessionData.sessionKey,
  );
  const next = {
    ...params.sessionData,
    updatedAt: nowIso(),
  };
  await fsp.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: SECURE_FILE_MODE,
  });
  await hardenMode(file, SECURE_FILE_MODE);
}

export async function appendTurnReport(params: {
  pluginStateDir: string;
  report: TurnSavingsReport;
}): Promise<void> {
  const payload = `${JSON.stringify(params.report)}\n`;
  const globalPath = globalLedgerPath(params.pluginStateDir);
  const sessionPath = sessionLedgerPath(
    params.pluginStateDir,
    params.report.sessionId,
    params.report.sessionKey,
  );
  await fsp.appendFile(globalPath, payload, { encoding: "utf8", mode: SECURE_FILE_MODE });
  await fsp.appendFile(sessionPath, payload, { encoding: "utf8", mode: SECURE_FILE_MODE });
  await hardenMode(globalPath, SECURE_FILE_MODE);
  await hardenMode(sessionPath, SECURE_FILE_MODE);
}

export async function appendArchivedHistorySegment(params: {
  pluginStateDir: string;
  segment: ArchivedHistorySegment;
}): Promise<void> {
  const payload = `${JSON.stringify(params.segment)}\n`;
  const archivePath = sessionArchivePath(
    params.pluginStateDir,
    params.segment.sessionId,
    params.segment.sessionKey,
  );
  await fsp.appendFile(archivePath, payload, { encoding: "utf8", mode: SECURE_FILE_MODE });
  await hardenMode(archivePath, SECURE_FILE_MODE);
}

export function appendPendingSlimmingEventsSync(params: {
  stateRootDir: string;
  sessionIdentity: string;
  events: SavingsEvent[];
}): void {
  if (!params.sessionIdentity.trim() || params.events.length === 0) {
    return;
  }
  const pluginStateDir = ensurePluginStateDirsSync(params.stateRootDir);
  const targetPath = pendingSlimmingPath(pluginStateDir, params.sessionIdentity.trim());
  const payload = `${params.events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  // Append directly — each call's events are independent.
  // Crash after append = events survive in the file (will be consumed next afterTurn).
  // Crash during consume = events either already read (deleted) or still in pending file.
  fs.appendFileSync(targetPath, payload, { encoding: "utf8", mode: SECURE_FILE_MODE });
  hardenModeSync(targetPath, SECURE_FILE_MODE);
}

export async function consumePendingSlimmingEvents(params: {
  pluginStateDir: string;
  sessionIdentity: string;
}): Promise<SavingsEvent[]> {
  const file = pendingSlimmingPath(params.pluginStateDir, params.sessionIdentity.trim());
  const stagingPath = `${file}.staging`;

  // Step 1 — atomic rename: take ownership of the pending file.
  // If it doesn't exist that's fine (empty session).
  // If rename fails (e.g. already renamed by a concurrent consume) that's also fine.
  try {
    await fsp.rename(file, stagingPath);
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return []; // No pending file — nothing to consume.
    }
    // Another consumer already took it, or other error — treat as nothing to consume.
    return [];
  }

  // Step 2 — read and parse the staging file.
  try {
    const raw = await fsp.readFile(stagingPath, "utf8");
    await fsp.unlink(stagingPath).catch(() => {});
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as SavingsEvent];
        } catch {
          return [];
        }
      });
  } catch {
    // File disappeared between rename and read (highly unlikely but safe to treat as empty).
    await fsp.unlink(stagingPath).catch(() => {});
    return [];
  }
}

function parseJsonlLast<T>(text: string): T | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines.at(-1);
  if (!last) {
    return null;
  }
  try {
    return JSON.parse(last) as T;
  } catch {
    return null;
  }
}

export async function readLatestTurnReport(params: {
  pluginStateDir: string;
  sessionId?: string;
  sessionKey?: string;
}): Promise<TurnSavingsReport | null> {
  const file =
    params.sessionId != null
      ? sessionLedgerPath(params.pluginStateDir, params.sessionId, params.sessionKey)
      : globalLedgerPath(params.pluginStateDir);
  try {
    const raw = await fsp.readFile(file, "utf8");
    return parseJsonlLast<TurnSavingsReport>(raw);
  } catch {
    return null;
  }
}

export async function readSessionSummary(params: {
  pluginStateDir: string;
  sessionId: string;
  sessionKey?: string;
}): Promise<SessionSavingsSummary | null> {
  const sessionData = await loadSessionData(params);
  return sessionData.summary ?? null;
}

export async function readArchivedHistorySegments(params: {
  pluginStateDir: string;
  sessionId: string;
  sessionKey?: string;
}): Promise<ArchivedHistorySegment[]> {
  const file = sessionArchivePath(params.pluginStateDir, params.sessionId, params.sessionKey);
  try {
    const raw = await fsp.readFile(file, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as ArchivedHistorySegment];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}
