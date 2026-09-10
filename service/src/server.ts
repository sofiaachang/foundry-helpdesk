// Composition root. This is the only file outside src/foundry/ allowed to
// import the Foundry adapter implementations (scripts/check-no-disclosure.sh
// enforces it). It constructs the adapter, the handlers, and the app.

import pino from "pino";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { FoundryAdapter } from "./foundry/adapter.js";
import { FakeFoundryAdapter } from "./foundry/fake.js";
import { createOsdkAdapter } from "./foundry/osdk.js";
import { buildHandlers } from "./handlers.js";
import { CreateIdempotency } from "./lib/idempotency.js";
import { CallerLockout, SessionStore } from "./lib/sessions.js";
import { Verifier } from "./lib/verification.js";
import { pinoOptions } from "./observability/log.js";
import { wrapAllHandlers } from "./observability/timing.js";
import { postcallRoutes } from "./routes/postcall.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino(pinoOptions(config.logLevel));

  if (config.adapter === "fake" && process.env.NODE_ENV === "production") {
    // The fake adapter is a local convenience; a production deploy must talk to Foundry.
    throw new Error("FOUNDRY_ADAPTER=fake is not allowed when NODE_ENV=production");
  }

  const adapter: FoundryAdapter =
    config.adapter === "fake"
      ? FakeFoundryAdapter.fromCsvDir(process.env.SEED_DIR ?? "../ontology/seed")
      : createOsdkAdapter(config);

  const clock = () => Date.now();
  const sessions = new SessionStore({ clock, ttlMs: config.sessionTtlMs });
  const lockout = new CallerLockout({ clock, maxFailures: config.lockoutMaxFailures, windowMs: config.lockoutWindowMs });
  const verifier = new Verifier({ sessions, lockout, lookup: (phone) => adapter.findUserByPhone(phone), pepper: config.pinPepper });
  const idempotency = new CreateIdempotency({ clock, ttlMs: config.sessionTtlMs });

  const handlers = wrapAllHandlers(buildHandlers({ adapter, sessions, lockout, verifier, idempotency, logger, clock }), {
    logger,
    slowToolsMs: config.slowToolsMs,
  });

  const app = await buildApp({ config, logger, handlers, extraRoutes: [postcallRoutes(config)] });

  await app.listen({ port: config.port, host: "0.0.0.0" });
  logger.info({ event: "listening", port: config.port, adapter: config.adapter, slow_tools_ms: config.slowToolsMs });
}

main().catch((error: unknown) => {
  // Config errors name the variable; nothing else about the environment is printed.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`fatal: ${message}\n`);
  process.exit(1);
});
