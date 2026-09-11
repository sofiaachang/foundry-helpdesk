import { describe, expect, it } from "vitest";
import { SessionStore } from "../sessions.js";
import { TIER0, gate, ownsIssue, tierOf, type VerifiedSession } from "../tiers.js";
import { TOOL_NAMES } from "../types.js";

const CONV = "conv_1234567890";

function store() {
  return new SessionStore({ clock: () => 1_000_000 });
}

describe("tier registry", () => {
  it("puts verify_caller and escalate at tier 0 and every other tool at tier 1", () => {
    expect([...TIER0].sort()).toEqual(["escalate", "verify_caller"]);
    for (const name of TOOL_NAMES) {
      expect(tierOf(name)).toBe(TIER0.includes(name) ? 0 : 1);
    }
  });

  it("returns null for a tool name not in the registry", () => {
    expect(tierOf("delete_all_issues")).toBeNull();
    expect(tierOf("")).toBeNull();
  });
});

describe("gate", () => {
  it("returns not_verified for a tier-1 tool on an unverified session", () => {
    // The gate takes no lookup at all: an unverified session cannot reach Foundry by construction.
    const sessions = store();
    const r = gate(sessions, "get_issue_status", CONV);
    expect(r).toEqual({ kind: "not_verified" });
  });

  it("returns not_verified for a missing or malformed conversation id and creates no session", () => {
    const sessions = store();
    expect(gate(sessions, "get_issue_status", undefined)).toEqual({ kind: "not_verified" });
    expect(gate(sessions, "get_issue_status", "nope")).toEqual({ kind: "not_verified" });
    expect(sessions.size).toBe(0);
  });

  it("returns locked for a locked session", () => {
    const sessions = store();
    sessions.getOrCreate(CONV);
    sessions.recordFailure(CONV);
    sessions.recordFailure(CONV);
    expect(gate(sessions, "get_issue_status", CONV)).toEqual({ kind: "locked" });
  });

  it("returns refused_tier for a tool name not in the registry, even on a verified session", () => {
    const sessions = store();
    sessions.getOrCreate(CONV);
    sessions.bindVerified(CONV, { userId: "u1", fullName: "Ada", siteId: "s1" });
    expect(gate(sessions, "reassign_issue", CONV)).toEqual({ kind: "refused_tier" });
    expect(sessions.peek(CONV)?.state).toBe("verified");
  });

  it("returns ok with a VerifiedSession carrying the bound user for a tier-1 tool on a verified session", () => {
    const sessions = store();
    sessions.getOrCreate(CONV);
    sessions.bindVerified(CONV, { userId: "u1", fullName: "Ada Lovelace", siteId: "s1" });
    const r = gate(sessions, "get_issue_status", CONV);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") throw new Error("unreachable");
    expect(r.session.conversationId).toBe(CONV);
    expect(r.session.userId).toBe("u1");
    expect(r.session.fullName).toBe("Ada Lovelace");
    expect(r.session.siteId).toBe("s1");
  });

  it("returns not_verified for an escalated session", () => {
    const sessions = store();
    sessions.getOrCreate(CONV);
    sessions.bindVerified(CONV, { userId: "u1", fullName: "Ada", siteId: "s1" });
    sessions.markEscalated(CONV);
    expect(gate(sessions, "get_issue_status", CONV)).toEqual({ kind: "not_verified" });
  });

  it("returns tier0 for a tier-0 tool regardless of session state", () => {
    const sessions = store();
    expect(gate(sessions, "verify_caller", CONV)).toEqual({ kind: "tier0" });
    expect(gate(sessions, "escalate", CONV)).toEqual({ kind: "tier0" });
  });
});

describe("ownsIssue", () => {
  it("is true only when the reporter is the session user", () => {
    const sessions = store();
    sessions.getOrCreate(CONV);
    sessions.bindVerified(CONV, { userId: "u1", fullName: "Ada", siteId: "s1" });
    const r = gate(sessions, "get_issue_status", CONV);
    if (r.kind !== "ok") throw new Error("expected ok");
    const session: VerifiedSession = r.session;
    expect(ownsIssue(session, "u1")).toBe(true);
    // A foreign issue is not owned; routes collapse this to not_found with the
    // same speech as an unknown identifier (contract, KTD5).
    expect(ownsIssue(session, "u2")).toBe(false);
    expect(ownsIssue(session, "")).toBe(false);
  });
});
