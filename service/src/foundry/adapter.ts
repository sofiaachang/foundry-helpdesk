// The only surface the rest of the service uses to reach Foundry. Every call
// takes a VerifiedSession as its first argument; that value can only be minted
// by the tier gate in lib/tiers.ts, which is what makes "no read before
// verification" a type-level property rather than a convention.

import type { IssueStatus, Priority } from "../lib/types.js";
import type { VerifiedSession } from "../lib/tiers.js";

export interface IssueSummary {
  issueId: string;
  title: string;
  status: IssueStatus;
}

export interface IssueDetail extends IssueSummary {
  teamName: string;
  updatedAt: string;
}

export interface TeamQueue {
  teamName: string;
  openCount: number;
  /** Top items, newest first, excluding the input issue. Never carries reporter names or descriptions. */
  top: IssueSummary[];
}

export interface SimilarMatch {
  issueId: string;
  resolution: string;
}

export interface CreateIssueInput {
  issueId: string;
  title: string;
  description: string;
  priority: Priority;
  sourceConversationId: string;
}

export type CreateIssueResult =
  | { kind: "created"; issueId: string }
  | { kind: "failed"; category: "validation" | "permission" | "duplicate_key" | "unknown"; parameter?: string };

/** Looks up the seeded user for a phone number; used before verification, so no session argument. */
export interface UserLookup {
  findUserByPhone(phoneE164: string): Promise<{ userId: string; fullName: string; pinHash: string; siteId: string } | null>;
}

export interface FoundryAdapter extends UserLookup {
  getIssue(session: VerifiedSession, issueId: string): Promise<IssueDetail | null>;
  listOpenIssuesForUser(session: VerifiedSession): Promise<{ count: number; top: IssueSummary[] }>;
  getTeamQueueForIssue(session: VerifiedSession, issueId: string): Promise<TeamQueue | null>;
  countOpenIssuesAtSite(session: VerifiedSession): Promise<{ siteName: string; openCount: number }>;
  findResolvedIssuesMatching(session: VerifiedSession, terms: string[]): Promise<Array<SimilarMatch & { title: string; description: string }>>;
  createIssue(session: VerifiedSession, input: CreateIssueInput): Promise<CreateIssueResult>;
}
