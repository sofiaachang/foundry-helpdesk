// Post-call webhook: signature and timestamp gate, then per-turn metric lines
// with nothing from the transcript text. Payloads are signed with the same
// scheme ElevenLabs uses (see routes/postcall.ts for the verified contract).

import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type App } from "../../app.js";
import { postcallRoutes } from "../postcall.js";
import { testConfig } from "../../test-support/config.js";
import { CapturingLogger } from "../../test-support/logger.js";

const WEBHOOK_SECRET = "whsec_test_0123456789abcdef";
const SECRET_MESSAGE = "My PIN is 4321 and my password is hunter2";
const SECRET_PARAM = "param-value-that-must-never-be-logged";
const SECRET_RESULT = "tool-result-body-that-must-never-be-logged";

function sign(rawBody: string, t: number, secret = WEBHOOK_SECRET): string {
  const v0 = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return `t=${t},v0=${v0}`;
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "post_call_transcription",
    event_timestamp: nowSecs(),
    data: {
      agent_id: "agent_x",
      conversation_id: "conv_abc123456789",
      status: "done",
      transcript: [
        {
          role: "agent",
          message: "Hello, please enter your PIN.",
          tool_calls: null,
          tool_results: null,
          time_in_call_secs: 0,
          conversation_turn_metrics: null,
        },
        {
          role: "user",
          message: SECRET_MESSAGE,
          tool_calls: null,
          tool_results: null,
          time_in_call_secs: 3,
          conversation_turn_metrics: null,
        },
        {
          role: "agent",
          message: "Thanks, you are verified.",
          tool_calls: [
            {
              type: "webhook",
              request_id: "req_1",
              tool_name: "verify_caller",
              params_as_json: JSON.stringify({ conversation_id: "conv_abc123456789", digits: SECRET_PARAM }),
              tool_has_been_called: true,
            },
          ],
          tool_results: [
            { type: "webhook", request_id: "req_1", tool_name: "verify_caller", result_value: SECRET_RESULT, is_error: false },
          ],
          time_in_call_secs: 7,
          conversation_turn_metrics: {
            convai_llm_service_ttfb: { elapsed_time: 0.3704247010173276 },
            convai_llm_service_ttf_sentence: { elapsed_time: 0.5551181449554861 },
          },
        },
      ],
      metadata: { call_duration_secs: 22, cost: 42 },
      analysis: { transcript_summary: SECRET_MESSAGE },
    },
    ...overrides,
  };
}

