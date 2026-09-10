import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type App } from "../../app.js";
import { testConfig } from "../../test-support/config.js";
import { CapturingLogger } from "../../test-support/logger.js";

const SECRET = "current-secret-0123456789abcdef";
const PREVIOUS = "previous-secret-0123456789abcdef";

describe("shared-secret gate", () => {
  let app: App;
  let logs: CapturingLogger;

  beforeEach(async () => {
    logs = new CapturingLogger();
    app = await buildApp({
      config: testConfig({ sharedSecrets: [SECRET, PREVIOUS] }),
      logger: logs,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns 401 without the secret header and logs no body fields", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/tools/verify_caller",
      payload: { conversation_id: "conv_1234567890", digits: "1234" },
    });
    expect(res.statusCode).toBe(401);
    expect(logs.text()).not.toContain("1234");
    expect(logs.text()).not.toContain("digits");
  });

  it("returns 401 with a wrong secret", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/tools/verify_caller",
      headers: { "x-helpdesk-secret": "nope" },
      payload: { conversation_id: "conv_1234567890", digits: "1234" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts the previous secret during rotation", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/tools/verify_caller",
      headers: { "x-helpdesk-secret": PREVIOUS },
      payload: { conversation_id: "conv_1234567890", digits: "" },
    });
    expect(res.statusCode).not.toBe(401);
  });

  it("serves the health route without a secret", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("rejects a body over 16 KB on tool routes", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/tools/verify_caller",
      headers: { "x-helpdesk-secret": SECRET },
      payload: { conversation_id: "conv_1234567890", digits: "x".repeat(17_000) },
    });
    expect(res.statusCode).toBe(413);
  });

  it("rejects a non-JSON content type on tool routes", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/tools/verify_caller",
      headers: { "x-helpdesk-secret": SECRET, "content-type": "text/plain" },
      payload: "conversation_id=conv_1234567890",
    });
    expect(res.statusCode).toBe(415);
  });

  it("never logs the digits value on an authenticated verify call", async () => {
    await app.inject({
      method: "POST",
      url: "/tools/verify_caller",
      headers: { "x-helpdesk-secret": SECRET },
      payload: { conversation_id: "conv_1234567890", digits: "9876" },
    });
    expect(logs.text()).not.toContain("9876");
  });
});
