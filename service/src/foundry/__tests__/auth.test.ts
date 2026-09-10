// FoundryDelegatedAuth against a fake token endpoint. Protocol per the
// Multipass OAuth2 doc: authorize at /multipass/api/oauth2/authorize, token at
// /multipass/api/oauth2/token (form-encoded), PKCE S256, refresh tokens rotate.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FoundryDelegatedAuth } from "../auth.js";
import { FoundryAuthError } from "../../lib/foundry-auth-types.js";

const STACK = "https://zap.usw-18.palantirfoundry.com";
const CLIENT_ID = "client-abc";
const REDIRECT = "http://localhost:3000/auth/callback";
const LOGIN_TOKEN = "login-token-0123456789abcdefghij";
const ACCESS_1 = "access-token-one-SECRET";
const ACCESS_2 = "access-token-two-SECRET";
const REFRESH_1 = "refresh-token-one-SECRET";
const REFRESH_2 = "refresh-token-two-SECRET";

interface Call {
  url: string;
  method: string;
  contentType: string | undefined;
  form: URLSearchParams;
  signal: AbortSignal | null | undefined;
}

type Handler = (call: Call) => Response | Promise<Response>;

function fakeFetch(handler: Handler): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      contentType: headers.get("content-type") ?? undefined,
      form: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
      signal: init?.signal,
    };
    calls.push(call);
    return handler(call);
  };
  return { calls, fetch: impl as typeof fetch };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function tokenBody(access: string, refresh: string, expiresIn = 3600): Record<string, unknown> {
  return { access_token: access, token_type: "bearer", expires_in: expiresIn, refresh_token: refresh };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function fixedRandom(fill: number): (n: number) => Buffer {
  return (n) => Buffer.alloc(n, fill);
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function build(handler: Handler, opts: { now?: () => number; random?: (n: number) => Buffer; timeoutMs?: number } = {}) {
  const ff = fakeFetch(handler);
  const auth = new FoundryDelegatedAuth({
    stackUrl: STACK,
    clientId: CLIENT_ID,
    redirectUrl: REDIRECT,
    fetch: ff.fetch,
    clock: opts.now ?? (() => 1_000_000_000),
    randomBytes: opts.random ?? fixedRandom(7),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });
  return { auth, calls: ff.calls };
}

async function login(auth: FoundryDelegatedAuth): Promise<void> {
  const url = new URL(auth.beginLogin());
  const state = url.searchParams.get("state");
  if (!state) throw new Error("no state in authorize URL");
  await auth.completeLogin("code-xyz", state);
}

describe("FoundryDelegatedAuth.beginLogin", () => {
  it("builds the authorize URL with PKCE S256, offline_access, redirect, and an opaque random state", () => {
    const { auth } = build(() => json({}), { random: fixedRandom(7) });
    const url = new URL(auth.beginLogin());

    expect(url.origin + url.pathname).toBe(`${STACK}/multipass/api/oauth2/authorize`);
    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe(CLIENT_ID);
    expect(p.get("redirect_uri")).toBe(REDIRECT);
    expect(p.get("code_challenge_method")).toBe("S256");

    const scopes = (p.get("scope") ?? "").split(" ");
    expect(scopes).toContain("offline_access");
    expect(scopes).toContain("api:use-ontologies-read");
    expect(scopes).toContain("api:use-ontologies-write");

    // The verifier is base64url of the injected random bytes; the challenge is
    // base64url(sha256(verifier)) without padding.
    const verifier = b64url(Buffer.alloc(32, 7));
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    const expectedChallenge = b64url(createHash("sha256").update(verifier).digest());
    expect(p.get("code_challenge")).toBe(expectedChallenge);
    expect(p.get("code_challenge")).not.toContain("=");

    // The state is randomness only: it must never carry the login token,
    // because it rides in the authorize URL and the callback URL (Foundry's
    // logs, browser history, the platform edge).
    const state = p.get("state") ?? "";
    expect(state).toBe(b64url(Buffer.alloc(32, 7)));
    expect(state).not.toContain(LOGIN_TOKEN);
    expect(state).not.toContain(".");
    expect(url.toString()).not.toContain(LOGIN_TOKEN);
  });

  it("issues a different state per login and distinct from the verifier material", () => {
    let n = 0;
    const { auth } = build(() => json({}), { random: (size) => Buffer.alloc(size, (n += 1)) });
    const first = new URL(auth.beginLogin()).searchParams.get("state");
    const second = new URL(auth.beginLogin()).searchParams.get("state");
    expect(first).not.toBe(second);
    expect(first?.length).toBeGreaterThanOrEqual(43);
  });

  it("starts logged out", () => {
    const { auth } = build(() => json({}));
    expect(auth.status()).toEqual({ status: "logged_out", expiresAt: null });
  });
});

describe("FoundryDelegatedAuth.completeLogin", () => {
  it("rejects a wrong state without calling the token endpoint", async () => {
    const { auth, calls } = build(() => json(tokenBody(ACCESS_1, REFRESH_1)));
    const state = new URL(auth.beginLogin()).searchParams.get("state")!;
    await expect(auth.completeLogin("code-xyz", `${state}x`)).rejects.toMatchObject({ category: "state_mismatch" });
    await expect(auth.completeLogin("code-xyz", state.slice(1))).rejects.toMatchObject({ category: "state_mismatch" });
    await expect(auth.completeLogin("code-xyz", `${LOGIN_TOKEN}.${state}`)).rejects.toMatchObject({ category: "state_mismatch" });
    expect(calls).toHaveLength(0);
    expect(auth.status().status).toBe("logged_out");
  });

  it("rejects a callback when no login was begun", async () => {
    const { auth, calls } = build(() => json(tokenBody(ACCESS_1, REFRESH_1)));
    await expect(auth.completeLogin("code-xyz", b64url(Buffer.alloc(32, 7)))).rejects.toMatchObject({ category: "state_mismatch" });
    expect(calls).toHaveLength(0);
  });

  it("exchanges the code with the stored verifier and stores the tokens", async () => {
    const { auth, calls } = build(() => json(tokenBody(ACCESS_1, REFRESH_1, 3600)), { random: fixedRandom(9) });
    await login(auth);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${STACK}/multipass/api/oauth2/token`);
    expect(call.method).toBe("POST");
    expect(call.contentType).toBe("application/x-www-form-urlencoded");
    expect(call.form.get("grant_type")).toBe("authorization_code");
    expect(call.form.get("code")).toBe("code-xyz");
    expect(call.form.get("redirect_uri")).toBe(REDIRECT);
    expect(call.form.get("client_id")).toBe(CLIENT_ID);
    expect(call.form.get("code_verifier")).toBe(b64url(Buffer.alloc(32, 9)));
    expect(call.form.has("client_secret")).toBe(false);

    await expect(auth.getToken()).resolves.toBe(ACCESS_1);
    expect(auth.status()).toEqual({ status: "ok", expiresAt: new Date(1_000_000_000 + 3600_000).toISOString() });
    expect(calls).toHaveLength(1);
  });

  it("maps a failed exchange to exchange_failed with the HTTP status and no body text", async () => {
    const { auth } = build(() => json({ error: "invalid_grant", error_description: "SECRET-DESCRIPTION" }, 400));
    const url = new URL(auth.beginLogin());
    const state = url.searchParams.get("state")!;
    const err = await auth.completeLogin("bad-code", state).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FoundryAuthError);
    expect(err).toMatchObject({ category: "exchange_failed", httpStatus: 400 });
    expect((err as Error).message).not.toContain("SECRET-DESCRIPTION");
    expect(auth.status().status).toBe("logged_out");
  });

  it("rejects a 200 whose body lacks an access token as malformed_response", async () => {
    const { auth } = build(() => json({ token_type: "bearer" }));
    const state = new URL(auth.beginLogin()).searchParams.get("state")!;
    await expect(auth.completeLogin("code", state)).rejects.toMatchObject({ category: "malformed_response", httpStatus: 200 });
  });

  it("invalidates the verifier and state after one use", async () => {
    const { auth, calls } = build(() => json(tokenBody(ACCESS_1, REFRESH_1)));
    const state = new URL(auth.beginLogin()).searchParams.get("state")!;
    await auth.completeLogin("code", state);
    await expect(auth.completeLogin("code", state)).rejects.toMatchObject({ category: "state_mismatch" });
    expect(calls).toHaveLength(1);
  });
});

describe("FoundryDelegatedAuth.getToken", () => {
  it("throws logged_out before any login, without calling the network", async () => {
    const { auth, calls } = build(() => json({}));
    await expect(auth.getToken()).rejects.toMatchObject({ category: "logged_out" });
    expect(calls).toHaveLength(0);
  });

  it("refreshes once when within 60 seconds of expiry, even with five concurrent callers", async () => {
    let now = 1_000_000_000;
    const gate = deferred<void>();
    let refreshCount = 0;
    const { auth, calls } = build(
      async (call) => {
        if (call.form.get("grant_type") === "refresh_token") {
          refreshCount += 1;
          await gate.promise;
          return json(tokenBody(ACCESS_2, REFRESH_2, 3600));
        }
        return json(tokenBody(ACCESS_1, REFRESH_1, 3600));
      },
      { now: () => now },
    );
    await login(auth);

    // 3600 s lifetime; move to 30 s before expiry, inside the 60 s window.
    now += 3600_000 - 30_000;
    expect(auth.status().status).toBe("ok");

    const pending = Promise.all([auth.getToken(), auth.getToken(), auth.getToken(), auth.getToken(), auth.getToken()]);
    // Let the microtasks run so every caller has entered getToken before the gate opens.
    await new Promise((r) => setImmediate(r));
    expect(refreshCount).toBe(1);
    gate.resolve();

    const tokens = await pending;
    expect(tokens).toEqual([ACCESS_2, ACCESS_2, ACCESS_2, ACCESS_2, ACCESS_2]);
    expect(refreshCount).toBe(1);

    const refresh = calls.find((c) => c.form.get("grant_type") === "refresh_token")!;
    expect(refresh.form.get("refresh_token")).toBe(REFRESH_1);
    expect(refresh.form.get("client_id")).toBe(CLIENT_ID);
    expect(refresh.form.has("client_secret")).toBe(false);
  });

  it("uses the rotated refresh token on the next refresh", async () => {
    let now = 1_000_000_000;
    let n = 0;
    const { auth, calls } = build(
      (call) => {
        if (call.form.get("grant_type") === "refresh_token") {
          n += 1;
          return json(tokenBody(`access-${n}`, `refresh-${n}`, 3600));
        }
        return json(tokenBody(ACCESS_1, REFRESH_1, 3600));
      },
      { now: () => now },
    );
    await login(auth);

    now += 3600_000 + 1;
    expect(auth.status().status).toBe("expired");
    await expect(auth.getToken()).resolves.toBe("access-1");
    expect(auth.status().status).toBe("ok");

    now += 3600_000 + 1;
    await expect(auth.getToken()).resolves.toBe("access-2");

    const refreshes = calls.filter((c) => c.form.get("grant_type") === "refresh_token");
    expect(refreshes.map((c) => c.form.get("refresh_token"))).toEqual([REFRESH_1, "refresh-1"]);
  });

  it("moves to logged_out on a 401 refresh and throws a categorised error without token material", async () => {
    let now = 1_000_000_000;
    const { auth } = build(
      (call) => {
        if (call.form.get("grant_type") === "refresh_token") return json({ error: "invalid_grant" }, 401);
        return json(tokenBody(ACCESS_1, REFRESH_1, 3600));
      },
      { now: () => now },
    );
    await login(auth);
    now += 3600_000 + 1;

    const err = await auth.getToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FoundryAuthError);
    expect(err).toMatchObject({ category: "refresh_failed", httpStatus: 401 });
    const text = `${(err as Error).message} ${JSON.stringify(err)}`;
    expect(text).not.toContain(ACCESS_1);
    expect(text).not.toContain(REFRESH_1);
    expect(auth.status()).toEqual({ status: "logged_out", expiresAt: null });

    // After the 401 the next call fails fast as logged_out, without a network call.
    await expect(auth.getToken()).rejects.toMatchObject({ category: "logged_out" });
  });

  it("keeps the refresh token on a 5xx so the next call can retry", async () => {
    let now = 1_000_000_000;
    let fail = true;
    const { auth, calls } = build(
      (call) => {
        if (call.form.get("grant_type") === "refresh_token") {
          if (fail) return json({ error: "server_error" }, 503);
          return json(tokenBody(ACCESS_2, REFRESH_2, 3600));
        }
        return json(tokenBody(ACCESS_1, REFRESH_1, 3600));
      },
      { now: () => now },
    );
    await login(auth);
    now += 3600_000 + 1;

    await expect(auth.getToken()).rejects.toMatchObject({ category: "refresh_failed", httpStatus: 503 });
    expect(auth.status().status).toBe("expired");

    fail = false;
    await expect(auth.getToken()).resolves.toBe(ACCESS_2);
    const refreshes = calls.filter((c) => c.form.get("grant_type") === "refresh_token");
    expect(refreshes.map((c) => c.form.get("refresh_token"))).toEqual([REFRESH_1, REFRESH_1]);
  });

  it("passes an abort signal to the token endpoint and maps a stalled exchange to network, keeping the grant", async () => {
    let now = 1_000_000_000;
    let signal: AbortSignal | null | undefined;
    const { auth, calls } = build(
      (call) => {
        if (call.form.get("grant_type") !== "refresh_token") return json(tokenBody(ACCESS_1, REFRESH_1, 3600));
        // Never answers; only the signal can end the call, like a real fetch.
        signal = call.signal;
        return new Promise<Response>((_resolve, reject) => {
          if (!signal) return;
          signal.addEventListener("abort", () => reject(signal!.reason), { once: true });
        });
      },
      { now: () => now, timeoutMs: 20 },
    );
    await login(auth);
    now += 3600_000 + 1;

    const err = await auth.getToken().catch((e: unknown) => e);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(true);
    expect(err).toBeInstanceOf(FoundryAuthError);
    expect(err).toMatchObject({ category: "network", httpStatus: undefined });
    expect(auth.status().status).toBe("expired");
    expect(calls.filter((c) => c.form.get("grant_type") === "refresh_token")).toHaveLength(1);
  });

  it("keeps the grant on a 429 from the token endpoint so the next call can retry", async () => {
    let now = 1_000_000_000;
    let limited = true;
    const { auth, calls } = build(
      (call) => {
        if (call.form.get("grant_type") === "refresh_token") {
          if (limited) return json({ error: "rate_limited" }, 429);
          return json(tokenBody(ACCESS_2, REFRESH_2, 3600));
        }
        return json(tokenBody(ACCESS_1, REFRESH_1, 3600));
      },
      { now: () => now },
    );
    await login(auth);
    now += 3600_000 + 1;

    await expect(auth.getToken()).rejects.toMatchObject({ category: "refresh_failed", httpStatus: 429 });
    expect(auth.status().status).toBe("expired");

    limited = false;
    await expect(auth.getToken()).resolves.toBe(ACCESS_2);
    const refreshes = calls.filter((c) => c.form.get("grant_type") === "refresh_token");
    expect(refreshes.map((c) => c.form.get("refresh_token"))).toEqual([REFRESH_1, REFRESH_1]);
  });

  it("moves to logged_out only on 400, 401, and 403 from the token endpoint", async () => {
    for (const status of [400, 401, 403]) {
      let now = 1_000_000_000;
      const { auth } = build(
        (call) => (call.form.get("grant_type") === "refresh_token" ? json({ error: "invalid_grant" }, status) : json(tokenBody(ACCESS_1, REFRESH_1, 3600))),
        { now: () => now },
      );
      await login(auth);
      now += 3600_000 + 1;
      await expect(auth.getToken()).rejects.toMatchObject({ category: "refresh_failed", httpStatus: status });
      expect(auth.status().status).toBe("logged_out");
    }
    for (const status of [404, 408, 429, 503]) {
      let now = 1_000_000_000;
      const { auth } = build(
        (call) => (call.form.get("grant_type") === "refresh_token" ? json({ error: "whatever" }, status) : json(tokenBody(ACCESS_1, REFRESH_1, 3600))),
        { now: () => now },
      );
      await login(auth);
      now += 3600_000 + 1;
      await expect(auth.getToken()).rejects.toMatchObject({ category: "refresh_failed", httpStatus: status });
      expect(auth.status().status).toBe("expired");
    }
  });

  it("does not discard a login that completed while a refresh was in flight, even when that refresh then fails 400", async () => {
    let now = 1_000_000_000;
    const gate = deferred<Response>();
    const { auth } = build(
      async (call) => {
        if (call.form.get("grant_type") === "refresh_token") return gate.promise;
        // First login yields the first token set, the re-login a second one.
        return json(tokenBody(call.form.get("code") === "code-two" ? ACCESS_2 : ACCESS_1, call.form.get("code") === "code-two" ? REFRESH_2 : REFRESH_1, 3600));
      },
      { now: () => now },
    );
    await login(auth);
    now += 3600_000 + 1;

    const pendingRefresh = auth.getToken();
    await new Promise((r) => setImmediate(r));

    // A human re-logs in while the refresh is stuck.
    const state = new URL(auth.beginLogin()).searchParams.get("state")!;
    await auth.completeLogin("code-two", state);
    expect(auth.status().status).toBe("ok");

    gate.resolve(json({ error: "invalid_grant" }, 400));
    await expect(pendingRefresh).rejects.toMatchObject({ category: "refresh_failed", httpStatus: 400 });

    // The new login survives the old grant's failure.
    expect(auth.status().status).toBe("ok");
    await expect(auth.getToken()).resolves.toBe(ACCESS_2);
  });

  it("does not let a refresh that succeeds late overwrite a login that completed meanwhile", async () => {
    let now = 1_000_000_000;
    const gate = deferred<Response>();
    const { auth } = build(
      async (call) => {
        if (call.form.get("grant_type") === "refresh_token") return gate.promise;
        return json(tokenBody(call.form.get("code") === "code-two" ? ACCESS_2 : ACCESS_1, call.form.get("code") === "code-two" ? REFRESH_2 : REFRESH_1, 3600));
      },
      { now: () => now },
    );
    await login(auth);
    now += 3600_000 + 1;
    const pendingRefresh = auth.getToken();
    await new Promise((r) => setImmediate(r));

    const state = new URL(auth.beginLogin()).searchParams.get("state")!;
    await auth.completeLogin("code-two", state);

    gate.resolve(json(tokenBody("access-stale-SECRET", "refresh-stale-SECRET", 3600)));
    await expect(pendingRefresh).resolves.toBe(ACCESS_2);
    await expect(auth.getToken()).resolves.toBe(ACCESS_2);
  });

  it("maps a thrown fetch to category network with no status", async () => {
    let now = 1_000_000_000;
    const { auth } = build(
      (call) => {
        if (call.form.get("grant_type") === "refresh_token") throw new TypeError("fetch failed");
        return json(tokenBody(ACCESS_1, REFRESH_1, 3600));
      },
      { now: () => now },
    );
    await login(auth);
    now += 3600_000 + 1;
    await expect(auth.getToken()).rejects.toMatchObject({ category: "network", httpStatus: undefined });
    expect(auth.status().status).toBe("expired");
  });
});

describe("FoundryDelegatedAuth.forceRefresh", () => {
  it("refreshes regardless of expiry, rotates the refresh token, and shares one exchange with getToken", async () => {
    let n = 0;
    const { auth, calls } = build((call) => {
      if (call.form.get("grant_type") === "authorization_code") return json(tokenBody(ACCESS_1, REFRESH_1, 3600));
      if (call.form.get("grant_type") === "refresh_token") {
        n += 1;
        return json(tokenBody(`access-${n}`, `refresh-${n}`, 3600));
      }
      return json({}, 500);
    });
    await login(auth);
    // Far from expiry: getToken alone would not refresh.
    await expect(auth.getToken()).resolves.toBe(ACCESS_1);

    await auth.forceRefresh();
    await expect(auth.getToken()).resolves.toBe("access-1");
    await auth.forceRefresh();
    await expect(auth.getToken()).resolves.toBe("access-2");

    const refreshes = calls.filter((c) => c.form.get("grant_type") === "refresh_token");
    expect(refreshes.map((c) => c.form.get("refresh_token"))).toEqual([REFRESH_1, "refresh-1"]);
  });

  it("throws logged_out before login and surfaces a categorised error on a 4xx", async () => {
    const { auth } = build((call) => {
      if (call.form.get("grant_type") === "authorization_code") return json(tokenBody(ACCESS_1, REFRESH_1, 3600));
      return json({ error: "invalid_grant" }, 400);
    });
    await expect(auth.forceRefresh()).rejects.toMatchObject({ category: "logged_out" });
    await login(auth);
    await expect(auth.forceRefresh()).rejects.toMatchObject({ category: "refresh_failed", httpStatus: 400 });
    expect(auth.status().status).toBe("logged_out");
  });
});
