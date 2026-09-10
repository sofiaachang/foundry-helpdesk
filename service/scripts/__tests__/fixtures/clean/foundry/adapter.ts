// Fixture adapter: every method after findUserByPhone takes the session first.
import type { VerifiedSession } from "../lib/tiers.js";

export interface FoundryAdapter {
  findUserByPhone(phoneE164: string): Promise<{ userId: string } | null>;
  getIssue(session: VerifiedSession, issueId: string): Promise<{ issueId: string } | null>;
  listOpenIssuesForUser(session: VerifiedSession): Promise<{ count: number }>;
  createIssue(
    session: VerifiedSession,
    input: { title: string },
  ): Promise<{ kind: "created" } | { kind: "failed" }>;
}
