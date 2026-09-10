// Composition root. This is the only file outside src/foundry/ allowed to
// import the Foundry adapter implementations (scripts/check-no-disclosure.sh
// enforces it). It constructs the adapter, the handlers, and the app.

import pino from "pino";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { FoundryAdapter } from "./foundry/adapter.js";
import { FoundryDelegatedAuth } from "./foundry/auth.js";
import { FakeFoundryAdapter } from "./foundry/fake.js";
import { NotReadyFoundryAdapter } from "./foundry/osdk.js";
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

  const clock = () => Date.now();
  const extraRoutes: Array<(app: FastifyInstance) => Promise<void>> = [postcallRoutes(config)];

  let adapter: FoundryAdapter;
  if (config.adapter === "fake") {
    adapter = FakeFoundryAdapter.fromCsvDir(process.env.SEED_DIR ?? "../ontology/seed");
  } else {
    // Delegated user identity (KTD3): the human logs in once via /auth/start;
    // the adapter reads a fresh access token from this holder per request.
    const auth = new FoundryDelegatedAuth({
      stackUrl: config.foundry.stackUrl,
      clientId: config.foundry.clientId,
      redirectUrl: config.foundry.redirectUrl,
      loginToken: config.foundry.loginToken,
      clock,
    });
    extraRoutes.push(authRoutes(auth, { loginToken: config.foundry.loginToken }));
    // Until U8 installs the generated SDK, the osdk slot holds a placeholder
    // that fails every tool call closed while the login routes stay usable.
    // U8 replaces this line with the real adapter over tokenProvider(auth).
    adapter = new NotReadyFoundryAdapter(logger);
  }

  const sessions = new SessionStore({ clock, ttlMs: config.sessionTtlMs });
  const lockout = new CallerLockout({ clock, maxFailures: config.lockoutMaxFailures, windowMs: config.lockoutWindowMs });
  const verifier = new Verifier({ sessions, lockout, lookup: (phone) => adapter.findUserByPhone(phone), pepper: config.pinPepper });
  const idempotency = new CreateIdempotency({ clock, ttlMs: config.sessionTtlMs });

  const handlers = wrapAllHandlers(
    buildHandlers({ adapter, sessions, lockout, verifier, idempotency, logger, clock, recentTtlMs: config.sessionTtlMs }),
    { logger, slowToolsMs: config.slowToolsMs },
  );

  const app = await buildApp({ config, logger, handlers, extraRoutes });

  await app.listen({ port: config.port, host: "0.0.0.0" });
  const adapterLabel = config.adapter === "osdk" ? "osdk-not-ready" : config.adapter;
  logger.info({ event: "listening", port: config.port, adapter: adapterLabel, slow_tools_ms: config.slowToolsMs });
}

main().catch((error: unknown) => {
  // Config errors name the variable; nothing else about the environment is printed.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`fatal: ${message}\n`);
  process.exit(1);
});
