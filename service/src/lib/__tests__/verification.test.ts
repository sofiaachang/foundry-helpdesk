import { describe, expect, it, vi } from "vitest";
import { normalizePhone } from "../identifiers.js";
import { CallerLockout, SessionStore } from "../sessions.js";
import { Verifier, hashPin, type UserRecord } from "../verification.js";

const PEPPER = "test-pepper";
const ADA: UserRecord = { userId: "u_ada", fullName: "Ada Lovelace", pinHash: hashPin(PEPPER, "u_ada", "4321"), siteId: "site_1" };
const BOB: UserRecord = { userId: "u_bob", fullName: "Bob Builder", pinHash: hashPin(PEPPER, "u_bob", "1111"), siteId: "site_2" };
const USERS: Record<string, UserRecord> = { "+15551230001": ADA, "+15551230002": BOB };

const CONV_A = "conv_aaaaaaaaaa";
const CONV_B = "conv_bbbbbbbbbb";

function harness(opts: { maxFailures?: number; windowMs?: number; ttlMs?: number } = {}) {
  let now = 1_000_000;
  const clock = () => now;
  const advance = (ms: number) => (now += ms);
  const sessions = new SessionStore({ clock, ttlMs: opts.ttlMs });
  const lockout = new CallerLockout({ clock, maxFailures: opts.maxFailures, windowMs: opts.windowMs });
  const lookup = vi.fn(async (phone: string) => USERS[phone] ?? null);
  const verifier = new Verifier({ sessions, lockout, lookup, pepper: PEPPER });
  return { sessions, lockout, lookup, verifier, advance };
}

describe("hashPin", () => {
  it("is a hex HMAC-SHA256 keyed by the pepper over userId:pin", () => {
    const h = hashPin(PEPPER, "u_ada", "4321");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPin("other-pepper", "u_ada", "4321")).not.toBe(h);
    expect(hashPin(PEPPER, "u_bob", "4321")).not.toBe(h);
    expect(hashPin(PEPPER, "u_ada", "4322")).not.toBe(h);
  });
});

