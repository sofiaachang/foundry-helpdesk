// /auth/* routes with an injected fake FoundryAuth. These routes sit outside
// /tools/ (no shared-secret hook); /auth/start is guarded by the login token.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type App } from "../../app.js";
import { authRoutes } from "../auth.js";
import { FoundryAuthError, type FoundryAuth, type FoundryAuthStatusReport } from "../../lib/foundry-auth-types.js";
import { testConfig } from "../../test-support/config.js";
import { CapturingLogger } from "../../test-support/logger.js";

const LOGIN_TOKEN = "login-token-0123456789abcdefghij";
const AUTHORIZE_URL = "https://zap.example.com/multipass/api/oauth2/authorize?client_id=c&state=" + encodeURIComponent(`${LOGIN_TOKEN}.nonce`);
const ACCESS = "access-token-value-SECRET";
const REFRESH = "refresh-token-value-SECRET";

class FakeAuth implements FoundryAuth {
  beginCalls = 0;
  completed: Array<{ code: string; state: string }> = [];
  completeError: FoundryAuthError | null = null;
  report: FoundryAuthStatusReport = { status: "logged_out", expiresAt: null };
  // Present so a careless serialiser would leak them; the status route must not.
  accessToken = ACCESS;
  refreshToken = REFRESH;

  beginLogin(): string {
    this.beginCalls += 1;
    return AUTHORIZE_URL;
  }
  async completeLogin(code: string, state: string): Promise<void> {
    if (this.completeError) throw this.completeError;
    this.completed.push({ code, state });
    this.report = { status: "ok", expiresAt: "2026-09-09T12:00:00.000Z" };
  }
  async getToken(): Promise<string> {
    return this.accessToken;
  }
  async forceRefresh(): Promise<void> {}
  status(): FoundryAuthStatusReport {
    return this.report;
  }
}

describe("auth routes", () => {
  let app: App;
  let logs: CapturingLogger;
  let auth: FakeAuth;

  beforeEach(async () => {
    logs = new CapturingLogger();
    auth = new FakeAuth();
    app = await buildApp({
      config: testConfig(),
      logger: logs,
      extraRoutes: [authRoutes(auth, { loginToken: LOGIN_TOKEN })],
    });
  });

  afterEach(async () => {
    await app.close();
  });

  describe("GET /auth/start", () => {
    it("returns 401 without the login token and does not begin a login", async () => {
      const res = await app.inject({ method: "GET", url: "/auth/start" });
      expect(res.statusCode).toBe(401);
      expect(auth.beginCalls).toBe(0);
    });

    it("returns 401 with a wrong login token", async () => {
      const res = await app.inject({ method: "GET", url: `/auth/start?t=${LOGIN_TOKEN.slice(0, -1)}x` });
      expect(res.statusCode).toBe(401);
      expect(auth.beginCalls).toBe(0);
    });

    it("redirects to the authorize URL with the right token", async () => {
      const res = await app.inject({ method: "GET", url: `/auth/start?t=${LOGIN_TOKEN}` });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(AUTHORIZE_URL);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(auth.beginCalls).toBe(1);
    });

    it("is not gated by the tools shared secret", async () => {
      const res = await app.inject({ method: "GET", url: `/auth/start?t=${LOGIN_TOKEN}` });
      expect(res.statusCode).toBe(302);
    });
  });

  describe("GET /auth/callback", () => {
    it("exchanges the code and answers plain text without any token", async () => {
      const state = `${LOGIN_TOKEN}.nonce`;
      const res = await app.inject({ method: "GET", url: `/auth/callback?code=code-123&state=${encodeURIComponent(state)}` });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/^text\/plain/);
      expect(res.body).toContain("Foundry login complete");
      expect(res.body).toContain("close this tab");
      expect(res.body).not.toContain(ACCESS);
      expect(res.body).not.toContain(REFRESH);
      expect(auth.completed).toEqual([{ code: "code-123", state }]);
      expect(logs.text()).not.toContain("code-123");
      expect(logs.text()).not.toContain(ACCESS);
    });

    it("returns 400 when code or state is missing", async () => {
      const res = await app.inject({ method: "GET", url: "/auth/callback?code=only" });
      expect(res.statusCode).toBe(400);
      expect(auth.completed).toHaveLength(0);
    });

    it("returns 400 when Foundry reports a denial and never logs the description", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/auth/callback?error=access_denied&error_description=SECRET-DESCRIPTION",
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain("SECRET-DESCRIPTION");
      expect(logs.text()).not.toContain("SECRET-DESCRIPTION");
      expect(auth.completed).toHaveLength(0);
    });

    it("returns 401 when the state is rejected", async () => {
      auth.completeError = new FoundryAuthError("state_mismatch");
      const res = await app.inject({ method: "GET", url: "/auth/callback?code=c&state=wrong" });
      expect(res.statusCode).toBe(401);
      expect(res.body).not.toContain(ACCESS);
    });

    it("returns 502 with only the category when the exchange fails", async () => {
      auth.completeError = new FoundryAuthError("exchange_failed", 400);
      const res = await app.inject({ method: "GET", url: `/auth/callback?code=c&state=${LOGIN_TOKEN}.n` });
      expect(res.statusCode).toBe(502);
      expect(res.body).toContain("exchange_failed");
      const failures = logs.events("foundry_login_failed");
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ category: "exchange_failed", http_status: 400 });
    });
  });

  describe("GET /auth/status", () => {
    it("reports logged_out before login with no token material", async () => {
      const res = await app.inject({ method: "GET", url: "/auth/status" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "logged_out", expires_at: null });
      expect(res.body).not.toContain(ACCESS);
      expect(res.body).not.toContain(REFRESH);
    });

    it("reports ok after login and still carries no token material", async () => {
      await app.inject({ method: "GET", url: `/auth/callback?code=c&state=${LOGIN_TOKEN}.n` });
      const res = await app.inject({ method: "GET", url: "/auth/status" });
      expect(res.json()).toEqual({ status: "ok", expires_at: "2026-09-09T12:00:00.000Z" });
      expect(res.body).not.toContain(ACCESS);
      expect(res.body).not.toContain(REFRESH);
      expect(res.body).not.toContain("SECRET");
      expect(res.headers["cache-control"]).toBe("no-store");
    });
  });
});
