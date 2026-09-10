// The fake adapter reads the seed CSVs and answers the same interface the OSDK
// adapter will, including the two-hop pivots and the create failure modes.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FakeFoundryAdapter, parseCsv } from "../fake.js";
import { SessionStore } from "../../lib/sessions.js";
import { gate, type VerifiedSession } from "../../lib/tiers.js";
import { salientTerms } from "../../lib/similarity.js";

const SEED_DIR = fileURLToPath(new URL("../../../../ontology/seed", import.meta.url));
const CONV = "conv_1234567890";

function verified(userId: string, fullName = "Test", siteId = "site-hq"): VerifiedSession {
  const sessions = new SessionStore({ clock: () => 0 });
  sessions.bindVerified(CONV, { userId, fullName, siteId });
  const r = gate(sessions, "get_issue_status", CONV);
  if (r.kind !== "ok") throw new Error("gate did not verify");
  return r.session;
}

describe("parseCsv", () => {
  it("handles quoted fields with commas, escaped quotes, and CRLF", () => {
    const rows = parseCsv('a,b\r\n1,"x, y"\n2,"say ""hi"""\n');
    expect(rows).toEqual([
      { a: "1", b: "x, y" },
      { a: "2", b: 'say "hi"' },
    ]);
  });

  it("handles a quoted field spanning a newline", () => {
    expect(parseCsv('a,b\n1,"line one\nline two"\n')).toEqual([{ a: "1", b: "line one\nline two" }]);
  });
});

describe("FakeFoundryAdapter.fromCsvDir", () => {
  const adapter = FakeFoundryAdapter.fromCsvDir(SEED_DIR);
  const demo = verified("u-demo", "Dana Whitfield", "site-hq");

  it("loads the four seed files", () => {
    expect(adapter.issues.length).toBe(40);
    expect(adapter.users.length).toBe(12);
  });

  it("finds the demo user by phone and nobody by an unknown number", async () => {
    const user = await adapter.findUserByPhone("+15550100000");
    expect(user).toMatchObject({ userId: "u-demo", fullName: "Dana Whitfield", siteId: "site-hq" });
    expect(user?.pinHash).toHaveLength(64);
    expect(await adapter.findUserByPhone("+15550109999")).toBeNull();
  });

  it("AE3: reads an issue by identifier with team name and reporter; unknown id is null", async () => {
    const issue = await adapter.getIssue(demo, "4127");
    expect(issue).toMatchObject({ issueId: "4127", status: "open", teamName: "Platform Engineering", reportedByUserId: "u-demo" });
    expect(issue?.updatedAt).toBe("2026-07-19T22:23:31.414Z");
    expect(await adapter.getIssue(demo, "0001")).toBeNull();
  });

  it("lists the user's non-resolved issues newest first with the count", async () => {
    const r = await adapter.listOpenIssuesForUser(demo);
    expect(r.count).toBe(5);
    expect(r.top).toHaveLength(3);
    expect(r.top[0]?.issueId).toBe("4906");
    for (const item of r.top) expect(Object.keys(item).sort()).toEqual(["issueId", "status", "title"]);
  });

  it("AE4: pivots issue to team to that team's open issues, excluding the input, newest first", async () => {
    const q = await adapter.getTeamQueueForIssue(demo, "4127");
    expect(q?.teamName).toBe("Platform Engineering");
    expect(q?.reportedByUserId).toBe("u-demo");
    expect(q?.openCount).toBe(3);
    expect(q?.top.map((i) => i.issueId)).toEqual(["1015", "2358", "3837"]);
    expect(q?.top.some((i) => i.issueId === "4127")).toBe(false);
    expect(await adapter.getTeamQueueForIssue(demo, "0001")).toBeNull();
  });

  it("counts open issues reported by users at the session's site, and zero for an empty site", async () => {
    expect(await adapter.countOpenIssuesAtSite(demo)).toEqual({ siteName: "Harbor Point HQ", openCount: 14 });
    const empty = new FakeFoundryAdapter({
      users: [{ userId: "u-x", fullName: "X", phoneE164: "+15550000001", pinHash: "", siteId: "site-empty" }],
      issues: [],
      sites: [{ siteId: "site-empty", name: "Empty Site" }],
      teams: [],
    });
    expect(await adapter.countOpenIssuesAtSite(verified("u-x", "X", "site-empty"))).toEqual({ siteName: "site-empty", openCount: 0 });
    expect(await empty.countOpenIssuesAtSite(verified("u-x", "X", "site-empty"))).toEqual({ siteName: "Empty Site", openCount: 0 });
  });

  it("returns only resolved issues containing any of the terms, with resolution text", async () => {
    const hits = await adapter.findResolvedIssuesMatching(demo, salientTerms("vpn wifi reconnect"));
    expect(hits.some((h) => h.issueId === "2210")).toBe(true);
    for (const h of hits) {
      expect(h.resolution.length).toBeGreaterThan(0);
      expect(typeof h.title).toBe("string");
      expect(typeof h.description).toBe("string");
    }
    expect(hits.some((h) => h.issueId === "4127")).toBe(false);
    expect(await adapter.findResolvedIssuesMatching(demo, [])).toEqual([]);
  });
});

describe("FakeFoundryAdapter.createIssue", () => {
  const input = {
    issueId: "5432",
    title: "Label printer prints blank pages",
    description: "The label printer on the loading dock prints blank pages after the firmware update.",
    priority: "normal" as const,
    sourceConversationId: CONV,
  };

  it("appends a row with reporter from the session, team triage, status open", async () => {
    const adapter = FakeFoundryAdapter.fromCsvDir(SEED_DIR);
    const before = adapter.issues.length;
    const r = await adapter.createIssue(verified("u-demo"), input);
    expect(r).toEqual({ kind: "created", issueId: "5432" });
    expect(adapter.issues.length).toBe(before + 1);
    const row = adapter.issues.find((i) => i.issueId === "5432");
    expect(row).toMatchObject({ reportedByUserId: "u-demo", assignedTeamId: "triage", status: "open", sourceConversationId: CONV });
    expect(adapter.createCalls).toBe(1);
  });

  it("refuses a duplicate key", async () => {
    const adapter = FakeFoundryAdapter.fromCsvDir(SEED_DIR);
    const r = await adapter.createIssue(verified("u-demo"), { ...input, issueId: "4127" });
    expect(r).toEqual({ kind: "failed", category: "duplicate_key", parameter: "issueId" });
  });

  it("fails the next create with the requested category and then recovers", async () => {
    const adapter = FakeFoundryAdapter.fromCsvDir(SEED_DIR);
    adapter.failNext("permission");
    const r = await adapter.createIssue(verified("u-demo"), input);
    expect(r).toEqual({ kind: "failed", category: "permission" });
    expect(adapter.issues.some((i) => i.issueId === "5432")).toBe(false);
    const again = await adapter.createIssue(verified("u-demo"), input);
    expect(again.kind).toBe("created");
  });

  it("maps a bad parameter to a validation failure naming it", async () => {
    const adapter = FakeFoundryAdapter.fromCsvDir(SEED_DIR);
    const r = await adapter.createIssue(verified("u-demo"), { ...input, title: "" });
    expect(r).toEqual({ kind: "failed", category: "validation", parameter: "title" });
  });
});
