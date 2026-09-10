// Composition root. This is the only file outside src/foundry/ allowed to
// import the Foundry adapter implementations (scripts/check-no-disclosure.sh
// enforces it). It constructs the adapter, the handlers, and the app.

import pino from "pino";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { FoundryAdapter } from "./foundry/adapter.js";
import { FoundryDelegatedAuth } from "./foundry/auth.js";
import { FakeFoundryAdapter } from "./foundry/fake.js";
import { createFoundryAdapter } from "./foundry/osdk.js";
import { buildHandlers } from "./handlers.js";
import { CreateIdempotency } from "./lib/idempotency.js";
import { CallerLockout, SessionStore } from "./lib/sessions.js";
import { Verifier } from "./lib/verification.js";
import type { FastifyInstance } from "fastify";
import { pinoOptions } from "./observability/log.js";
import { wrapAllHandlers } from "./observability/timing.js";
import { authRoutes } from "./routes/auth.js";
import { postcallRoutes } from "./routes/postcall.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino(pinoOptions(config.logLevel));

  if (config.adapter === "fake" && process.env.NODE_ENV === "production") {
    // The fake adapter is a local convenience; a production deploy must talk to Foundry.
    throw new Error("FOUNDRY_ADAPTER=fake is not allowed when NODE_ENV=production");
  }
  if (config.adapter === "not-ready" && process.env.NODE_ENV === "production" && process.env.FOUNDRY_ALLOW_NOT_READY !== "1") {
    // The placeholder adapter fails every tool call closed. It must not boot
    // silently as a production deploy; the pre-U3 login rehearsal opts in.
    throw new Error("FOUNDRY_ADAPTER=not-ready is not allowed when NODE_ENV=production unless FOUNDRY_ALLOW_NOT_READY=1");
  }

  const clock = () => Date.now();
  const extraRoutes: Array<(app: FastifyInstance) => Promise<void>> = [postcallRoutes(config)];

  let adapter: FoundryAdapter;
  let auth: FoundryDelegatedAuth | undefined;
  if (config.adapter === "fake") {
    adapter = FakeFoundryAdapter.fromCsvDir(process.env.SEED_DIR ?? "../ontology/seed");
  } else {
    // Delegated user identity (KTD3): the human logs in once via /auth/start;
    // the adapter reads a fresh access token from this holder per request.
    auth = new FoundryDelegatedAuth({
      stackUrl: config.foundry.stackUrl,
      clientId: config.foundry.clientId,
      redirectUrl: config.foundry.redirectUrl,
      clock,
    });
    extraRoutes.push(authRoutes(auth, { loginToken: config.foundry.loginToken }));
    // "foundry": REST adapter over the token holder (U8). "not-ready": every
    // tool call fails closed while the login routes stay usable.
    adapter = createFoundryAdapter(config, auth, logger);
  }

  const sessions = new SessionStore({ clock, ttlMs: config.sessionTtlMs });
  const lockout = new CallerLockout({ clock, maxFailures: config.lockoutMaxFailures, windowMs: config.lockoutWindowMs });
  const verifier = new Verifier({ sessions, lockout, lookup: (phone) => adapter.findUserByPhone(phone), pepper: config.pinPepper });
  const idempotency = new CreateIdempotency({ clock, ttlMs: config.sessionTtlMs });

  const handlers = wrapAllHandlers(
    buildHandlers({ adapter, sessions, lockout, verifier, idempotency, logger, clock, recentTtlMs: config.sessionTtlMs }),
    { logger, slowToolsMs: config.slowToolsMs },
  );

  const app = await buildApp({ config, logger, handlers, extraRoutes, ...(auth === undefined ? {} : { auth }) });

  await app.listen({ port: config.port, host: "0.0.0.0" });
  logger.info({ event: "listening", port: config.port, adapter: config.adapter, slow_tools_ms: config.slowToolsMs });
}

main().catch((error: unknown) => {
  // Config errors name the variable; nothing else about the environment is printed.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`fatal: ${message}\n`);
  process.exit(1);
});
