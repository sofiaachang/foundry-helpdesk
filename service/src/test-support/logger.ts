// A pino-compatible logger that keeps every line in memory so tests can assert
// what was, and was not, logged.

import type { FastifyBaseLogger } from "fastify";
import { requestLogUrl } from "../observability/log.js";

type Level = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

// The production req serializer (observability/log.ts) reduces `req` to
// method/path/remote address, and Fastify's res serializer to statusCode.
// Mirror that so the test double neither hides a real leak nor invents one by
// dumping the whole request object. The query-string redaction itself is
// tested against real pino in observability/__tests__/log.test.ts.
function serializeLikePino(arg: unknown): unknown {
  if (typeof arg !== "object" || arg === null) return arg;
  const record = { ...(arg as Record<string, unknown>) };
  if (record.req && typeof record.req === "object") {
    const req = record.req as { method?: string; url?: string };
    record.req = { method: req.method, url: requestLogUrl(req.url) };
  }
  if (record.res && typeof record.res === "object") {
    const res = record.res as { statusCode?: number };
    record.res = { statusCode: res.statusCode };
  }
  return record;
}

export class CapturingLogger {
  readonly lines: Array<{ level: Level; args: unknown[] }> = [];
  level = "trace";

  private record(level: Level) {
    return (...args: unknown[]) => {
      this.lines.push({ level, args: args.map(serializeLikePino) });
    };
  }

  fatal = this.record("fatal");
  error = this.record("error");
  warn = this.record("warn");
  info = this.record("info");
  debug = this.record("debug");
  trace = this.record("trace");
  silent = () => {};

  child(): FastifyBaseLogger {
    // Children share the parent's buffer so nothing is lost behind a child logger.
    return this as unknown as FastifyBaseLogger;
  }

  /** Everything logged, serialised, for substring assertions. */
  text(): string {
    return this.lines.map((l) => JSON.stringify(l.args)).join("\n");
  }

  /** Structured entries whose first argument carries the given event name. */
  events(name: string): Array<Record<string, unknown>> {
    return this.lines
      .map((l) => l.args[0])
      .filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null && (a as { event?: string }).event === name);
  }
}
