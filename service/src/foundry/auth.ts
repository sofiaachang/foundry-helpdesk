// Delegated-user OAuth2 for Foundry (plan KTD3). The zap enrollment offers no
// client-credentials grant, so the service acts as the human who logged in
// once: authorization-code grant with PKCE from a public client, plus
// `offline_access` for a refresh token that the service rotates unattended.
//
// Protocol per ../../Raava Training Program/knowledge-base/foundry/
// platform-security-third-party/writing-oauth2-clients.md:
//   GET  {stack}/multipass/api/oauth2/authorize  (response_type=code, client_id,
//        redirect_uri, scope, state, code_challenge, code_challenge_method=S256)
//   POST {stack}/multipass/api/oauth2/token      (application/x-www-form-urlencoded;
//        grant_type=authorization_code|refresh_token, client_id, code+redirect_uri+
//        code_verifier, or refresh_token; no client_secret for a public client)
//   Foundry rotates the refresh token on every use, tolerates reuse for one
//   minute, and invalidates refresh tokens idle for 30 days.
//
// Tokens live in memory only. Railway's disk is ephemeral, so a restart means
// one more click through /auth/start. Nothing in this module logs; the only
// error it throws carries a category and an HTTP status, never a token or a
// response body.

import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { constantTimeEqual } from "../lib/compare.js";
import {
  FoundryAuthError,
  type FoundryAuth,
  type FoundryAuthStatus,
  type FoundryAuthStatusReport,
} from "../lib/foundry-auth-types.js";

/**
 * Scopes for a Developer Console client-facing application: the `api:use-*`
 * form is what restricted Developer Console apps are granted (application-
 * restrictions.md); `offline_access` is what yields the refresh token.
 */
export const DEFAULT_SCOPES = ["api:use-ontologies-read", "api:use-ontologies-write", "offline_access"] as const;

/** Refresh when the access token has less than this long to live. */
export const REFRESH_WINDOW_MS = 60_000;

/**
 * Bound on one token-endpoint exchange. Every tool call joins the single
 * in-flight refresh, so a Multipass request that connects and never answers
 * would otherwise hold every tool for undici's default headers timeout.
 */
export const DEFAULT_TOKEN_TIMEOUT_MS = 10_000;

export interface FoundryDelegatedAuthOptions {
  stackUrl: string;
  clientId: string;
  redirectUrl: string;
  scopes?: readonly string[];
  fetch?: typeof fetch;
  clock?: () => number;
  randomBytes?: (n: number) => Buffer;
  /** Abort a token-endpoint exchange after this long; defaults to DEFAULT_TOKEN_TIMEOUT_MS. */
  timeoutMs?: number;
}

interface PendingLogin {
  verifier: string;
  state: string;
}

interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** Token-endpoint statuses that mean the grant itself is gone, not that the attempt should be retried. */
const TERMINAL_REFRESH_STATUSES: ReadonlySet<number> = new Set([400, 401, 403]);

function isTerminalRefreshStatus(status: number | undefined): boolean {
  return status !== undefined && TERMINAL_REFRESH_STATUSES.has(status);
}

export class FoundryDelegatedAuth implements FoundryAuth {
  private readonly authorizeUrl: string;
  private readonly tokenUrl: string;
  private readonly clientId: string;
  private readonly redirectUrl: string;
  private readonly scope: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;
  private readonly randomBytes: (n: number) => Buffer;
  private readonly timeoutMs: number;

  private pending: PendingLogin | null = null;
  private tokens: TokenSet | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(opts: FoundryDelegatedAuthOptions) {
    const base = opts.stackUrl.replace(/\/+$/, "");
    this.authorizeUrl = `${base}/multipass/api/oauth2/authorize`;
    this.tokenUrl = `${base}/multipass/api/oauth2/token`;
    this.clientId = opts.clientId;
    this.redirectUrl = opts.redirectUrl;
    this.scope = (opts.scopes ?? DEFAULT_SCOPES).join(" ");
    this.fetchImpl = opts.fetch ?? fetch;
    this.clock = opts.clock ?? (() => Date.now());
    this.randomBytes = opts.randomBytes ?? nodeRandomBytes;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS;
  }

