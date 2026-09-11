// Fixture routes: only lib/ and types are imported; the adapter arrives as an option.
import type { VerifiedSession } from "../lib/tiers.js";

export interface RouteOptions {
  getIssue: (session: VerifiedSession, issueId: string) => Promise<unknown>;
}

export function register(opts: RouteOptions): RouteOptions {
  return opts;
}
