// One-time Foundry login for the delegated user identity (plan KTD3). These
// routes live outside /tools/, so the shared-secret hook does not cover them;
// /auth/start is instead gated by FOUNDRY_LOGIN_TOKEN presented as ?t=, and
// the same value rides in the OAuth state so the auth holder can verify it on
// /auth/callback. No response and no log line here ever carries a code, a
// token, or an OAuth error_description.

import type { FastifyInstance, FastifyReply } from "fastify";
import { constantTimeEqual } from "../lib/compare.js";
import { FoundryAuthError, type FoundryAuth } from "../lib/foundry-auth-types.js";

export interface AuthRoutesOptions {
  loginToken: string;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function text(reply: FastifyReply, status: number, body: string): FastifyReply {
  return reply.code(status).header("cache-control", "no-store").type("text/plain; charset=utf-8").send(`${body}\n`);
}

export function authRoutes(auth: FoundryAuth, opts: AuthRoutesOptions): (app: FastifyInstance) => Promise<void> {
  const expectedToken = Buffer.from(opts.loginToken, "utf8");

  return async (app) => {
    app.get("/auth/start", async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      const presented = firstString(query.t);
      if (!presented || !constantTimeEqual(expectedToken, Buffer.from(presented, "utf8"))) {
        request.log.warn({ event: "auth_login_rejected", url: "/auth/start" });
        return reply.code(401).header("cache-control", "no-store").send({ error: "unauthorized" });
      }
      const target = auth.beginLogin();
      request.log.info({ event: "foundry_login_started" });
      return reply.code(302).header("cache-control", "no-store").header("location", target).send();
    });

    app.get("/auth/callback", async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      // A denied consent comes back as ?error=...; the description is never surfaced.
      if (firstString(query.error)) {
        request.log.warn({ event: "foundry_login_failed", category: "denied" });
        return text(reply, 400, "Foundry login was not completed. Start again from /auth/start.");
      }
      const code = firstString(query.code);
      const state = firstString(query.state);
      if (!code || !state) return text(reply, 400, "Missing code or state.");

      try {
        await auth.completeLogin(code, state);
      } catch (error) {
        if (error instanceof FoundryAuthError) {
          request.log.warn({ event: "foundry_login_failed", category: error.category, http_status: error.httpStatus ?? null });
          if (error.category === "state_mismatch") return text(reply, 401, "Foundry login rejected (state_mismatch).");
          return text(reply, 502, `Foundry login failed (${error.category}).`);
        }
        request.log.error({ event: "foundry_login_failed", category: "unknown" });
        return text(reply, 502, "Foundry login failed (unknown).");
      }
      request.log.info({ event: "foundry_login_complete" });
      return text(reply, 200, "Foundry login complete, you can close this tab.");
    });

    app.get("/auth/status", async (_request, reply) => {
      const report = auth.status();
      return reply.header("cache-control", "no-store").send({ status: report.status, expires_at: report.expiresAt });
    });
  };
}
