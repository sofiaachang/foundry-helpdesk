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

/**
 * The URL as it may appear in a request log line: path only. Query strings
 * are dropped because the OAuth callback carries the authorization code, the
 * login token, and Foundry's error_description in the query (routes/auth.ts),
 * and no route in this service needs its query logged.
 */
export function requestLogUrl(url: string | undefined): string {
  if (!url) return "";
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/** Pino options shared by the production logger; the capturing test logger mirrors the req serializer. */
export const pinoOptions = (level: string) => ({
  level,
  serializers: {
    // Overrides Fastify's default req serializer (which logs the raw URL).
    // Verified against the installed fastify/pino in __tests__/log.test.ts.
    req: (req: { method?: string; url?: string; ip?: string }) => ({
      method: req.method,
      url: requestLogUrl(req.url),
      remoteAddress: req.ip,
    }),
  },
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
