import { describe, expect, it } from "vitest";
import { checkCommandScope, hasExplicitSessionIdentity } from "./src/command-scope.js";

describe("lean-context command scope", () => {
  it("rejects unauthorized senders", () => {
    const decision = checkCommandScope({
      isAuthorizedSender: false,
      allowCrossSessionCommands: true,
      hasExplicitSessionArgs: true,
    });
    expect(decision.allowed).toBe(false);
  });

  it("rejects explicit cross-session arguments by default", () => {
    const decision = checkCommandScope({
      isAuthorizedSender: true,
      allowCrossSessionCommands: false,
      hasExplicitSessionArgs: true,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("Cross-session");
    }
  });

  it("allows an authorized sender to use cross-session arguments when enabled", () => {
    expect(
      checkCommandScope({
        isAuthorizedSender: true,
        allowCrossSessionCommands: true,
        hasExplicitSessionArgs: true,
      }).allowed,
    ).toBe(true);
  });

  it("detects explicit session identity per command shape", () => {
    expect(hasExplicitSessionIdentity("summary", ["summary"])).toBe(false);
    expect(hasExplicitSessionIdentity("summary", ["summary", "session-1"])).toBe(true);
    expect(hasExplicitSessionIdentity("latest", ["latest"])).toBe(false);
    expect(hasExplicitSessionIdentity("board", ["board", "session-1"])).toBe(true);
    expect(hasExplicitSessionIdentity("restore", ["restore", "--", "query"])).toBe(false);
    expect(hasExplicitSessionIdentity("restore", ["restore", "session-1", "--", "query"])).toBe(
      true,
    );
    expect(hasExplicitSessionIdentity("help", ["help"])).toBe(false);
    expect(hasExplicitSessionIdentity("session-1", ["session-1"])).toBe(true);
  });
});
