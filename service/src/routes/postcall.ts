// ElevenLabs post-call webhook (plan U15, KTD13). Verifies the signature over
// the raw bytes, then logs one structured line per transcript turn carrying
// metrics and tool names only. Message text, tool parameters, tool results,
// metadata, and analysis never reach the log.
//
// Contract verified against the official docs on 2026-09-09:
//   https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks
//   https://elevenlabs.io/docs/eleven-api/resources/webhooks
// - Header `ElevenLabs-Signature: t=<unix seconds>,v0=<hex hmac>`; the HMAC is
//   SHA-256 with the webhook secret over the string `${t}.${rawBody}`. The
//   SDK's constructEvent accepts a 30-minute window; the integration contract
//   (docs/contract/integration-contract.md, Transport) tightens it to 5 minutes.
// - Payload: `{ type: "post_call_transcription", event_timestamp, data: {
//   conversation_id, transcript: [{ role, message, tool_calls, tool_results,
//   time_in_call_secs, conversation_turn_metrics }], metadata, analysis } }`.
// - Per-turn metrics nest as `conversation_turn_metrics.<name>.elapsed_time`,
//   in seconds (float), for `convai_llm_service_ttfb` and
//   `convai_llm_service_ttf_sentence`; `conversation_turn_metrics` is null on
//   user turns and on agent turns without an LLM call.
// - `metadata.call_duration_secs` carries the call duration.
// - Each `tool_calls[]` entry names its tool in `tool_name`; `params_as_json`
//   holds the parameters and is never read here.
// A second webhook type, `post_call_audio`, exists and is ignored.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { CONVERSATION_ID_PATTERN } from "../lib/types.js";

export const POSTCALL_BODY_LIMIT = 2 * 1024 * 1024;
export const POSTCALL_TIMESTAMP_WINDOW_SECS = 5 * 60;
const SIGNATURE_HEADER = "elevenlabs-signature";

/** Fields a post-call turn line may carry. Nothing else is logged for a turn. */
export interface PostcallTurnLogFields {
  event: "postcall_turn";
  conversation_id: string | null;
  turn_index: number;
  role: string | null;
  time_in_call_secs: number | null;
  /** Tool names only; parameters and results are discarded. */
  tool_names: string[];
  ttfb_ms: number | null;
  ttf_sentence_ms: number | null;
}

export interface PostcallSummaryLogFields {
  event: "postcall_summary";
  conversation_id: string | null;
  turn_count: number;
  call_duration_secs: number | null;
}

type RejectReason = "missing_signature" | "malformed_signature" | "bad_timestamp" | "stale_timestamp" | "bad_signature";

function parseSignature(header: string | string[] | undefined): { t: string; v0: string[] } | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  let t: string | undefined;
  const v0: string[] = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (trimmed.startsWith("t=")) t = trimmed.slice(2);
    else if (trimmed.startsWith("v0=")) v0.push(trimmed.slice(3));
  }
  if (!t || v0.length === 0) return null;
  return { t, v0 };
}

function hexEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Returns a reason when the request must be refused; null when it is authentic and fresh. */
export function verifySignature(
  header: string | string[] | undefined,
  rawBody: Buffer,
  secret: string,
  nowSecs: number,
): RejectReason | null {
  if (header === undefined || (Array.isArray(header) && header.length === 0)) return "missing_signature";
  const parsed = parseSignature(header);
  if (!parsed) return "malformed_signature";
  if (!/^\d{1,12}$/.test(parsed.t)) return "bad_timestamp";
  const t = Number(parsed.t);
  if (Math.abs(nowSecs - t) > POSTCALL_TIMESTAMP_WINDOW_SECS) return "stale_timestamp";
  const expected = createHmac("sha256", secret).update(`${parsed.t}.`).update(rawBody).digest("hex");
  // Check every presented v0 so a rotated secret's extra signature cannot mask a bad one by position.
  let ok = false;
  for (const candidate of parsed.v0) {
    if (hexEquals(candidate, expected)) ok = true;
  }
  return ok ? null : "bad_signature";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function conversationId(value: unknown): string | null {
  return typeof value === "string" && CONVERSATION_ID_PATTERN.test(value) ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function elapsedMs(metrics: Record<string, unknown> | null, name: string): number | null {
  const metric = asRecord(metrics?.[name]);
  const seconds = finiteNumber(metric?.elapsed_time);
  return seconds === null ? null : Math.round(seconds * 1000);
}

function toolNames(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) return [];
  const names: string[] = [];
  for (const call of toolCalls) {
    const name = asRecord(call)?.tool_name;
    if (typeof name === "string") names.push(name);
  }
  return names;
}

export function turnLogFields(conversation_id: string | null, turn_index: number, entry: unknown): PostcallTurnLogFields {
  const record = asRecord(entry);
  const metrics = asRecord(record?.conversation_turn_metrics);
  return {
    event: "postcall_turn",
    conversation_id,
    turn_index,
    role: typeof record?.role === "string" ? record.role : null,
    time_in_call_secs: finiteNumber(record?.time_in_call_secs),
    tool_names: toolNames(record?.tool_calls),
    ttfb_ms: elapsedMs(metrics, "convai_llm_service_ttfb"),
    ttf_sentence_ms: elapsedMs(metrics, "convai_llm_service_ttf_sentence"),
  };
}

function logPayload(request: FastifyRequest, payload: unknown): void {
  const root = asRecord(payload);
  const type = root?.type;
  if (type !== "post_call_transcription") {
    request.log.info({ event: "postcall_ignored", type: typeof type === "string" ? type.slice(0, 64) : null });
    return;
  }
  const data = asRecord(root?.data);
  const conversation_id = conversationId(data?.conversation_id);
  const transcript = Array.isArray(data?.transcript) ? data.transcript : [];
  transcript.forEach((entry, index) => {
    request.log.info(turnLogFields(conversation_id, index, entry));
  });
  const summary: PostcallSummaryLogFields = {
    event: "postcall_summary",
    conversation_id,
    turn_count: transcript.length,
    call_duration_secs: finiteNumber(asRecord(data?.metadata)?.call_duration_secs),
  };
  request.log.info(summary);
}

export function postcallRoutes(config: Config): (app: FastifyInstance) => Promise<void> {
  return async (app) => {
    // This registration runs as its own plugin, so the parser override is scoped
    // to this encapsulation context: tool routes keep the parsed-JSON default.
    app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: POSTCALL_BODY_LIMIT }, (_req, body, done) => {
      done(null, body);
    });

    app.post("/postcall", { bodyLimit: POSTCALL_BODY_LIMIT }, async (request, reply) => {
      const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const reason = verifySignature(
        request.headers[SIGNATURE_HEADER],
        rawBody,
        config.elevenLabsWebhookSecret,
        Math.floor(Date.now() / 1000),
      );
      if (reason) {
        // Nothing from the body is logged on rejection; only the reason and size.
        request.log.warn({ event: "postcall_rejected", reason, bytes: rawBody.length });
        return reply.code(401).send({ error: "unauthorized" });
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        request.log.warn({ event: "postcall_rejected", reason: "invalid_json", bytes: rawBody.length });
        return reply.code(400).send({ error: "bad request" });
      }

      logPayload(request, payload);
      return reply.code(200).send({ received: true });
    });
  };
}
