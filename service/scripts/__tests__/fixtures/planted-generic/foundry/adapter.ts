// Fixture adapter with a planted violation: listOpenIssuesForUser<T> is a
// generic method that lacks session: VerifiedSession as its first parameter.
import type { VerifiedSession } from "../lib/tiers.js";

export interface FoundryAdapter {
  findUserByPhone(phoneE164: string): Promise<{ userId: string } | null>;
  getIssue(session: VerifiedSession, issueId: string): Promise<{ issueId: string } | null>;
  listOpenIssuesForUser<T>(userId: string): Promise<T>;
}
