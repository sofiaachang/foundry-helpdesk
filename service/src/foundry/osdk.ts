// The osdk slot before the generated SDK exists (plan U8, gates G1 and G3).
//
// NOTHING IN THIS FILE TALKS TO FOUNDRY. `NotReadyFoundryAdapter` is a
// placeholder that lets a deploy selecting FOUNDRY_ADAPTER=osdk boot far enough
// to serve /health and the one-time login routes (/auth/start, /auth/callback,
// /auth/status), while every tool call fails closed: each adapter method
// rejects with FoundryNotReadyError, which the handlers map to the contract's
// failed envelope (status "failed", escalate true, no error text).
//
// U8 replaces this class with the real adapter built on the generated OSDK
// package from the Developer Console app (plan KTD3):
//
//   import { createClient } from "@osdk/client";
//   const client = createClient(config.foundry.stackUrl, config.foundry.ontologyRid, tokenProvider(auth));
//
// `createClient` accepts a `() => Promise<string>` token provider and calls it
// per request, so the delegated user's access token is refreshed by
// FoundryDelegatedAuth and never copied into the client. `tokenProvider` is
// kept here so U8 only swaps the class.

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

export type TokenProvider = () => Promise<string>;

/** Adapts the delegated-user auth holder to the token-provider shape `@osdk/client` expects. */
export function tokenProvider(auth: FoundryAuth): TokenProvider {
  return () => auth.getToken();
}

/**
 * Thrown by every method of the placeholder adapter. Carries no detail beyond
 * its name: the handlers log `error.name` and return the failed envelope.
 */
export class FoundryNotReadyError extends Error {
  constructor() {
    super("Foundry adapter is not ready (generated SDK not installed; plan U8)");
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
      { event: "foundry_adapter_not_ready", adapter: "osdk-not-ready" },
      "FOUNDRY_ADAPTER=osdk selected but the generated SDK is not installed (plan U8); tool calls fail closed, /auth/* and /health work",
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
