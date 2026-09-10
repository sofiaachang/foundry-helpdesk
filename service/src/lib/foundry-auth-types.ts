// Types shared between the composition root, the auth routes, and the Foundry
// auth implementation. Routes import only this module (never foundry/*), so the
// disclosure guard in scripts/check-no-disclosure.sh keeps holding.

export type FoundryAuthStatus = "logged_out" | "ok" | "expired";

export type FoundryAuthErrorCategory =
  | "logged_out"
  | "state_mismatch"
  | "exchange_failed"
  | "refresh_failed"
  | "network"
  | "malformed_response";

/**
 * The only error the auth layer throws. It carries a category and, when the
 * token endpoint answered, the HTTP status. It never carries a token value, a
 * response body, or an OAuth error_description.
 */
export class FoundryAuthError extends Error {
  readonly category: FoundryAuthErrorCategory;
  readonly httpStatus: number | undefined;

  constructor(category: FoundryAuthErrorCategory, httpStatus?: number) {
    super(httpStatus === undefined ? `Foundry auth ${category}` : `Foundry auth ${category} (HTTP ${httpStatus})`);
    this.name = "FoundryAuthError";
    this.category = category;
    this.httpStatus = httpStatus;
  }
}

export interface FoundryAuthStatusReport {
  status: FoundryAuthStatus;
  /** ISO timestamp of the access token expiry, when one is held. Never a token. */
  expiresAt: string | null;
}

/** What the routes and the adapter need from the delegated-user auth holder. */
export interface FoundryAuth {
  /** Returns the Multipass authorize URL to redirect the browser to; stores verifier and state. */
  beginLogin(): string;
  /** Exchanges the authorization code. Rejects with `state_mismatch` before any network call if the state is wrong. */
  completeLogin(code: string, state: string): Promise<void>;
  /** A currently valid access token, refreshing first when close to expiry. */
  getToken(): Promise<string>;
  /**
   * Refreshes now regardless of expiry, sharing any in-flight exchange. The
   * adapter calls it after a 401 so the single retry carries a new token
   * rather than the cached one getToken() would hand back again.
   */
  forceRefresh(): Promise<void>;
  status(): FoundryAuthStatusReport;
}
