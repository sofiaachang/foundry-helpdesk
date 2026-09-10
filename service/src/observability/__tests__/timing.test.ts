// The timing wrapper emits exactly one tool_call line per handler invocation,
// carrying only the ToolLogFields allowlist, and includes any SLOW_TOOLS_MS delay.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTiming, wrapAllHandlers } from "../timing.js";
import type { ToolHandler, ToolHandlers } from "../../routes/tools.js";
import { TOOL_NAMES, type Envelope } from "../../lib/types.js";
import { CapturingLogger } from "../../test-support/logger.js";
import type { FastifyRequest } from "fastify";

const request = {} as FastifyRequest;

function ok(data: Record<string, unknown> = {}): Envelope {
  return { status: "ok", speech: "done", escalate: false, data };
}

describe("withTiming", () => {
  let logs: CapturingLogger;

  beforeEach(() => {
    logs = new CapturingLogger();
  });

  it("logs one tool_call line with tool, conversation id, status, and duration", async () => {
    let now = 1000;
    const handler: ToolHandler = async () => {
      now += 120;
      return ok();
    };
    const wrapped = withTiming("get_issue_status", handler, { logger: logs, slowToolsMs: 0, clock: () => now });
    const env = await wrapped({ body: { conversation_id: "conv_abc123456789", digits: "9999" }, request });
    expect(env.status).toBe("ok");
    const lines = logs.events("tool_call");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      event: "tool_call",
      tool: "get_issue_status",
      conversation_id: "conv_abc123456789",
      status: "ok",
      duration_ms: 120,
    });
    expect(logs.text()).not.toContain("9999");
    expect(logs.text()).not.toContain("digits");
  });

  it("nulls a missing or malformed conversation id", async () => {
    const wrapped = withTiming("verify_caller", async () => ok(), { logger: logs, slowToolsMs: 0, clock: () => 0 });
    await wrapped({ body: { conversation_id: "bad id" }, request });
    await wrapped({ body: "not an object", request });
    await wrapped({ body: null, request });
    const lines = logs.events("tool_call");
    expect(lines.map((l) => l.conversation_id)).toEqual([null, null, null]);
  });

  it("carries issue_id when the envelope data holds a string issue_id", async () => {
    const wrapped = withTiming("create_issue", async () => ok({ issue_id: "ISS-0042" }), { logger: logs, slowToolsMs: 0, clock: () => 0 });
    await wrapped({ body: { conversation_id: "conv_abc123456789" }, request });
    expect(logs.events("tool_call")[0]).toMatchObject({ tool: "create_issue", issue_id: "ISS-0042" });

    logs = new CapturingLogger();
    const noId = withTiming("create_issue", async () => ok({ issue_id: 42 }), { logger: logs, slowToolsMs: 0, clock: () => 0 });
    await noId({ body: {}, request });
    expect(logs.events("tool_call")[0]).not.toHaveProperty("issue_id");
  });

  it("logs status failed and rethrows when the handler throws", async () => {
    const wrapped = withTiming("escalate", async () => {
      throw new Error("boom: secret detail");
    }, { logger: logs, slowToolsMs: 0, clock: () => 0 });
    await expect(wrapped({ body: { conversation_id: "conv_abc123456789" }, request })).rejects.toThrow("boom");
    const lines = logs.events("tool_call");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tool: "escalate", status: "failed", conversation_id: "conv_abc123456789" });
    expect(logs.text()).not.toContain("secret detail");
  });

  describe("with a SLOW_TOOLS_MS delay", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("records the artificial delay in duration_ms", async () => {
      const wrapped = withTiming("list_my_open_issues", async () => ok(), { logger: logs, slowToolsMs: 250 });
      const pending = wrapped({ body: { conversation_id: "conv_abc123456789" }, request });
      await vi.advanceTimersByTimeAsync(250);
      await pending;
      const line = logs.events("tool_call")[0];
      expect(line).toBeDefined();
      expect(line?.duration_ms as number).toBeGreaterThanOrEqual(250);
    });
  });
});

describe("wrapAllHandlers", () => {
  it("wraps every tool handler and keeps the same keys", async () => {
    const logs = new CapturingLogger();
    const handlers = Object.fromEntries(TOOL_NAMES.map((n) => [n, async () => ok()])) as ToolHandlers;
    const wrapped = wrapAllHandlers(handlers, { logger: logs, slowToolsMs: 0, clock: () => 0 });
    expect(Object.keys(wrapped).sort()).toEqual([...TOOL_NAMES].sort());
    for (const name of TOOL_NAMES) {
      await wrapped[name]({ body: { conversation_id: "conv_abc123456789" }, request });
    }
    expect(logs.events("tool_call").map((l) => l.tool).sort()).toEqual([...TOOL_NAMES].sort());
  });
});
