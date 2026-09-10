// At-most-once creation (KTD15): a per-conversation record written as pending
// before the work runs; same-fields callers share the in-flight promise or the
// recorded result; different fields are a mismatch; entries expire with the
// session TTL.

import { describe, expect, it } from "vitest";
import { CreateIdempotency, hashFields } from "../idempotency.js";

const CONV = "conv_1234567890";
const fields = { title: "Label printer prints blank pages", description: "after the firmware update the printer prints blank pages", priority: "normal" };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("hashFields", () => {
  it("is stable across key order and differs on any value change", () => {
    expect(hashFields({ a: 1, b: "x" })).toBe(hashFields({ b: "x", a: 1 }));
    expect(hashFields({ a: 1 })).not.toBe(hashFields({ a: 2 }));
  });
});

describe("CreateIdempotency.run", () => {
  it("records pending before the work resolves, then done with the result", async () => {
    let now = 1000;
    const store = new CreateIdempotency({ clock: () => now });
    const d = deferred<string>();
    const outcome = store.run(CONV, fields, () => d.promise);
    expect(outcome.kind).toBe("started");
    expect(store.stateOf(CONV)).toBe("pending");
    d.resolve("5432");
    if (outcome.kind === "mismatch") throw new Error("unexpected");
    await expect(outcome.result).resolves.toBe("5432");
    expect(store.stateOf(CONV)).toBe("done");
    now += 1;
    expect(store.stateOf(CONV)).toBe("done");
  });

  it("hands a concurrent same-fields call the in-flight promise and runs the work once", async () => {
    const store = new CreateIdempotency({ clock: () => 0 });
    let runs = 0;
    const d = deferred<string>();
    const first = store.run(CONV, fields, () => {
      runs += 1;
      return d.promise;
    });
    const second = store.run(CONV, { ...fields }, () => {
      runs += 1;
      return Promise.resolve("never");
    });
    expect(second.kind).toBe("in_flight");
    d.resolve("5432");
    if (first.kind === "mismatch" || second.kind === "mismatch") throw new Error("unexpected");
    expect(await Promise.all([first.result, second.result])).toEqual(["5432", "5432"]);
    expect(runs).toBe(1);
  });

  it("hands a later same-fields call the recorded result without running the work", async () => {
    const store = new CreateIdempotency({ clock: () => 0 });
    const first = store.run(CONV, fields, () => Promise.resolve("5432"));
    if (first.kind === "mismatch") throw new Error("unexpected");
    await first.result;
    let ran = false;
    const later = store.run(CONV, fields, () => {
      ran = true;
      return Promise.resolve("9999");
    });
    expect(later.kind).toBe("recorded");
    if (later.kind === "mismatch") throw new Error("unexpected");
    await expect(later.result).resolves.toBe("5432");
    expect(ran).toBe(false);
  });

  it("signals mismatch to a different-fields call, pending or done, and leaves the record alone", async () => {
    const store = new CreateIdempotency({ clock: () => 0 });
    const d = deferred<string>();
    const first = store.run(CONV, fields, () => d.promise);
    const other = store.run(CONV, { ...fields, title: "Something else entirely" }, () => Promise.resolve("x"));
    expect(other).toEqual({ kind: "mismatch" });
    expect(store.stateOf(CONV)).toBe("pending");
    d.resolve("5432");
    if (first.kind === "mismatch") throw new Error("unexpected");
    await first.result;
    expect(store.run(CONV, { ...fields, priority: "high" }, () => Promise.resolve("x"))).toEqual({ kind: "mismatch" });
    expect(store.stateOf(CONV)).toBe("done");
  });

  it("records failed when the work rejects and replays the rejection, never re-running the work", async () => {
    const store = new CreateIdempotency({ clock: () => 0 });
    let runs = 0;
    const first = store.run(CONV, fields, () => {
      runs += 1;
      return Promise.reject(new Error("permission"));
    });
    if (first.kind === "mismatch") throw new Error("unexpected");
    await expect(first.result).rejects.toThrow("permission");
    expect(store.stateOf(CONV)).toBe("failed");
    const again = store.run(CONV, fields, () => {
      runs += 1;
      return Promise.resolve("x");
    });
    expect(again.kind).toBe("recorded");
    if (again.kind === "mismatch") throw new Error("unexpected");
    await expect(again.result).rejects.toThrow("permission");
    expect(runs).toBe(1);
  });

  it("keeps conversations apart", async () => {
    const store = new CreateIdempotency({ clock: () => 0 });
    const a = store.run(CONV, fields, () => Promise.resolve("1111"));
    const b = store.run("conv_other_0001", fields, () => Promise.resolve("2222"));
    expect(a.kind).toBe("started");
    expect(b.kind).toBe("started");
  });

  it("expires entries with the session TTL so a reused id after expiry starts fresh", async () => {
    let now = 0;
    const store = new CreateIdempotency({ clock: () => now, ttlMs: 600_000 });
    const first = store.run(CONV, fields, () => Promise.resolve("5432"));
    if (first.kind === "mismatch") throw new Error("unexpected");
    await first.result;
    now = 599_999;
    expect(store.stateOf(CONV)).toBe("done");
    now = 600_000;
    expect(store.stateOf(CONV)).toBeNull();
    const fresh = store.run(CONV, { ...fields, title: "Different title now" }, () => Promise.resolve("7777"));
    expect(fresh.kind).toBe("started");
  });
});
