// Builds the Fastify app. server.ts is the composition root that supplies the
// adapter and real handlers; tests build the app with fakes.

import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { constantTimeEqual } from "./lib/compare.js";
import { healthRoutes } from "./routes/health.js";
import { defaultHandlers, toolRoutes, type ToolHandlers } from "./routes/tools.js";

export type App = FastifyInstance;

export interface BuildAppOptions {
  config: Config;
  logger: FastifyBaseLogger;
  handlers?: ToolHandlers;
  /** Registered by U15; kept optional so U6 can be tested alone. */
  extraRoutes?: Array<(app: FastifyInstance) => Promise<void>>;
}

const SECRET_HEADER = "x-helpdesk-secret";

function secretMatches(presented: string, accepted: string[]): boolean {
  const presentedBuf = Buffer.from(presented, "utf8");
  let ok = false;
  for (const candidate of accepted) {
    if (constantTimeEqual(Buffer.from(candidate, "utf8"), presentedBuf)) ok = true;
  }
  return ok;
}

export async function buildApp(opts: BuildAppOptions): Promise<App> {
  const app = Fastify({
    loggerInstance: opts.logger,
    // Fastify's request log carries method, url, and remote address only; bodies
    // and headers are never logged. The timing wrapper (U15) adds the tool line.
    bodyLimit: 16 * 1024,
  });

  // JSON only. Fastify ships a text/plain parser by default; removing it makes
  // every non-JSON tool body a 415 instead of a string the handler has to reject.
  app.removeContentTypeParser("text/plain");

  // The shared-secret check runs in onRequest, before any body parsing, so an
  // unauthenticated body is never parsed, never logged, and never reaches a handler.
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/tools/")) return;
    const presented = request.headers[SECRET_HEADER];
    const value = Array.isArray(presented) ? presented[0] : presented;
    if (!value || !secretMatches(value, opts.config.sharedSecrets)) {
      request.log.warn({ event: "auth_rejected", url: request.url });
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  await app.register(healthRoutes);
  await app.register(toolRoutes, { handlers: opts.handlers ?? defaultHandlers() });
  for (const register of opts.extraRoutes ?? []) {
    await app.register(register);
  }

  // Any thrown error becomes the contract's failed envelope. Nothing from the
  // error object reaches the agent.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode;
    if (status === 413 || status === 415 || status === 400) {
      return reply.code(status).send({ error: status === 413 ? "body too large" : status === 415 ? "unsupported media type" : "bad request" });
    }
    request.log.error({ event: "unhandled_error", url: request.url, name: error.name });
    return reply.code(200).send({
      status: "failed",
      speech: "I couldn't complete that. I can have a person call you back.",
      escalate: true,
      data: {},
    });
  });

  return app;
}
