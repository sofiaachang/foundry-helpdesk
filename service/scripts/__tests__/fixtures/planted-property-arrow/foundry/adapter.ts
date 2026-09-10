// Fixture adapter with a planted violation: getIssue is a property-style arrow
// member (`name: (...) => Promise<...>`) that lacks session: VerifiedSession.
import type { VerifiedSession } from "../lib/tiers.js";

export interface FoundryAdapter {
  findUserByPhone(phoneE164: string): Promise<{ userId: string } | null>;
  getIssue: (issueId: string) => Promise<{ issueId: string } | null>;
  listOpenIssuesForUser(session: VerifiedSession): Promise<{ count: number }>;
}
