// Placeholder for U7. U6 needs only the VerifiedSession brand so the adapter
// interface can compile; U7 replaces this file with the full registry and gate.

declare const verifiedBrand: unique symbol;

/** A session the tier gate has checked. Only the gate can construct one. */
export interface VerifiedSession {
  readonly [verifiedBrand]: true;
  readonly conversationId: string;
  readonly userId: string;
  readonly fullName: string;
  readonly siteId: string;
}
