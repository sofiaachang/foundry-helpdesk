// Fixture: the brand lives in lib so foundry/ can import it.
declare const verifiedBrand: unique symbol;
export interface VerifiedSession {
  readonly [verifiedBrand]: true;
  readonly conversationId: string;
  readonly userId: string;
}
