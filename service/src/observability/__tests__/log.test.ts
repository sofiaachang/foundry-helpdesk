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
});
