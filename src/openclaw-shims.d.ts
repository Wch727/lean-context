/**
 * OpenClaw 2026.11.x publishes `plugin-sdk/session-transcript-runtime` without
 * a `types` export condition, so TypeScript cannot resolve its declarations.
 * This shim mirrors the published runtime surface used by lean-context.
 */
declare module "openclaw/plugin-sdk/session-transcript-runtime" {
  import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";

  export type SessionTranscriptMessageEntry = {
    entryId: string;
    parentId: string | null;
    seq: number;
    message: AgentMessage;
    role: AgentMessage["role"];
    createdAt?: string;
    idempotencyKey?: string;
    supersedesEntryId?: string;
  };

  export function readVisibleSessionTranscriptMessageEntries(params: {
    agentId?: string;
    env?: NodeJS.ProcessEnv;
    hydrateSkillPromptRefs?: boolean;
    sessionId: string;
    sessionKey: string;
    storePath?: string;
    threadId?: string | number;
  }): Promise<SessionTranscriptMessageEntry[]>;
}