describe("POST /postcall", () => {
  let app: App;
  let logs: CapturingLogger;

  beforeEach(async () => {
    logs = new CapturingLogger();
    const config = testConfig({ elevenLabsWebhookSecret: WEBHOOK_SECRET });
    app = await buildApp({ config, logger: logs, extraRoutes: [postcallRoutes(config)] });
  });

  afterEach(async () => {
    await app.close();
  });

  async function post(raw: string, signature: string | undefined) {
    return app.inject({
      method: "POST",
      url: "/postcall",
      headers: { "content-type": "application/json", ...(signature ? { "elevenlabs-signature": signature } : {}) },
      payload: raw,
    });
  }

  function expectNothingFromBody() {
    const text = logs.text();
    expect(text).not.toContain(SECRET_MESSAGE);
    expect(text).not.toContain("4321");
    expect(text).not.toContain(SECRET_PARAM);
    expect(text).not.toContain(SECRET_RESULT);
    expect(text).not.toContain("conv_abc123456789");
    expect(text).not.toContain("verify_caller");
  }

  it("rejects a missing signature with 401 and logs nothing from the body", async () => {
    const res = await post(JSON.stringify(payload()), undefined);
    expect(res.statusCode).toBe(401);
    expectNothingFromBody();
    expect(logs.events("postcall_turn")).toHaveLength(0);
  });

  it("rejects a bad signature with 401 and logs nothing from the body", async () => {
    const raw = JSON.stringify(payload());
    const res = await post(raw, sign(raw, nowSecs(), "wrong-secret"));
    expect(res.statusCode).toBe(401);
    expectNothingFromBody();
    expect(logs.events("postcall_turn")).toHaveLength(0);
  });

  it("rejects a signature over a different body", async () => {
    const raw = JSON.stringify(payload());
    const other = JSON.stringify(payload({ event_timestamp: 1 }));
    const res = await post(raw, sign(other, nowSecs()));
    expect(res.statusCode).toBe(401);
    expectNothingFromBody();
  });

  it("rejects a stale timestamp (older than five minutes) with 401 and logs nothing from the body", async () => {
    const raw = JSON.stringify(payload());
    const res = await post(raw, sign(raw, nowSecs() - 6 * 60));
    expect(res.statusCode).toBe(401);
    expectNothingFromBody();
    expect(logs.events("postcall_turn")).toHaveLength(0);
  });

  it("rejects a timestamp more than five minutes in the future with 401", async () => {
    const raw = JSON.stringify(payload());
    const res = await post(raw, sign(raw, nowSecs() + 6 * 60));
    expect(res.statusCode).toBe(401);
    expectNothingFromBody();
  });

  it("accepts a valid payload, answers {received:true}, and logs one line per turn with no transcript text", async () => {
    const raw = JSON.stringify(payload());
    const res = await post(raw, sign(raw, nowSecs()));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });

    const turns = logs.events("postcall_turn");
    expect(turns).toHaveLength(3);
    expect(turns[0]).toEqual({
      event: "postcall_turn",
      conversation_id: "conv_abc123456789",
      turn_index: 0,
      role: "agent",
      time_in_call_secs: 0,
      tool_names: [],
      ttfb_ms: null,
      ttf_sentence_ms: null,
    });
    expect(turns[1]).toMatchObject({ turn_index: 1, role: "user", time_in_call_secs: 3, tool_names: [] });
    expect(turns[2]).toEqual({
      event: "postcall_turn",
      conversation_id: "conv_abc123456789",
      turn_index: 2,
      role: "agent",
      time_in_call_secs: 7,
      tool_names: ["verify_caller"],
      ttfb_ms: 370,
      ttf_sentence_ms: 555,
    });
    for (const turn of turns) {
      expect(Object.keys(turn).sort()).toEqual(
        ["conversation_id", "event", "role", "time_in_call_secs", "tool_names", "ttf_sentence_ms", "ttfb_ms", "turn_index"],
      );
    }

    const text = logs.text();
    expect(text).not.toContain(SECRET_MESSAGE);
    expect(text).not.toContain("4321");
    expect(text).not.toContain(SECRET_PARAM);
    expect(text).not.toContain(SECRET_RESULT);
    expect(text).not.toContain("message");
    expect(text).not.toContain("params_as_json");

    const summaries = logs.events("postcall_summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual({
      event: "postcall_summary",
      conversation_id: "conv_abc123456789",
      turn_count: 3,
      call_duration_secs: 22,
    });
  });

  it("accepts a valid ~200 KB payload and produces per-turn lines", async () => {
    const base = payload();
    const data = base.data as { transcript: unknown[] };
    const filler = "x".repeat(900);
    const transcript: unknown[] = [];
    for (let i = 0; i < 220; i += 1) {
      transcript.push({
        role: i % 2 === 0 ? "agent" : "user",
        message: `${filler} turn ${i}`,
        tool_calls: null,
        tool_results: null,
        time_in_call_secs: i * 2,
        conversation_turn_metrics:
          i % 2 === 0
            ? { convai_llm_service_ttfb: { elapsed_time: 0.2 }, convai_llm_service_ttf_sentence: { elapsed_time: 0.4 } }
            : null,
      });
    }
    data.transcript = transcript;
    const raw = JSON.stringify(base);
    expect(raw.length).toBeGreaterThan(190_000);
    expect(raw.length).toBeLessThan(260_000);

    const res = await post(raw, sign(raw, nowSecs()));
    expect(res.statusCode).toBe(200);
    expect(logs.events("postcall_turn")).toHaveLength(220);
    expect(logs.text()).not.toContain(filler);
  });

  it("rejects a body over 2 MB with 413 before verifying", async () => {
    const base = payload();
    (base.data as { transcript: unknown[] }).transcript = [{ role: "user", message: "y".repeat(2 * 1024 * 1024 + 10) }];
    const raw = JSON.stringify(base);
    const res = await post(raw, sign(raw, nowSecs()));
    expect(res.statusCode).toBe(413);
    expect(logs.events("postcall_turn")).toHaveLength(0);
  });

  it("answers 200 and logs a single postcall_ignored line for an unknown type", async () => {
    const raw = JSON.stringify(payload({ type: "post_call_audio" }));
    const res = await post(raw, sign(raw, nowSecs()));
    expect(res.statusCode).toBe(200);
    expect(logs.events("postcall_ignored")).toHaveLength(1);
    expect(logs.events("postcall_ignored")[0]).toMatchObject({ type: "post_call_audio" });
    expect(logs.events("postcall_turn")).toHaveLength(0);
    expect(logs.events("postcall_summary")).toHaveLength(0);
    expect(logs.text()).not.toContain(SECRET_MESSAGE);
  });

  it("logs null metrics when conversation_turn_metrics is absent and nulls a malformed conversation id", async () => {
    const base = payload();
    (base.data as Record<string, unknown>).conversation_id = "bad id with spaces";
    (base.data as Record<string, unknown>).metadata = {};
    const raw = JSON.stringify(base);
    const res = await post(raw, sign(raw, nowSecs()));
    expect(res.statusCode).toBe(200);
    const turns = logs.events("postcall_turn");
    expect(turns[0]).toMatchObject({ conversation_id: null, ttfb_ms: null, ttf_sentence_ms: null });
    expect(logs.events("postcall_summary")[0]).toMatchObject({ conversation_id: null, call_duration_secs: null });
  });
});
