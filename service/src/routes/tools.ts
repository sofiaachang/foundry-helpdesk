// Tool routes. U6 registers the shells with an injectable handler map so the
// auth and body-limit behaviour can be tested before U9 supplies real handlers.
// U9 replaces `notImplemented` with handlers built on lib/* and the adapter.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { TOOL_NAMES, type Envelope, type ToolName, failed } from "../lib/types.js";

export interface ToolContext {
  /** Raw body after JSON parsing; validated by the handler. */
  body: unknown;
  /** Set by the timing wrapper so the log line can be attributed. */
  request: FastifyRequest;
}

export type ToolHandler = (ctx: ToolContext) => Promise<Envelope>;
export type ToolHandlers = Record<ToolName, ToolHandler>;

export const TOOL_BODY_LIMIT = 16 * 1024;

const notImplemented: ToolHandler = async () => failed();

export function defaultHandlers(): ToolHandlers {
  return Object.fromEntries(TOOL_NAMES.map((name) => [name, notImplemented])) as ToolHandlers;
}

export interface ToolRoutesOptions {
  handlers: ToolHandlers;
}

export async function toolRoutes(app: FastifyInstance, opts: ToolRoutesOptions): Promise<void> {
  for (const name of TOOL_NAMES) {
    app.post(`/tools/${name}`, { bodyLimit: TOOL_BODY_LIMIT }, async (request) => {
      const handler = opts.handlers[name];
      return handler({ body: request.body, request });
    });
  }
}
