// PIN verification (KTD7, KTD17). The service, not the prompt, decides whether
// a caller is verified: this module is the only place that compares PINs, and
// its result is the only thing that moves a session to "verified".

import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizePhone } from "./identifiers.js";
import { UNKNOWN_CALLER, type CallerLockout, type SessionStore } from "./sessions.js";

export { normalizePhone };

export interface UserRecord {
  userId: string;
  fullName: string;
  pinHash: string;
  siteId: string;
}

/** Looks up a seeded user by E.164 phone. Injected so the module stays pure. */
export type UserLookupFn = (phoneE164: string) => Promise<UserRecord | null>;

export interface VerifierOptions {
  sessions: SessionStore;
  lockout: CallerLockout;
  lookup: UserLookupFn;
  /** PIN_PEPPER: held only by the service, never in the seed. */
  pepper: string;
}

export interface VerifyInput {
  conversationId: unknown;
  callerId?: unknown;
  /** Keypad digits; empty means the keypad timed out and counts as a failure. */
  digits: unknown;
}

export type VerifyResult =
  | { status: "verified"; userId: string; attempts: number }
  | { status: "retry"; attempts: number }
  | { status: "locked"; attempts: number }
  /** Refused before any session or counter is touched: no usable conversation id. */
  | { status: "not_verified" };

/**
 * The stored form of a PIN: hex HMAC-SHA256 keyed by the pepper over
 * `${userId}:${pin}`. Binding the user id means one user's PIN hash cannot be
 * replayed for another. Shared with the seed generator.
 */
export function hashPin(pepper: string, userId: string, pin: string): string {
  return createHmac("sha256", pepper).update(`${userId}:${pin}`).digest("hex");
}

function hashesMatch(expectedHex: string, candidateHex: string): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  const candidate = Buffer.from(candidateHex, "hex");
  if (expected.length === 0 || expected.length !== candidate.length) return false;
  return timingSafeEqual(expected, candidate);
}

export class Verifier {
  private readonly sessions: SessionStore;
  private readonly lockout: CallerLockout;
  private readonly lookup: UserLookupFn;
  private readonly pepper: string;
  /** Compared against when the number is unknown, so both paths do the same work. */
  private readonly dummyHash: string;

  constructor(opts: VerifierOptions) {
    this.sessions = opts.sessions;
    this.lockout = opts.lockout;
    this.lookup = opts.lookup;
    this.pepper = opts.pepper;
    this.dummyHash = hashPin(opts.pepper, "__no_such_user__", "__no_such_pin__");
  }

  async verify(input: VerifyInput): Promise<VerifyResult> {
    const session = this.sessions.getOrCreate(input.conversationId);
    if (!session) return { status: "not_verified" };
    const conversationId = session.conversationId;

    if (session.state === "locked") return { status: "locked", attempts: session.attempts };
    if (session.state === "verified" && session.user) {
      return { status: "verified", userId: session.user.userId, attempts: session.attempts };
    }

    const callerKey = normalizePhone(input.callerId) ?? UNKNOWN_CALLER;
    if (this.lockout.isLocked(callerKey)) {
      // Same wording as a second failure; the caller cannot tell which limit hit.
      this.sessions.lock(conversationId);
      return { status: "locked", attempts: session.attempts };
    }

    const user = callerKey === UNKNOWN_CALLER ? null : await this.lookup(callerKey);
    const digits = typeof input.digits === "string" ? input.digits : "";
    const expected = user?.pinHash ?? this.dummyHash;
    const candidate = hashPin(this.pepper, user?.userId ?? "__no_such_user__", digits);
    const matched = hashesMatch(expected, candidate);
    const success = user !== null && digits.length > 0 && matched;

    if (success) {
      this.sessions.bindVerified(conversationId, { userId: user.userId, fullName: user.fullName, siteId: user.siteId });
      this.lockout.reset(callerKey);
      return { status: "verified", userId: user.userId, attempts: 0 };
    }

    this.lockout.recordFailure(callerKey);
    const { attempts, locked } = this.sessions.recordFailure(conversationId);
    return locked ? { status: "locked", attempts } : { status: "retry", attempts };
  }
}
