import type { Config } from "../config.js";
import { DEFAULT_ONTOLOGY_NAMES } from "../lib/ontology-names.js";

/** A complete config for tests; override only what the test cares about. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    logLevel: "silent",
    adapter: "fake",
    foundry: { stackUrl: "", clientId: "", ontologyRid: "", redirectUrl: "", loginToken: "" },
    ontologyNames: DEFAULT_ONTOLOGY_NAMES,
    sharedSecrets: ["test-secret-0123456789abcdef"],
    elevenLabsWebhookSecret: "test-webhook-secret",
    pinPepper: "test-pepper",
    lockoutMaxFailures: 6,
    lockoutWindowMs: 900_000,
    sessionTtlMs: 600_000,
    slowToolsMs: 0,
    ...overrides,
  };
}
