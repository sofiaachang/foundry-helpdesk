// The production pino options against the installed fastify and pino: the
// "incoming request" line must carry the path only, never the query string,
// because /auth/callback receives the authorization code in the query.

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type App } from "../../app.js";
import { pinoOptions, requestLogUrl } from "../log.js";
import { testConfig } from "../../test-support/config.js";

describe("requestLogUrl", () => {
  it("drops the query string and keeps the path", () => {
    expect(requestLogUrl("/auth/callback?code=abc&state=xyz")).toBe("/auth/callback");
    expect(requestLogUrl("/health")).toBe("/health");
    expect(requestLogUrl(undefined)).toBe("");
  });
});

describe("pinoOptions req serializer", () => {
  let app: App | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("logs the request path without its query string through real fastify and pino", async () => {
    const lines: string[] = [];
    const logger = pino(pinoOptions("info"), { write: (line: string) => void lines.push(line) });
    app = await buildApp({ config: testConfig(), logger });

    const res = await app.inject({ method: "GET", url: "/health?code=SECRET-QUERY-VALUE&t=SECRET-TOKEN" });
    expect(res.statusCode).toBe(200);

    const text = lines.join("");
    expect(text).toContain("incoming request");
    expect(text).toContain('"url":"/health"');
    expect(text).not.toContain("SECRET-QUERY-VALUE");
    expect(text).not.toContain("SECRET-TOKEN");
  });

  it("answers an unknown path with 404 and never logs its query string", async () => {
    const lines: string[] = [];
    const logger = pino(pinoOptions("info"), { write: (line: string) => void lines.push(line) });
    app = await buildApp({ config: testConfig(), logger });

    // A trailing-slash typo on the callback is a 404, and Fastify's default
    // not-found handler would log the full URL, code and state included.
    const res = await app.inject({ method: "GET", url: "/auth/callback/?code=SECRET-CODE&state=SECRET-STATE" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not found" });

    const text = lines.join("");
    expect(text).not.toContain("SECRET-CODE");
    expect(text).not.toContain("SECRET-STATE");
    expect(text).not.toContain("code=");
  });

  it("logs only the path when a route throws with a query string present", async () => {
    const lines: string[] = [];
    const logger = pino(pinoOptions("info"), { write: (line: string) => void lines.push(line) });
    app = await buildApp({
      config: testConfig(),
      logger,
      extraRoutes: [
        async (instance) => {
          instance.get("/boom", async () => {
            throw new Error("SECRET-ERROR-MESSAGE");
          });
        },
      ],
    });

    const res = await app.inject({ method: "GET", url: "/boom?code=SECRET-CODE&state=SECRET-STATE" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "failed", escalate: true });

    const text = lines.join("");
    expect(text).toContain("unhandled_error");
    expect(text).toContain('"url":"/boom"');
    expect(text).not.toContain("SECRET-CODE");
    expect(text).not.toContain("SECRET-STATE");
    expect(text).not.toContain("SECRET-ERROR-MESSAGE");
  });
});
