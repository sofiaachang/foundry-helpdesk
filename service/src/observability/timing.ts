// Wraps every tool handler so each call emits exactly one `tool_call` line
// (plan U15, KTD13). The line carries the ToolLogFields allowlist only: the
// request body is consulted for conversation_id alone, and the envelope for
// status and a string issue_id.

import { setTimeout as sleep } from "node:timers/promises";
import { CONVERSATION_ID_PATTERN, type ToolName } from "../lib/types.js";
import type { ToolHandler, ToolHandlers } from "../routes/tools.js";
import type { Logger, ToolLogFields } from "./log.js";

export interface TimingOptions {
  logger: Logger;
  /** Artificial delay before each handler, from SLOW_TOOLS_MS; 0 disables it. */
  slowToolsMs: number;
  /** Milliseconds clock; defaults to Date.now so fake timers advance it in tests. */
  clock?: () => number;
}

function conversationIdFrom(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as { conversation_id?: unknown }).conversation_id;
  return typeof value === "string" && CONVERSATION_ID_PATTERN.test(value) ? value : null;
}

export function withTiming(name: ToolName, handler: ToolHandler, opts: TimingOptions): ToolHandler {
  const clock = opts.clock ?? Date.now;
  return async (ctx) => {
    const started = clock();
    const conversation_id = conversationIdFrom(ctx.body);
    const emit = (status: string, issue_id?: string) => {
      const fields: ToolLogFields = {
        event: "tool_call",
        tool: name,
        conversation_id,
        status,
        duration_ms: Math.max(0, Math.round(clock() - started)),
      };
      if (issue_id !== undefined) fields.issue_id = issue_id;
      opts.logger.info(fields);
    };

    try {
      if (opts.slowToolsMs > 0) await sleep(opts.slowToolsMs);
      const envelope = await handler(ctx);
      const issueId = envelope.data?.issue_id;
      emit(envelope.status, typeof issueId === "string" ? issueId : undefined);
      return envelope;
    } catch (error) {
      emit("failed");
      throw error;
    }
  };
}

export function wrapAllHandlers(handlers: ToolHandlers, opts: TimingOptions): ToolHandlers {
  const wrapped = {} as ToolHandlers;
  for (const name of Object.keys(handlers) as ToolName[]) {
    wrapped[name] = withTiming(name, handlers[name], opts);
  }
  return wrapped;
}
