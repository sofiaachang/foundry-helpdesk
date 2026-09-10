// The service logs an allowlist of fields, never request bodies. Anything that
// could carry a PIN, a secret, or a Foundry response body is excluded at the
// call site; pino redaction is a second net for the header and digit fields.

import type { FastifyBaseLogger } from "fastify";

export type Logger = FastifyBaseLogger;

/** Fields a tool-call log line may carry. Nothing else is logged for a tool call. */
export interface ToolLogFields {
  event: "tool_call";
  tool: string;
  conversation_id: string | null;
  status: string;
  duration_ms: number;
  issue_id?: string;
  /** Whether the inbound caller id matched a seeded user. Never the number itself. */
  caller_matched?: boolean;
}

/** Pino options shared by the production logger; the capturing test logger ignores them. */
export const pinoOptions = (level: string) => ({
  level,
  redact: {
    paths: [
      'req.headers["x-helpdesk-secret"]',
      "req.headers.authorization",
      "digits",
      "pin",
      "*.digits",
      "*.pin",
    ],
    censor: "[redacted]",
  },
});
