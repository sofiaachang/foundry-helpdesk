// At-most-once creation per conversation (KTD15). The record is written as
// `pending` with a hash of the request fields before the work runs. A
// same-fields call while pending joins the in-flight promise; after settlement
// it gets the recorded result (a rejection replays too: a lost or failed apply
// is never retried by the service, which the limitations write-up states). A
// different-fields call is a mismatch the caller turns into `failed` with
// escalation. Entries expire with the session TTL so a reused conversation id
// cannot replay another call's record.

import { createHash } from "node:crypto";
import { DEFAULT_SESSION_TTL_MS, type Clock } from "./sessions.js";

export type CreateRecordState = "pending" | "done" | "failed";

interface CreateRecord {
  fieldsHash: string;
  state: CreateRecordState;
  createdAt: number;
  result: Promise<unknown>;
}

export interface IdempotencyOptions {
  clock: Clock;
  ttlMs?: number;
}

export type RunOutcome<T> =
  | { kind: "mismatch" }
  | { kind: "started" | "in_flight" | "recorded"; result: Promise<T> };

/** Order-independent SHA-256 over the fields, so `{a,b}` and `{b,a}` are the same request. */
export function hashFields(fields: Record<string, unknown>): string {
  const canonical = JSON.stringify(Object.keys(fields).sort().map((k) => [k, fields[k]]));
  return createHash("sha256").update(canonical).digest("hex");
}

export class CreateIdempotency {
  private readonly records = new Map<string, CreateRecord>();
  private readonly clock: Clock;
  private readonly ttlMs: number;

  constructor(opts: IdempotencyOptions) {
    this.clock = opts.clock;
    this.ttlMs = opts.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  }

  private live(conversationId: string): CreateRecord | null {
    const record = this.records.get(conversationId);
    if (!record) return null;
    if (this.clock() - record.createdAt >= this.ttlMs) {
      this.records.delete(conversationId);
      return null;
    }
    return record;
  }

  stateOf(conversationId: string): CreateRecordState | null {
    return this.live(conversationId)?.state ?? null;
  }

  run<T>(conversationId: string, fields: Record<string, unknown>, work: () => Promise<T>): RunOutcome<T> {
    const fieldsHash = hashFields(fields);
    const existing = this.live(conversationId);
    if (existing) {
      if (existing.fieldsHash !== fieldsHash) return { kind: "mismatch" };
      return { kind: existing.state === "pending" ? "in_flight" : "recorded", result: existing.result as Promise<T> };
    }

    const record: CreateRecord = { fieldsHash, state: "pending", createdAt: this.clock(), result: Promise.resolve() };
    // Written before the work starts so a concurrent same-fields call joins it.
    this.records.set(conversationId, record);
    const result = Promise.resolve()
      .then(work)
      .then(
        (value) => {
          record.state = "done";
          return value;
        },
        (error: unknown) => {
          record.state = "failed";
          throw error;
        },
      );
    record.result = result;
    // The stored promise is observed by every joiner; keep an unhandled rejection from surfacing here.
    result.catch(() => {});
    return { kind: "started", result };
  }
}
