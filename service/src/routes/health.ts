// Liveness plus the two facts an operator checks after a deploy: which adapter
// is running and whether the delegated Foundry login has been done. The auth
// field is the status word only, never a token or an expiry.

import type { FastifyInstance } from "fastify";
import type { AdapterKind } from "../config.js";
import type { FoundryAuth, FoundryAuthStatus } from "../lib/foundry-auth-types.js";

export interface HealthRoutesOptions {
  adapter: AdapterKind;
  /** Absent for the fake adapter, which needs no login. */
  auth?: FoundryAuth;
}

export interface HealthReport {
  ok: true;
  adapter: AdapterKind;
  auth: FoundryAuthStatus | "n/a";
}

export async function healthRoutes(app: FastifyInstance, opts: HealthRoutesOptions): Promise<void> {
  app.get("/health", async (): Promise<HealthReport> => ({
    ok: true,
    adapter: opts.adapter,
    auth: opts.auth ? opts.auth.status().status : "n/a",
  }));
}