  beginLogin(): string {
    // 32 random bytes -> 43 base64url characters, inside the 43..128 range the
    // doc requires and drawn only from its allowed alphabet.
    const verifier = b64url(this.randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    // The state is randomness only. It travels in the authorize URL and back
    // in the callback URL, so it must carry no secret: the server-held copy
    // (compared whole, in constant time, in completeLogin) is what binds the
    // callback to this login. The login token that gates /auth/start stays
    // out of every URL past that route.
    const state = b64url(this.randomBytes(32));
    this.pending = { verifier, state };

    const url = new URL(this.authorizeUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUrl);
    url.searchParams.set("scope", this.scope);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async completeLogin(code: string, state: string): Promise<void> {
    const pending = this.pending;
    if (!pending || !constantTimeEqual(Buffer.from(pending.state, "utf8"), Buffer.from(state, "utf8"))) {
      throw new FoundryAuthError("state_mismatch");
    }
    // One-shot: a replayed callback cannot reuse the verifier.
    this.pending = null;

    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUrl,
      client_id: this.clientId,
      code_verifier: pending.verifier,
    });
    this.tokens = await this.postToken(form, "exchange_failed");
  }

  async getToken(): Promise<string> {
    const current = this.tokens;
    if (!current) throw new FoundryAuthError("logged_out");
    if (current.expiresAt - this.clock() > REFRESH_WINDOW_MS) return current.accessToken;

    // Serialise refreshes: the refresh token rotates on every use, so N
    // concurrent callers must share one exchange rather than race with it.
    if (!this.refreshing) {
      this.refreshing = this.refresh().finally(() => {
        this.refreshing = null;
      });
    }
    await this.refreshing;

    const fresh = this.tokens;
    if (!fresh) throw new FoundryAuthError("logged_out");
    return fresh.accessToken;
  }

  /**
   * Refreshes now, regardless of expiry, sharing the in-flight exchange with
   * any concurrent getToken(). Exists for the U1 probe (`--refresh-test`) so
   * rotation can be observed without waiting for the access token to age.
   */
  async forceRefresh(): Promise<void> {
    if (!this.tokens) throw new FoundryAuthError("logged_out");
    if (!this.refreshing) {
      this.refreshing = this.refresh().finally(() => {
        this.refreshing = null;
      });
    }
    await this.refreshing;
  }

  status(): FoundryAuthStatusReport {
    const t = this.tokens;
    if (!t) return { status: "logged_out", expiresAt: null };
    const status: FoundryAuthStatus = this.clock() >= t.expiresAt ? "expired" : "ok";
    return { status, expiresAt: new Date(t.expiresAt).toISOString() };
  }

  private async refresh(): Promise<void> {
    const current = this.tokens;
    if (!current?.refreshToken) {
      this.tokens = null;
      throw new FoundryAuthError("logged_out");
    }
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: this.clientId,
    });
    try {
      const next = await this.postToken(form, "refresh_failed");
      // Foundry rotates the refresh token; if a response ever omits it, keep
      // the previous one rather than dropping to logged_out. Both writes below
      // are guarded by identity on the token set this refresh started from: a
      // login that completed while the exchange was in flight owns `tokens`
      // now, and neither a late success nor a failure of the old grant may
      // replace it.
      if (this.tokens === current) {
        this.tokens = { ...next, refreshToken: next.refreshToken ?? current.refreshToken };
      }
    } catch (error) {
      // 400/401/403 from the token endpoint means the grant is gone (revoked,
      // reused after the grace period, idle past 30 days, or otherwise
      // rejected). Any other status, including 429, and a network failure
      // leave the grant intact for the next attempt.
      if (error instanceof FoundryAuthError && isTerminalRefreshStatus(error.httpStatus) && this.tokens === current) {
        this.tokens = null;
      }
      throw error;
    }
  }

  private async postToken(form: URLSearchParams, failure: "exchange_failed" | "refresh_failed"): Promise<TokenSet> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: form.toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // A thrown fetch, including the TimeoutError/AbortError from the signal,
      // is `network`: Foundry never answered, so the grant is kept for the
      // next attempt.
      throw new FoundryAuthError("network");
    }
    if (!response.ok) throw new FoundryAuthError(failure, response.status);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new FoundryAuthError("malformed_response", response.status);
    }
    const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const accessToken = record.access_token;
    const expiresIn = Number(record.expires_in);
    const refreshToken = record.refresh_token;
    if (typeof accessToken !== "string" || accessToken.length === 0 || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new FoundryAuthError("malformed_response", response.status);
    }
    return {
      accessToken,
      refreshToken: typeof refreshToken === "string" && refreshToken.length > 0 ? refreshToken : null,
      expiresAt: this.clock() + expiresIn * 1000,
    };
  }
}
