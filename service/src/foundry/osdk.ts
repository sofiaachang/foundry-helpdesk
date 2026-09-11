// The adapter factory and the not-ready placeholder (plan U8, gates G1 and G3).
//
// `createFoundryAdapter` picks the implementation for the two Foundry-backed
// modes: "foundry" builds RestFoundryAdapter (rest.ts) over the delegated
// user token, "not-ready" builds NotReadyFoundryAdapter. The fake adapter is
// wired directly in server.ts because it needs no auth.
//
// NOTHING IN NotReadyFoundryAdapter TALKS TO FOUNDRY. It lets a deploy that
// selects FOUNDRY_ADAPTER=not-ready boot far enough to serve /health and the
// one-time login routes (/auth/start, /auth/callback, /auth/status), while
// every tool call fails closed: each adapter method rejects with
// FoundryNotReadyError, which the handlers map to the contract's failed
// envelope (status "failed", escalate true, no error text). It is for the
// pre-U3 deploy and the route tests only.
//
// `tokenProvider` adapts the auth holder to the `{ getToken, refresh }` pair
// RestFoundryAdapter takes (a future generated `@osdk/client` accepts the
// `getToken` half), so the delegated user's access token is read per request
// and never copied, and a 401 can force a refresh before the one retry.

import type { Config } from "../config.js";
import type { FoundryAuth } from "../lib/foundry-auth-types.js";
import type { SimilarCandidate } from "../lib/similarity.js";
import type { VerifiedSession } from "../lib/tiers.js";
import type {
  CreateIssueInput,
  CreateIssueResult,
  FoundryAdapter,
  IssueDetail,
  IssueSummary,
  TeamQueue,
  UserLookup,
} from "./adapter.js";

import { RestFoundryAdapter, type TokenSource } from "./rest.js";

export type TokenProvider = TokenSource;

/** Adapts the delegated-user auth holder to the per-request token source the adapter takes. */
export function tokenProvider(auth: FoundryAuth): TokenProvider {
  return {
    getToken: () => auth.getToken(),
    refresh: () => auth.forceRefresh(),
  };
}

/** The Foundry-backed adapter for the configured mode. Throws for "fake", which server.ts wires without auth. */
export function createFoundryAdapter(config: Config, auth: FoundryAuth, logger: NotReadyLogger): FoundryAdapter {
  switch (config.adapter) {
    case "foundry":
      return new RestFoundryAdapter({
        stackUrl: config.foundry.stackUrl,
        ontology: config.foundry.ontologyRid,
        names: config.ontologyNames,
        tokens: tokenProvider(auth),
        logger,
      });
    case "not-ready":
      return new NotReadyFoundryAdapter(logger);
    case "fake":
      throw new Error("createFoundryAdapter does not build the fake adapter");
  }
}

/**
 * Thrown by every method of the placeholder adapter. Carries no detail beyond
 * its name: the handlers log `error.name` and return the failed envelope.
 */
export class FoundryNotReadyError extends Error {
  constructor() {
    super("Foundry adapter is not ready (FOUNDRY_ADAPTER=not-ready)");
    this.name = "FoundryNotReadyError";
  }
}

/** The one log call this module makes; pino and the test logger both satisfy it. */
export interface NotReadyLogger {
  warn(fields: Record<string, unknown>, message?: string): void;
}

export interface NotReadyFoundryAdapterOptions {
  /**
   * Optional delegate for the pre-verification user lookup only. Lets the
   * verification flow be exercised (tests, local rehearsal) while every
   * session-bearing read and write still fails closed. Never wired in server.ts.
   */
  userLookup?: UserLookup;
}

export class NotReadyFoundryAdapter implements FoundryAdapter {
  private readonly userLookup: UserLookup | undefined;

  constructor(logger: NotReadyLogger, opts: NotReadyFoundryAdapterOptions = {}) {
    this.userLookup = opts.userLookup;
    logger.warn(
      { event: "foundry_adapter_not_ready", adapter: "not-ready" },
      "FOUNDRY_ADAPTER=not-ready selected; tool calls fail closed, /auth/* and /health work",
    );
  }

  async findUserByPhone(phoneE164: string): Promise<{ userId: string; fullName: string; pinHash: string; siteId: string } | null> {
    if (this.userLookup) return this.userLookup.findUserByPhone(phoneE164);
    throw new FoundryNotReadyError();
  }

  async getIssue(_session: VerifiedSession, _issueId: string): Promise<IssueDetail | null> {
    throw new FoundryNotReadyError();
  }

  async listOpenIssuesForUser(_session: VerifiedSession): Promise<{ count: number; top: IssueSummary[] }> {
    throw new FoundryNotReadyError();
  }

  async getTeamQueueForIssue(_session: VerifiedSession, _issueId: string): Promise<TeamQueue | null> {
    throw new FoundryNotReadyError();
  }

  async countOpenIssuesAtSite(_session: VerifiedSession): Promise<{ siteName: string; openCount: number }> {
    throw new FoundryNotReadyError();
  }

  async findResolvedIssuesMatching(_session: VerifiedSession, _terms: string[]): Promise<SimilarCandidate[]> {
    throw new FoundryNotReadyError();
  }

  async createIssue(_session: VerifiedSession, _input: CreateIssueInput): Promise<CreateIssueResult> {
    throw new FoundryNotReadyError();
  }
}
