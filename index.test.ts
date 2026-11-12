import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("lean-context plugin entry", () => {
  it("registers the context engine, command, and hooks with the latest plugin API", () => {
    const registerContextEngine = vi.fn();
    const registerCommand = vi.fn();
    const on = vi.fn();

    plugin.register({
      pluginConfig: {},
      config: {},
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      runtime: {
        state: {
          resolveStateDir: () => "/tmp/lean-context-test",
        },
      },
      registerContextEngine,
      registerCommand,
      on,
    } as never);

    expect(registerContextEngine).toHaveBeenCalledWith("lean-context", expect.any(Function));
    expect(registerCommand).toHaveBeenCalledTimes(1);
    expect(on).toHaveBeenCalledWith("tool_result_persist", expect.any(Function), { priority: 90 });
    expect(on).toHaveBeenCalledWith("before_dispatch", expect.any(Function));
    expect(on).toHaveBeenCalledWith("message_sending", expect.any(Function));
  });
});
