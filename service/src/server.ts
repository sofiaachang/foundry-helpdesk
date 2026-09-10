// Composition root. This is the only file outside src/foundry/ allowed to
// import the Foundry adapter implementations (scripts/check-no-disclosure.sh
// enforces it). It constructs the adapter, the handlers, and the app.

import pino from "pino";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { pinoOptions } from "./observability/log.js";
import { defaultHandlers } from "./routes/tools.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino(pinoOptions(config.logLevel));

  if (config.adapter === "fake" && process.env.NODE_ENV === "production") {
    // The fake adapter is a local convenience; a production deploy must talk to Foundry.
    throw new Error("FOUNDRY_ADAPTER=fake is not allowed when NODE_ENV=production");
  }

  // U8 supplies the OSDK adapter and U9 the real handlers. Until then the tool
  // routes answer with the failed envelope, which is honest: nothing is wired.
  const app = await buildApp({ config, logger, handlers: defaultHandlers() });

  await app.listen({ port: config.port, host: "0.0.0.0" });
  logger.info({ event: "listening", port: config.port, adapter: config.adapter });
}

main().catch((error: unknown) => {
  // Config errors name the variable; nothing else about the environment is printed.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`fatal: ${message}\n`);
  process.exit(1);
});
