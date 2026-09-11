// Verification state lives here and nowhere else (KTD8). Two in-memory stores:
// sessions keyed by conversation id, and a failure counter keyed by normalised
// caller id (KTD7). Both take an injected clock so expiry is testable, and both
// clear on restart, which the limitations write-up records as acceptable.

import { CONVERSATION_ID_PATTERN } from "./types.js";

export type SessionState = "unverified" | "verified" | "locked" | "escalated";

export interface SessionUser {
  userId: string;
  fullName: string;
  siteId: string;
}

export interface Session {
  readonly conversationId: string;
  state: SessionState;
  /** Failed verify attempts in this conversation. Two lock the session. */
  attempts: number;
  readonly createdAt: number;
  /** Bound on verification; the only identity used afterwards. */
  user?: SessionUser;
}

export type Clock = () => number;

export interface SessionStoreOptions {
  clock: Clock;
  /** The agent's maximum conversation duration; a session older than this is new. */
  ttlMs?: number;
  /** Failures that lock a session. Contract: two. */
  maxAttempts?: number;
}

export const DEFAULT_SESSION_TTL_MS = 600_000;
export const DEFAULT_MAX_ATTEMPTS = 2;

/**
 * Map size at which an insert first sweeps expired entries. Conversation ids
 * are rarely touched again after a call ends, so lazy per-key expiry alone
 * would let every store grow by one entry per call for the life of the process.
 */
export const SWEEP_THRESHOLD = 256;

/** Deletes every entry whose `expired` predicate holds once the map is at the threshold. */
export function sweepExpired<K, V>(map: Map<K, V>, expired: (value: V) => boolean): void {
  if (map.size < SWEEP_THRESHOLD) return;
  for (const [key, value] of map) if (expired(value)) map.delete(key);
}

export function isConversationId(value: unknown): value is string {
  return typeof value === "string" && CONVERSATION_ID_PATTERN.test(value);
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  /** Sessions locked by `lock()` rather than by the attempt count; a release never lifts these. */
  private readonly lockedOutright = new WeakSet<Session>();
  private readonly clock: Clock;
  private readonly ttlMs: number;
  private readonly maxAttempts: number;

  constructor(opts: SessionStoreOptions) {
    this.clock = opts.clock;
    this.ttlMs = opts.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  get size(): number {
    return this.sessions.size;
  }

  /**
   * The live session for a conversation, creating an unverified one if none
   * exists or the existing one has expired. A missing or malformed id returns
   * null and creates nothing, so every verify attempt is attributable.
   */
  getOrCreate(conversationId: unknown): Session | null {
    if (!isConversationId(conversationId)) return null;
    const live = this.peek(conversationId);
    if (live) return live;
    const now = this.clock();
    sweepExpired(this.sessions, (s) => now - s.createdAt >= this.ttlMs);
    const session: Session = { conversationId, state: "unverified", attempts: 0, createdAt: now };
    this.sessions.set(conversationId, session);
    return session;
  }

  /** The live session if one exists; never creates, and drops an expired one. */
  peek(conversationId: unknown): Session | null {
    if (!isConversationId(conversationId)) return null;
    const existing = this.sessions.get(conversationId);
    if (!existing) return null;
    if (this.clock() - existing.createdAt >= this.ttlMs) {
      this.sessions.delete(conversationId);
      return null;
    }
    return existing;
  }

  /** Counts a failed verify attempt; the second one locks the session. */
  recordFailure(conversationId: string): { attempts: number; locked: boolean } {
    const session = this.getOrCreate(conversationId);
    if (!session) return { attempts: 0, locked: false };
    session.attempts += 1;
    if (session.attempts >= this.maxAttempts) session.state = "locked";
    return { attempts: session.attempts, locked: session.state === "locked" };
  }

  /**
   * Gives back one `recordFailure` reservation after the lookup failed before
   * any PIN was compared: an outage is not a guess. Only this call's count is
   * undone; a lock the remaining count still justifies stands, as does a lock
   * set outright by `lock()`, and a session verified meanwhile (attempts
   * already zero) is left alone.
   */
  releaseFailure(conversationId: string): void {
    const session = this.peek(conversationId);
    if (!session || session.state === "verified" || session.attempts === 0) return;
    session.attempts -= 1;
    if (session.state === "locked" && session.attempts < this.maxAttempts && !this.lockedOutright.has(session)) {
      session.state = "unverified";
    }
  }

  /** Locks a session outright, used when the caller id lockout window is active. */
  lock(conversationId: string): Session | null {
    const session = this.getOrCreate(conversationId);
    if (session) {
      session.state = "locked";
      this.lockedOutright.add(session);
    }
    return session;
  }

  /** Binds the session to the verified user and clears the attempt count. */
  bindVerified(conversationId: string, user: SessionUser): Session | null {
    const session = this.getOrCreate(conversationId);
    if (!session) return null;
    session.state = "verified";
    session.attempts = 0;
    session.user = { ...user };
    return session;
  }

  /** Marks a session escalated. A lock is never cleared: a locked caller stays locked through the handoff. */
  markEscalated(conversationId: string): Session | null {
    const session = this.getOrCreate(conversationId);
    if (session && session.state !== "locked") session.state = "escalated";
    return session;
  }
}

export interface CallerLockoutOptions {
  clock: Clock;
  /** Failures within the window that lock the number. Contract: six. */
  maxFailures?: number;
  /** Contract: fifteen minutes. */
  windowMs?: number;
}

export const DEFAULT_LOCKOUT_MAX_FAILURES = 6;
export const DEFAULT_LOCKOUT_WINDOW_MS = 900_000;

/** Bucket key for callers whose id is absent or cannot be normalised. */
export const UNKNOWN_CALLER = "unknown";

interface Bucket {
  count: number;
  windowStart: number;
}

/**
 * Per-number failure counter so an attacker cannot reset the two-attempt limit
 * by redialling. Unknown numbers share one bucket and are counted too.
 */
export class CallerLockout {
  private readonly buckets = new Map<string, Bucket>();
  private readonly clock: Clock;
  private readonly maxFailures: number;
  private readonly windowMs: number;

  constructor(opts: CallerLockoutOptions) {
    this.clock = opts.clock;
    this.maxFailures = opts.maxFailures ?? DEFAULT_LOCKOUT_MAX_FAILURES;
    this.windowMs = opts.windowMs ?? DEFAULT_LOCKOUT_WINDOW_MS;
  }

  get size(): number {
    return this.buckets.size;
  }

  private liveBucket(key: string): Bucket | null {
    const bucket = this.buckets.get(key);
    if (!bucket) return null;
    if (this.clock() - bucket.windowStart >= this.windowMs) {
      this.buckets.delete(key);
      return null;
    }
    return bucket;
  }

  isLocked(key: string): boolean {
    const bucket = this.liveBucket(key);
    return bucket !== null && bucket.count >= this.maxFailures;
  }

  recordFailure(key: string): void {
    const bucket = this.liveBucket(key);
    if (bucket) {
      bucket.count += 1;
    } else {
      const now = this.clock();
      sweepExpired(this.buckets, (b) => now - b.windowStart >= this.windowMs);
      this.buckets.set(key, { count: 1, windowStart: now });
    }
  }

  /** Undoes one `recordFailure` after a lookup failed before any compare; an empty bucket is dropped. */
  release(key: string): void {
    const bucket = this.liveBucket(key);
    if (!bucket) return;
    bucket.count -= 1;
    if (bucket.count <= 0) this.buckets.delete(key);
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }
}
