// Fixture adapter with a planted violation: countOpenIssuesAtSite has no session.
import type { VerifiedSession } from "../lib/tiers.js";

export interface FoundryAdapter {
  findUserByPhone(phoneE164: string): Promise<{ userId: string } | null>;
  getIssue(session: VerifiedSession, issueId: string): Promise<{ issueId: string } | null>;
  countOpenIssuesAtSite(siteId: string): Promise<{ openCount: number }>;
}
