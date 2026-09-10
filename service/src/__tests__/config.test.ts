import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

const complete: Record<string, string> = {
  FOUNDRY_STACK_URL: "https://zap.usw-18.palantirfoundry.com",
  FOUNDRY_CLIENT_ID: "client",
  FOUNDRY_REDIRECT_URL: "http://localhost:3000/auth/callback",
  FOUNDRY_LOGIN_TOKEN: "login-token-0123456789abcdefghij",
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

  it("does not require Foundry settings when the fake adapter is selected", () => {
    const env = { ...complete };
    delete env.FOUNDRY_CLIENT_ID;
    delete env.FOUNDRY_REDIRECT_URL;
    delete env.FOUNDRY_LOGIN_TOKEN;
    expect(() => loadConfig(env)).not.toThrow();
  });

  it("requires the redirect URL when the osdk adapter is selected", () => {
    const env: Record<string, string> = { ...complete, FOUNDRY_ADAPTER: "osdk" };
    delete env.FOUNDRY_REDIRECT_URL;
    expect(() => loadConfig(env)).toThrow(/FOUNDRY_REDIRECT_URL/);
  });

  it("requires the client id when the osdk adapter is selected", () => {
    const env: Record<string, string> = { ...complete, FOUNDRY_ADAPTER: "osdk" };
    delete env.FOUNDRY_CLIENT_ID;
    expect(() => loadConfig(env)).toThrow(/FOUNDRY_CLIENT_ID/);
  });

  it("never requires a client secret (public client with PKCE)", () => {
    const env: Record<string, string> = { ...complete, FOUNDRY_ADAPTER: "osdk" };
    const cfg = loadConfig(env);
    expect(cfg.foundry).not.toHaveProperty("clientSecret");
    expect(cfg.foundry.redirectUrl).toBe("http://localhost:3000/auth/callback");
    expect(cfg.foundry.loginToken).toBe("login-token-0123456789abcdefghij");
  });

  it("rejects a redirect URL that is not http(s)", () => {
    expect(() => loadConfig({ ...complete, FOUNDRY_ADAPTER: "osdk", FOUNDRY_REDIRECT_URL: "not a url" })).toThrow(/FOUNDRY_REDIRECT_URL/);
    expect(() => loadConfig({ ...complete, FOUNDRY_ADAPTER: "osdk", FOUNDRY_REDIRECT_URL: "ftp://x/y" })).toThrow(/FOUNDRY_REDIRECT_URL/);
  });

  it("requires a login token of at least 24 characters in osdk mode", () => {
    const env: Record<string, string> = { ...complete, FOUNDRY_ADAPTER: "osdk" };
    delete env.FOUNDRY_LOGIN_TOKEN;
    expect(() => loadConfig(env)).toThrow(/FOUNDRY_LOGIN_TOKEN/);
    expect(() => loadConfig({ ...env, FOUNDRY_LOGIN_TOKEN: "short" })).toThrow(/FOUNDRY_LOGIN_TOKEN/);
  });
});
