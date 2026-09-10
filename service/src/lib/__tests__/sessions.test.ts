import { describe, expect, it } from "vitest";
import { CallerLockout, SessionStore } from "../sessions.js";

function clockAt(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("SessionStore", () => {
  it("refuses a missing or malformed conversation id and creates no session", () => {
    const clock = clockAt();
    const store = new SessionStore({ clock: clock.now });
    expect(store.getOrCreate(undefined)).toBeNull();
    expect(store.getOrCreate("")).toBeNull();
    expect(store.getOrCreate("short")).toBeNull();
    expect(store.getOrCreate("has spaces 12345")).toBeNull();
    expect(store.getOrCreate("x".repeat(129))).toBeNull();
    expect(store.size).toBe(0);
  });

  it("creates an unverified session with zero attempts on first sight", () => {
    const clock = clockAt();
    const store = new SessionStore({ clock: clock.now });
    const s = store.getOrCreate("conv_1234567890");
    expect(s).not.toBeNull();
    expect(s?.state).toBe("unverified");
    expect(s?.attempts).toBe(0);
    expect(s?.createdAt).toBe(1_000_000);
    expect(store.size).toBe(1);
  });

  it("returns the same session for the same id and separate sessions for different ids", () => {
    const clock = clockAt();
    const store = new SessionStore({ clock: clock.now });
    const a = store.getOrCreate("conv_aaaaaaaaaa");
    const b = store.getOrCreate("conv_bbbbbbbbbb");
    store.recordFailure("conv_aaaaaaaaaa");
    expect(store.getOrCreate("conv_aaaaaaaaaa")).toBe(a);
    expect(a?.attempts).toBe(1);
    expect(b?.attempts).toBe(0);
  });

  it("treats a session past the TTL as new", () => {
    const clock = clockAt();
    const store = new SessionStore({ clock: clock.now, ttlMs: 600_000 });
    store.getOrCreate("conv_1234567890");
    store.recordFailure("conv_1234567890");
    clock.advance(600_000);
    const fresh = store.getOrCreate("conv_1234567890");
    expect(fresh?.attempts).toBe(0);
    expect(fresh?.state).toBe("unverified");
    expect(fresh?.createdAt).toBe(1_600_000);
  });

  it("does not expire a session just before the TTL", () => {
    const clock = clockAt();
    const store = new SessionStore({ clock: clock.now, ttlMs: 600_000 });
    store.getOrCreate("conv_1234567890");
    store.recordFailure("conv_1234567890");
    clock.advance(599_999);
    expect(store.getOrCreate("conv_1234567890")?.attempts).toBe(1);
  });

  it("peek never creates a session", () => {
    const store = new SessionStore({ clock: clockAt().now });
    expect(store.peek("conv_1234567890")).toBeNull();
    expect(store.size).toBe(0);
  });

  it("locks on the second failure and reports the lock", () => {
    const store = new SessionStore({ clock: clockAt().now });
    store.getOrCreate("conv_1234567890");
    expect(store.recordFailure("conv_1234567890")).toEqual({ attempts: 1, locked: false });
    expect(store.recordFailure("conv_1234567890")).toEqual({ attempts: 2, locked: true });
    expect(store.peek("conv_1234567890")?.state).toBe("locked");
  });

  it("binds a user on verification and resets attempts", () => {
    const store = new SessionStore({ clock: clockAt().now });
    store.getOrCreate("conv_1234567890");
    store.recordFailure("conv_1234567890");
    const s = store.bindVerified("conv_1234567890", { userId: "u1", fullName: "Ada Lovelace", siteId: "s1" });
    expect(s?.state).toBe("verified");
    expect(s?.attempts).toBe(0);
    expect(s?.user).toEqual({ userId: "u1", fullName: "Ada Lovelace", siteId: "s1" });
  });

  it("marks a session escalated", () => {
    const store = new SessionStore({ clock: clockAt().now });
    store.getOrCreate("conv_1234567890");
    expect(store.markEscalated("conv_1234567890")?.state).toBe("escalated");
  });
});

describe("CallerLockout", () => {
  it("locks a number after maxFailures within the window and leaves other numbers alone", () => {
    const clock = clockAt();
    const lockout = new CallerLockout({ clock: clock.now, maxFailures: 6, windowMs: 900_000 });
    for (let i = 0; i < 5; i++) lockout.recordFailure("+15551230001");
    expect(lockout.isLocked("+15551230001")).toBe(false);
    lockout.recordFailure("+15551230001");
    expect(lockout.isLocked("+15551230001")).toBe(true);
    expect(lockout.isLocked("+15551230002")).toBe(false);
  });

  it("expires the lock after the window", () => {
    const clock = clockAt();
    const lockout = new CallerLockout({ clock: clock.now, maxFailures: 6, windowMs: 900_000 });
    for (let i = 0; i < 6; i++) lockout.recordFailure("+15551230001");
    clock.advance(899_999);
    expect(lockout.isLocked("+15551230001")).toBe(true);
    clock.advance(1);
    expect(lockout.isLocked("+15551230001")).toBe(false);
    // The window restarts after expiry: one fresh failure is not a lock.
    lockout.recordFailure("+15551230001");
    expect(lockout.isLocked("+15551230001")).toBe(false);
  });

  it("counts the unknown bucket like any other number", () => {
    const clock = clockAt();
    const lockout = new CallerLockout({ clock: clock.now, maxFailures: 2, windowMs: 900_000 });
    lockout.recordFailure("unknown");
    lockout.recordFailure("unknown");
    expect(lockout.isLocked("unknown")).toBe(true);
  });

  it("resets a number on success", () => {
    const clock = clockAt();
    const lockout = new CallerLockout({ clock: clock.now, maxFailures: 6, windowMs: 900_000 });
    for (let i = 0; i < 5; i++) lockout.recordFailure("+15551230001");
    lockout.reset("+15551230001");
    lockout.recordFailure("+15551230001");
    expect(lockout.isLocked("+15551230001")).toBe(false);
  });
});
