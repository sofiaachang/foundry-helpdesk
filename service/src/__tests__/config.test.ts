import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

const complete: Record<string, string> = {
  FOUNDRY_STACK_URL: "https://zap.usw-18.palantirfoundry.com",
  FOUNDRY_CLIENT_ID: "client",
  FOUNDRY_CLIENT_SECRET: "secret",
  FOUNDRY_ONTOLOGY_RID: "ri.ontology.main.ontology.abc",
  FOUNDRY_ADAPTER: "fake",
  HELPDESK_SHARED_SECRET: "0123456789abcdef0123456789abcdef",
  ELEVENLABS_WEBHOOK_SECRET: "whsec",
  PIN_PEPPER: "pepper",
};

describe("loadConfig", () => {
  it("names the missing variable when one is absent", () => {
    const env = { ...complete };
    delete env.PIN_PEPPER;
    expect(() => loadConfig(env)).toThrow(/PIN_PEPPER/);
  });

  it("applies documented defaults for optional values", () => {
    const cfg = loadConfig(complete);
    expect(cfg.port).toBe(3000);
    expect(cfg.slowToolsMs).toBe(0);
    expect(cfg.lockoutMaxFailures).toBe(6);
    expect(cfg.lockoutWindowMs).toBe(900_000);
    expect(cfg.sessionTtlMs).toBe(600_000);
  });

  it("splits current and previous shared secrets on a comma", () => {
    const cfg = loadConfig({ ...complete, HELPDESK_SHARED_SECRET: "new-secret-value-1234567890,old-secret-value-1234567890" });
    expect(cfg.sharedSecrets).toEqual(["new-secret-value-1234567890", "old-secret-value-1234567890"]);
  });

  it("rejects an unknown adapter name", () => {
    expect(() => loadConfig({ ...complete, FOUNDRY_ADAPTER: "magic" })).toThrow(/FOUNDRY_ADAPTER/);
  });

  it("does not require Foundry credentials when the fake adapter is selected", () => {
    const env = { ...complete };
    delete env.FOUNDRY_CLIENT_ID;
    delete env.FOUNDRY_CLIENT_SECRET;
    expect(() => loadConfig(env)).not.toThrow();
  });

  it("requires Foundry credentials when the osdk adapter is selected", () => {
    const env: Record<string, string> = { ...complete, FOUNDRY_ADAPTER: "osdk" };
    delete env.FOUNDRY_CLIENT_SECRET;
    expect(() => loadConfig(env)).toThrow(/FOUNDRY_CLIENT_SECRET/);
  });
});
