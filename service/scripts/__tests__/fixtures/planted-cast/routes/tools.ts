// Fixture routes with a planted violation: a handler mints a VerifiedSession
// with a bare cast instead of going through the tier gate in lib/tiers.ts.
import type { VerifiedSession } from "../lib/tiers.js";

export function fakeGate(userId: string): VerifiedSession {
  return { conversationId: "c1", userId } as VerifiedSession;
}