describe("Verifier", () => {
  it("returns verified bound to the user on a correct first attempt", async () => {
    const h = harness();
    const r = await h.verifier.verify({ conversationId: CONV_A, callerId: "+15551230001", digits: "4321" });
    expect(r).toEqual({ status: "verified", userId: "u_ada", attempts: 0 });
    const s = h.sessions.peek(CONV_A);
    expect(s?.state).toBe("verified");
    expect(s?.user).toEqual({ userId: "u_ada", fullName: "Ada Lovelace", siteId: "site_1" });
  });

  it("wrong PIN once returns retry with attempts 1; twice returns locked; a third call is locked without comparing", async () => {
    const h = harness();
    expect(await h.verifier.verify({ conversationId: CONV_A, callerId: "+15551230001", digits: "0000" })).toEqual({ status: "retry", attempts: 1 });
    expect(await h.verifier.verify({ conversationId: CONV_A, callerId: "+15551230001", digits: "0000" })).toEqual({ status: "locked", attempts: 2 });
    expect(h.lookup).toHaveBeenCalledTimes(2);
    expect(await h.verifier.verify({ conversationId: CONV_A, callerId: "+15551230001", digits: "4321" })).toEqual({ status: "locked", attempts: 2 });
    expect(h.lookup).toHaveBeenCalledTimes(2);
    expect(h.sessions.peek(CONV_A)?.state).toBe("locked");
  });

  it("correct PIN after one failure returns verified and resets attempts", async () => {
    const h = harness();
    await h.verifier.verify({ conversationId: CONV_A, callerId: "+15551230001", digits: "9999" });
    const r = await h.verifier.verify({ conversationId: CONV_A, callerId: "+15551230001", digits: "4321" });
    expect(r).toEqual({ status: "verified", userId: "u_ada", attempts: 0 });
    expect(h.sessions.peek(CONV_A)?.attempts).toBe(0);
  });

  it("unknown caller id returns retry then locked with the same result shape as a known caller", async () => {
    const known = harness();
    const unknown = harness();
    const k1 = await known.verifier.verify({ conversationId: CONV_A, callerId: "+15551230001", digits: "0000" });
    const u1 = await unknown.verifier.verify({ conversationId: CONV_A, callerId: "+15559990000", digits: "0000" });
    expect(u1).toEqual(k1);
    const k2 = await known.verifier.verify({ conversationId: CONV_A, callerId: "+15551230001", digits: "0000" });
    const u2 = await unknown.verifier.verify({ conversationId: CONV_A, callerId: "+15559990000", digits: "0000" });
    expect(u2).toEqual(k2);
    expect(u2.status).toBe("locked");
  });

  it("an absent caller id follows the same path and is counted in the unknown bucket", async () => {
    const h = harness({ maxFailures: 2 });
    expect(await h.verifier.verify({ conversationId: CONV_A, digits: "1234" })).toEqual({ status: "retry", attempts: 1 });
    expect(await h.verifier.verify({ conversationId: CONV_B, digits: "1234" })).toEqual({ status: "retry", attempts: 1 });
    expect(h.lockout.isLocked("unknown")).toBe(true);
    // A third conversation with no caller id is locked before comparing.
    const third = await h.verifier.verify({ conversationId: "conv_cccccccccc", digits: "1234" });
    expect(third.status).toBe("locked");
  });

  it("empty digits (keypad timeout) count as a failure; two timeouts lock the session", async () => {
    const h = harness();
    expect(await h.verifier.verify({ conversationId: CONV_A, callerId: "+15551230001", digits: "" })).toEqual({ status: "retry", attempts: 1 });
    expect(await h.verifier.verify({ conversationId: CONV_A, callerId: "+15551230001", digits: "" })).toEqual({ status: "locked", attempts: 2 });
  });

  it("refuses a missing or malformed conversation id without creating a session or counting", async () => {
    const h = harness();
    expect(await h.verifier.verify({ conversationId: undefined, callerId: "+15551230001", digits: "4321" })).toEqual({ status: "not_verified" });
    expect(await h.verifier.verify({ conversationId: "bad id", callerId: "+15551230001", digits: "4321" })).toEqual({ status: "not_verified" });
    expect(h.sessions.size).toBe(0);
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.lockout.isLocked("+15551230001")).toBe(false);
  });

  it("two conversations do not share attempt counts", async () => {
    const h = harness();
    await h.verifier.verify({ conversationId: CONV_A, callerId: "+15551230001", digits: "0000" });
    const r = await h.verifier.verify({ conversationId: CONV_B, callerId: "+15551230001", digits: "0000" });
    expect(r).toEqual({ status: "retry", attempts: 1 });
  });

  it("locks the caller id after six failures across conversations; the seventh call is locked before comparing and another number is unaffected", async () => {
    const h = harness();
    const convs = ["conv_c1c1c1c1c1", "conv_c2c2c2c2c2", "conv_c3c3c3c3c3"];
    for (const conv of convs) {
      await h.verifier.verify({ conversationId: conv, callerId: "+15551230001", digits: "0000" });
      await h.verifier.verify({ conversationId: conv, callerId: "+15551230001", digits: "0000" });
    }
    expect(h.lookup).toHaveBeenCalledTimes(6);
    const seventh = await h.verifier.verify({ conversationId: "conv_c4c4c4c4c4", callerId: "+15551230001", digits: "4321" });
    expect(seventh.status).toBe("locked");
    expect(h.lookup).toHaveBeenCalledTimes(6);
    expect(h.sessions.peek("conv_c4c4c4c4c4")?.state).toBe("locked");
    const other = await h.verifier.verify({ conversationId: "conv_d1d1d1d1d1", callerId: "+15551230002", digits: "1111" });
    expect(other).toEqual({ status: "verified", userId: "u_bob", attempts: 0 });
  });

  it("caller id lockout expires after the window and a correct PIN then verifies", async () => {
    const h = harness({ windowMs: 900_000 });
    for (let i = 0; i < 6; i++) {
      await h.verifier.verify({ conversationId: `conv_e${i}e${i}e${i}e${i}e${i}`, callerId: "+15551230001", digits: "0000" });
    }
    expect(h.lockout.isLocked("+15551230001")).toBe(true);
    h.advance(900_000);
    const r = await h.verifier.verify({ conversationId: "conv_ffffffffff", callerId: "+15551230001", digits: "4321" });
    expect(r).toEqual({ status: "verified", userId: "u_ada", attempts: 0 });
  });

  it("a successful verification resets the caller id counter", async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) {
      await h.verifier.verify({ conversationId: `conv_g${i}g${i}g${i}g${i}g${i}`, callerId: "+15551230001", digits: "0000" });
    }
    await h.verifier.verify({ conversationId: "conv_hhhhhhhhhh", callerId: "+15551230001", digits: "4321" });
    await h.verifier.verify({ conversationId: "conv_iiiiiiiiii", callerId: "+15551230001", digits: "0000" });
    expect(h.lockout.isLocked("+15551230001")).toBe(false);
  });

  it("a session past expiry is treated as new", async () => {
    const h = harness({ ttlMs: 600_000 });
    await h.verifier.verify({ conversationId: CONV_A, callerId: "+15551230001", digits: "0000" });
    await h.verifier.verify({ conversationId: CONV_A, callerId: "+15551230001", digits: "0000" });
    expect(h.sessions.peek(CONV_A)?.state).toBe("locked");
    h.advance(600_000);
    const r = await h.verifier.verify({ conversationId: CONV_A, callerId: "+15551230001", digits: "4321" });
    expect(r).toEqual({ status: "verified", userId: "u_ada", attempts: 0 });
  });

  it("normalises the caller id before lookup", async () => {
    const h = harness();
    const r = await h.verifier.verify({ conversationId: CONV_A, callerId: "(555) 123-0001", digits: "4321" });
    expect(h.lookup).toHaveBeenCalledWith("+15551230001");
    expect(r.status).toBe("verified");
  });

  it("a stored hash is never compared against a different user's id", async () => {
    // Bob's PIN hashed under Ada's id must not verify Ada.
    const h = harness();
    const r = await h.verifier.verify({ conversationId: CONV_A, callerId: "+15551230001", digits: "1111" });
    expect(r.status).toBe("retry");
  });
});

describe("normalizePhone", () => {
  it("keeps a leading plus and strips formatting", () => {
    expect(normalizePhone("+1 (555) 123-0001")).toBe("+15551230001");
    expect(normalizePhone("+44.20.7946.0958")).toBe("+442079460958");
  });

  it("adds a plus when missing and +1 to a ten-digit US number", () => {
    expect(normalizePhone("5551230001")).toBe("+15551230001");
    expect(normalizePhone("15551230001")).toBe("+15551230001");
    expect(normalizePhone("442079460958")).toBe("+442079460958");
  });

  it("returns null for absent, empty, or non-numeric input", () => {
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("anonymous")).toBeNull();
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone(12345)).toBeNull();
  });
});
