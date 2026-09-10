// Tool tier registry and the gate every tier-1 tool passes through (KTD5).
// The gate is the only code that can mint a VerifiedSession, and the Foundry
// adapter accepts nothing else, so a route cannot reach Foundry unverified no
// matter what the prompt says. scripts/check-no-disclosure.sh checks the
// import boundary that keeps this true.

import type { SessionStore } from "./sessions.js";
import { TOOL_NAMES, type ToolName } from "./types.js";

declare const verifiedBrand: unique symbol;

/**
 * A session the tier gate has checked. Only `gate` constructs one; there is no
 * exported constructor, and the brand is a module-private symbol.
 */
export interface VerifiedSession {
  readonly [verifiedBrand]: true;
  readonly conversationId: string;
  readonly userId: string;
  readonly fullName: string;
  readonly siteId: string;
}

export type Tier = 0 | 1;

/** Tools that work before verification. Everything else in TOOL_NAMES is tier 1. */
export const TIER0: readonly ToolName[] = ["verify_caller", "escalate"];

/** The tier of a tool name, or null when the name has no tool (refused with escalation). */
export function tierOf(toolName: string): Tier | null {
  if (!(TOOL_NAMES as readonly string[]).includes(toolName)) return null;
  return TIER0.includes(toolName as ToolName) ? 0 : 1;
}

export type GateResult =
  | { kind: "ok"; session: VerifiedSession }
  | { kind: "not_verified" }
  | { kind: "locked" }
  | { kind: "refused_tier" }
  /** A tier-0 tool: no session required, so nothing is minted. */
  | { kind: "tier0" };

/**
 * Decides whether `toolName` may run for `conversationId`. Unknown tools are
 * refused regardless of session state. Tier-1 tools need a live verified
 * session; a missing, malformed, or expired conversation id gives
 * `not_verified` without creating anything, and a locked session gives `locked`.
 */
export function gate(sessions: SessionStore, toolName: string, conversationId: unknown): GateResult {
  const tier = tierOf(toolName);
  if (tier === null) return { kind: "refused_tier" };
  if (tier === 0) return { kind: "tier0" };

  const session = sessions.peek(conversationId);
  if (!session) return { kind: "not_verified" };
  if (session.state === "locked") return { kind: "locked" };
  if (session.state !== "verified" || !session.user) return { kind: "not_verified" };

  const verified = {
    conversationId: session.conversationId,
    userId: session.user.userId,
    fullName: session.user.fullName,
    siteId: session.user.siteId,
  } as VerifiedSession;
  return { kind: "ok", session: verified };
}

/**
 * Ownership predicate for tier-1 reads by identifier. When this is false the
 * route answers `not_found` with the same speech as an unknown identifier
 * (contract, KTD5), so the service is not an existence oracle over issue ids.
 */
export function ownsIssue(session: VerifiedSession, issueReporterUserId: string): boolean {
  return issueReporterUserId.length > 0 && session.userId === issueReporterUserId;
}
