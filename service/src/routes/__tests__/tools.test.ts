// End-to-end tool routes: the real app, the real handlers, the fake adapter
// loaded from the seed CSVs. Covers every U9 test scenario.

import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type App } from "../../app.js";
import { buildHandlers } from "../../handlers.js";
import { FakeFoundryAdapter } from "../../foundry/fake.js";
import { CreateIdempotency } from "../../lib/idempotency.js";
import { CallerLockout, SessionStore } from "../../lib/sessions.js";
import { Verifier } from "../../lib/verification.js";
import { LOCKED_SPEECH, NOT_VERIFIED_SPEECH, RETRY_SPEECH } from "../../lib/speech.js";
import { wrapAllHandlers } from "../../observability/timing.js";
import { testConfig } from "../../test-support/config.js";
import { CapturingLogger } from "../../test-support/logger.js";
import { TOOL_NAMES, type Envelope } from "../../lib/types.js";

const SEED_DIR = fileURLToPath(new URL("../../../../ontology/seed", import.meta.url));
const SECRET = "test-secret-0123456789abcdef";
const PEPPER = "example-pepper-do-not-use";
const CONV = "conv_1234567890";
const DEMO_PHONE = "+15550100000";
const DEMO_PIN = "4321";
const AE5 = "the VPN client disconnects every few minutes on the office wifi and I have to reconnect";
const AE6 = "the label printer on the loading dock prints blank pages after the firmware update";
const TIER1 = TOOL_NAMES.filter((n) => n !== "verify_caller" && n !== "escalate");

interface Harness {
  app: App;
  logs: CapturingLogger;
  adapter: FakeFoundryAdapter;
  drawn: string[];
  post: (tool: string, body: unknown) => Promise<Envelope>;
  verifyDemo: (conv?: string) => Promise<Envelope>;
}

async function harness(opts: { adapter?: FakeFoundryAdapter; slowToolsMs?: number; ids?: string[] } = {}): Promise<Harness> {
  const logs = new CapturingLogger();
  const adapter = opts.adapter ?? FakeFoundryAdapter.fromCsvDir(SEED_DIR);
  const clock = () => Date.now();
  const sessions = new SessionStore({ clock });
  const lockout = new CallerLockout({ clock });
  const verifier = new Verifier({ sessions, lockout, lookup: (p) => adapter.findUserByPhone(p), pepper: PEPPER });
  const idempotency = new CreateIdempotency({ clock });
  const drawn: string[] = [];
  const queue = [...(opts.ids ?? ["5432", "5433", "5434"])];
  const drawIssueId = () => {
    const id = queue.shift() ?? "9999";
    drawn.push(id);
    return id;
  };
  const handlers = buildHandlers({ adapter, sessions, lockout, verifier, idempotency, logger: logs as never, clock, drawIssueId });
  const app = await buildApp({
    config: testConfig({ sharedSecrets: [SECRET], pinPepper: PEPPER, slowToolsMs: opts.slowToolsMs ?? 0 }),
    logger: logs as never,
    handlers: wrapAllHandlers(handlers, { logger: logs as never, slowToolsMs: opts.slowToolsMs ?? 0 }),
  });
  const post = async (tool: string, body: unknown) => {
    const res = await app.inject({ method: "POST", url: `/tools/${tool}`, headers: { "x-helpdesk-secret": SECRET }, payload: body as object });
    expect(res.statusCode).toBe(200);
    const env = res.json() as Envelope;
    expect(typeof env.speech).toBe("string");
    expect(env.speech.length).toBeLessThan(600);
    expect(res.body.length).toBeLessThan(2048);
    return env;
  };
  const verifyDemo = (conv = CONV) => post("verify_caller", { conversation_id: conv, caller_id: DEMO_PHONE, digits: DEMO_PIN });
  return { app, logs, adapter, drawn, post, verifyDemo };
}

describe("tool routes", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.app.close();
  });

  describe("AE1 unverified", () => {
    it("every tier-1 tool returns not_verified with the fixed sentence and never touches the adapter", async () => {
      const spyAdapter = h.adapter;
      const touched = () => spyAdapter.readCalls + spyAdapter.createCalls;
      for (const tool of TIER1) {
        const env = await h.post(tool, {
          conversation_id: CONV,
          issue_id: "4127",
          description: AE6,
          title: "Label printer blank pages",
          priority: "normal",
        });
        expect(env.status).toBe("not_verified");
        expect(env.speech).toBe(NOT_VERIFIED_SPEECH);
        expect(env.escalate).toBe(false);
        expect(env.data).toEqual({});
      }
      expect(touched()).toBe(0);
    });

    it("a missing or malformed conversation id is refused without creating a session", async () => {
      const a = await h.post("list_my_open_issues", {});
      expect(a.status).toBe("not_verified");
      const b = await h.post("get_issue_status", { conversation_id: "short", issue_id: "4127" });
      expect(b.status).toBe("not_verified");
      const c = await h.post("verify_caller", { digits: DEMO_PIN, caller_id: DEMO_PHONE });
      expect(c.status).toBe("not_verified");
      expect(c.speech).toBe(NOT_VERIFIED_SPEECH);
      const d = await h.post("escalate", { reason: "help" });
      expect(d.status).toBe("not_verified");
    });
  });

  describe("AE2 verify", () => {
    it("verifies the demo caller and returns the verified envelope", async () => {
      const env = await h.verifyDemo();
      expect(env).toEqual({ status: "ok", speech: "Thanks, you're verified.", escalate: false, data: { verified: true } });
      expect(h.logs.text()).not.toContain(DEMO_PIN);
    });

    it("speaks the retry sentence on the first failure and the locked sentence with escalation on the second", async () => {
      const first = await h.post("verify_caller", { conversation_id: CONV, caller_id: DEMO_PHONE, digits: "8642" });
      expect(first.status).toBe("not_verified");
      expect(first.speech).toBe(RETRY_SPEECH);
      expect(first.escalate).toBe(false);
      const second = await h.post("verify_caller", { conversation_id: CONV, caller_id: DEMO_PHONE, digits: "" });
      expect(second.status).toBe("locked");
      expect(second.speech).toBe(LOCKED_SPEECH);
      expect(second.escalate).toBe(true);
      const third = await h.verifyDemo();
      expect(third.status).toBe("locked");
      const read = await h.post("list_my_open_issues", { conversation_id: CONV });
      expect(read.status).toBe("locked");
      expect(read.speech).toBe(LOCKED_SPEECH);
      expect(h.logs.text()).not.toContain("8642");
    });

    it("accepts keypad digits with a trailing # terminator", async () => {
      const env = await h.post("verify_caller", { conversation_id: CONV, caller_id: DEMO_PHONE, digits: `${DEMO_PIN}#` });
      expect(env.status).toBe("ok");
      expect(env.data).toEqual({ verified: true });
    });

    it("two wrong PINs then escalate keeps the session locked: the correct PIN is refused and reads stay closed", async () => {
      await h.post("verify_caller", { conversation_id: CONV, caller_id: DEMO_PHONE, digits: "8642" });
      const second = await h.post("verify_caller", { conversation_id: CONV, caller_id: DEMO_PHONE, digits: "8643" });
      expect(second.status).toBe("locked");
      const esc = await h.post("escalate", { conversation_id: CONV, caller_id: DEMO_PHONE, reason: "cannot verify" });
      expect(esc.status).toBe("escalate");
      expect(h.logs.events("escalation")[0]?.verification_state).toBe("locked");
      const third = await h.verifyDemo();
      expect(third.status).toBe("locked");
      expect(third.speech).toBe(LOCKED_SPEECH);
      const read = await h.post("list_my_open_issues", { conversation_id: CONV });
      expect(read.status).not.toBe("ok");
      expect(read.status).toBe("locked");
      expect(h.adapter.readCalls).toBe(0);
    });

    it("uses the same wording for an unknown number", async () => {
      const env = await h.post("verify_caller", { conversation_id: CONV, caller_id: "+15550109999", digits: DEMO_PIN });
      expect(env.speech).toBe(RETRY_SPEECH);
    });
  });

  describe("AE3 status by identifier", () => {
    beforeEach(() => h.verifyDemo());

    it("reads status, team, and last update with digits one by one, accepting the spoken form", async () => {
      const env = await h.post("get_issue_status", { conversation_id: CONV, issue_id: "forty-one twenty-seven" });
      expect(env.status).toBe("ok");
      expect(env.data).toEqual({ issue_id: "4127", status: "open", team: "Platform Engineering" });
      expect(env.speech).toContain("4, 1, 2, 7");
      expect(env.speech).toContain("Platform Engineering");
      expect(env.speech).toContain("July 19");
    });

    it("speaks the digits back, asks for confirmation, and offers the open-issues list for an unknown id", async () => {
      const env = await h.post("get_issue_status", { conversation_id: CONV, issue_id: "9876" });
      expect(env.status).toBe("not_found");
      expect(env.escalate).toBe(false);
      expect(env.speech).toContain("9, 8, 7, 6");
      expect(env.speech).toMatch(/open issues/);
      expect(env.data).toEqual({ issue_id: "9876" });
    });

    it("collapses another caller's issue to the same not_found read-back", async () => {
      const foreign = await h.post("get_issue_status", { conversation_id: CONV, issue_id: "1015" });
      const unknown = await h.post("get_issue_status", { conversation_id: CONV, issue_id: "9876" });
      expect(foreign.status).toBe("not_found");
      expect(foreign.speech.replace("1, 0, 1, 5", "X")).toBe(unknown.speech.replace("9, 8, 7, 6", "X"));
      expect(JSON.stringify(foreign)).not.toContain("NFS");
    });

    it("asks for the digits again when the identifier cannot be read", async () => {
      const env = await h.post("get_issue_status", { conversation_id: CONV, issue_id: "the blue one" });
      expect(env.status).toBe("not_found");
      expect(env.speech).toMatch(/open issues/);
    });
  });

  describe("list_my_open_issues", () => {
    it("speaks five as a word, three items, and an offer for two more", async () => {
      await h.verifyDemo();
      const env = await h.post("list_my_open_issues", { conversation_id: CONV });
      expect(env.status).toBe("ok");
      const data = env.data as { count: number; issues: Array<{ issue_id: string; title: string; status: string }> };
      expect(data.count).toBe(5);
      expect(data.issues).toHaveLength(3);
      expect(env.speech).toContain("five");
      expect(env.speech).toContain("two more");
      for (const i of data.issues) expect(env.speech).toContain(i.issue_id.split("").join(", "));
    });

    it("speaks a friendly none message with no offer for zero open issues", async () => {
      await h.app.close();
      const adapter = new FakeFoundryAdapter({
        users: [{ userId: "u-demo", fullName: "Dana Whitfield", phoneE164: DEMO_PHONE, pinHash: demoHash(), siteId: "site-hq" }],
        issues: [],
        sites: [{ siteId: "site-hq", name: "Harbor Point HQ" }],
        teams: [{ teamId: "triage", name: "Triage" }],
      });
      h = await harness({ adapter });
      await h.verifyDemo();
      const env = await h.post("list_my_open_issues", { conversation_id: CONV });
      expect(env.status).toBe("ok");
      expect(env.data).toEqual({ count: 0, issues: [] });
      expect(env.speech).toMatch(/no open issues/i);
      expect(env.speech).not.toMatch(/more/);
    });
  });

  describe("AE4 team queue", () => {
    it("with five other open issues speaks five, three items, and an offer for two more", async () => {
      await h.app.close();
      const adapter = FakeFoundryAdapter.fromCsvDir(SEED_DIR);
      // Two more platform issues so the queue for 4127 has five beyond the input.
      adapter.addIssue({ issueId: "4901", title: "Artifact registry returns 502", status: "open", reportedByUserId: "u-1007", assignedTeamId: "platform", updatedAt: "2026-09-01T00:00:00.000Z" });
      adapter.addIssue({ issueId: "4902", title: "Staging deploy hangs at migration step", status: "in_progress", reportedByUserId: "u-1002", assignedTeamId: "platform", updatedAt: "2026-09-02T00:00:00.000Z" });
      h = await harness({ adapter });
      await h.verifyDemo();
      const env = await h.post("get_team_queue_for_issue", { conversation_id: CONV, issue_id: "4127" });
      expect(env.status).toBe("ok");
      const data = env.data as { team: string; open_count: number; issues: Array<{ issue_id: string; title: string; status: string }> };
      expect(data.team).toBe("Platform Engineering");
      expect(data.open_count).toBe(5);
      expect(data.issues).toHaveLength(3);
      expect(data.issues.map((i) => i.issue_id)).toEqual(["4902", "4901", "1015"]);
      for (const i of data.issues) expect(Object.keys(i).sort()).toEqual(["issue_id", "status", "title"]);
      expect(env.speech).toContain("Platform Engineering");
      expect(env.speech).toContain("five");
      expect(env.speech).toContain("two more");
      expect(env.speech).not.toContain("4, 1, 2, 7");
      expect(JSON.stringify(env)).not.toMatch(/u-10|Marcus|Dana/);
    });

    it("collapses a foreign issue to not_found and never names the team", async () => {
      await h.verifyDemo();
      const env = await h.post("get_team_queue_for_issue", { conversation_id: CONV, issue_id: "1653" });
      expect(env.status).toBe("not_found");
      expect(env.speech).toContain("1, 6, 5, 3");
      expect(JSON.stringify(env)).not.toContain("Network");
    });
  });

  describe("count_site_open_issues", () => {
    it("speaks the number as a word with the site name", async () => {
      await h.verifyDemo();
      const env = await h.post("count_site_open_issues", { conversation_id: CONV });
      expect(env.status).toBe("ok");
      expect(env.data).toEqual({ site: "Harbor Point HQ", open_count: 14 });
      expect(env.speech).toContain("fourteen");
      expect(env.speech).toContain("Harbor Point HQ");
    });

    it("speaks zero for a site with none", async () => {
      await h.app.close();
      const adapter = new FakeFoundryAdapter({
        users: [{ userId: "u-demo", fullName: "Dana Whitfield", phoneE164: DEMO_PHONE, pinHash: demoHash(), siteId: "site-lab" }],
        issues: [],
        sites: [{ siteId: "site-lab", name: "Riverside Lab" }],
        teams: [],
      });
      h = await harness({ adapter });
      await h.verifyDemo();
      const env = await h.post("count_site_open_issues", { conversation_id: CONV });
      expect(env.data).toEqual({ site: "Riverside Lab", open_count: 0 });
      expect(env.speech).toContain("zero");
      expect(env.speech).toContain("Riverside Lab");
    });
  });

  describe("AE5 and AE6 similar issues", () => {
    beforeEach(() => h.verifyDemo());

    it("speaks the seeded resolution and asks whether it fixes the problem", async () => {
      const env = await h.post("find_similar_issues", { conversation_id: CONV, description: AE5 });
      expect(env.status).toBe("ok");
      expect(env.data).toEqual({ match: { issue_id: "2210", resolution: expect.stringContaining("power-saving") } });
      expect(env.speech).toContain("power-saving");
      expect(env.speech).toContain("Does that fix it for you?");
    });

    it("returns not_found with match null for the AE6 description", async () => {
      const env = await h.post("find_similar_issues", { conversation_id: CONV, description: AE6 });
      expect(env.status).toBe("not_found");
      expect(env.escalate).toBe(false);
      expect(env.data).toEqual({ match: null });
      expect(env.speech).toMatch(/couldn't find a similar issue/);
    });

    it("rejects a description outside the contract bounds", async () => {
      const env = await h.post("find_similar_issues", { conversation_id: CONV, description: "short" });
      expect(env.status).toBe("failed");
    });
  });

  describe("AE6 create", () => {
    const body = { conversation_id: CONV, title: "Label printer prints blank pages", description: AE6, priority: "normal" };
    beforeEach(() => h.verifyDemo());

    it("returns the drawn identifier digit by digit and the adapter received the session's reporter", async () => {
      const env = await h.post("create_issue", body);
      expect(env.status).toBe("ok");
      expect(env.escalate).toBe(false);
      expect(env.data).toEqual({ issue_id: "5432" });
      expect(env.speech).toContain("5, 4, 3, 2");
      expect(env.speech).not.toContain("5432");
      expect(h.adapter.lastCreate?.session.userId).toBe("u-demo");
      const row = h.adapter.issues.find((i) => i.issueId === "5432");
      expect(row).toMatchObject({ reportedByUserId: "u-demo", assignedTeamId: "triage", sourceConversationId: CONV, priority: "normal" });
    });

    it("concurrent same-fields creates apply the Action once and return the same identifier", async () => {
      h.adapter.createDelayMs = 30;
      const [a, b] = await Promise.all([h.post("create_issue", body), h.post("create_issue", body)]);
      expect(a.status).toBe("ok");
      expect(b.status).toBe("ok");
      expect(a.data).toEqual(b.data);
      expect(h.adapter.createCalls).toBe(1);
      expect(h.adapter.issues.filter((i) => i.title === body.title)).toHaveLength(1);
    });

    it("a later same-fields create returns the recorded identifier without a second apply", async () => {
      const a = await h.post("create_issue", body);
      const b = await h.post("create_issue", { ...body });
      expect(b).toEqual(a);
      expect(h.adapter.createCalls).toBe(1);
    });

    it("a second create with different fields returns failed with escalation and applies nothing", async () => {
      await h.post("create_issue", body);
      const env = await h.post("create_issue", { ...body, title: "A completely different problem" });
      expect(env.status).toBe("failed");
      expect(env.escalate).toBe(true);
      expect(env.speech).not.toMatch(/created|logged/i);
      expect(h.adapter.createCalls).toBe(1);
    });

    it("rejects a body carrying reported_by or team", async () => {
      for (const extra of [{ reported_by: "u-1002" }, { team: "network" }, { reporter: "x" }]) {
        const env = await h.post("create_issue", { ...body, ...extra });
        expect(env.status).toBe("failed");
      }
      expect(h.adapter.createCalls).toBe(0);
    });

    it("rejects bad fields", async () => {
      expect((await h.post("create_issue", { ...body, priority: "urgent" })).status).toBe("failed");
      expect((await h.post("create_issue", { ...body, title: "tiny" })).status).toBe("failed");
      expect((await h.post("create_issue", { ...body, description: "x" })).status).toBe("failed");
      expect(h.adapter.createCalls).toBe(0);
    });

    it("AE7: an adapter permission failure returns failed, no success wording, escalate true", async () => {
      h.adapter.failNext("permission");
      const env = await h.post("create_issue", body);
      expect(env.status).toBe("failed");
      expect(env.escalate).toBe(true);
      expect(env.speech).not.toMatch(/created|logged|recorded|done/i);
      expect(env.speech).toMatch(/call you back/);
      expect(env.data).toEqual({});
      expect(JSON.stringify(env)).not.toContain("permission");
      // The failure is sticky for the conversation: a retry never applies the Action.
      const retry = await h.post("create_issue", body);
      expect(retry.status).toBe("failed");
      expect(h.adapter.createCalls).toBe(1);
    });

    it("redraws once on a duplicate key", async () => {
      await h.app.close();
      h = await harness({ ids: ["4127", "5433"] });
      await h.verifyDemo();
      const env = await h.post("create_issue", body);
      expect(env.status).toBe("ok");
      expect(env.data).toEqual({ issue_id: "5433" });
      expect(h.drawn).toEqual(["4127", "5433"]);
    });

    it("a thrown adapter error becomes the failed envelope with nothing leaked", async () => {
      h.adapter.throwNext(new Error("secret-foundry-body-xyz"));
      const env = await h.post("create_issue", body);
      expect(env.status).toBe("failed");
      expect(env.escalate).toBe(true);
      expect(JSON.stringify(env)).not.toContain("secret-foundry-body");
    });
  });

  describe("escalate", () => {
    it("logs a packet with verification state, caller name, and last summary; never digits or caller id", async () => {
      await h.verifyDemo();
      await h.post("create_issue", { conversation_id: CONV, title: "Label printer prints blank pages", description: AE6, priority: "normal" });
      const env = await h.post("escalate", { conversation_id: CONV, caller_id: DEMO_PHONE, reason: "wants a human" });
      expect(env).toEqual({ status: "escalate", speech: "A person will call you back on this number. Goodbye.", escalate: true, data: { recorded: true } });
      const packets = h.logs.events("escalation");
      expect(packets).toHaveLength(1);
      const p = packets[0]!;
      expect(p).toMatchObject({
        event: "escalation",
        conversation_id: CONV,
        verification_state: "verified",
        caller_name: "Dana Whitfield",
        last_tool: "create_issue",
        summary: "Label printer prints blank pages",
      });
      expect(typeof p.timestamp).toBe("string");
      expect(Object.keys(p).sort()).toEqual(["caller_name", "conversation_id", "event", "last_tool", "summary", "timestamp", "verification_state"]);
      const text = JSON.stringify(p);
      expect(text).not.toContain(DEMO_PIN);
      expect(text).not.toContain(DEMO_PHONE);
      expect(text).not.toContain("5550100000");
    });

    it("on an unverified session logs no name and uses the reason as the summary", async () => {
      const env = await h.post("escalate", { conversation_id: CONV, caller_id: DEMO_PHONE, reason: "forgot my PIN" });
      expect(env.status).toBe("escalate");
      const p = h.logs.events("escalation")[0]!;
      expect(p.verification_state).toBe("unverified");
      expect(p).not.toHaveProperty("caller_name");
      expect(p.summary).toBe("forgot my PIN");
      expect(p.last_tool).toBeNull();
      expect(JSON.stringify(p)).not.toContain(DEMO_PHONE);
    });

    it("strips spaced single digits from the summary so a spoken PIN never reaches the log", async () => {
      await h.post("escalate", { conversation_id: CONV, reason: "my PIN is 4 3 2 1 and the code was 7-7.7, ok" });
      const p = h.logs.events("escalation")[0]!;
      const text = JSON.stringify(p);
      expect(text).not.toContain("4 3 2 1");
      expect(text).not.toContain("4321");
      expect(p.summary).not.toMatch(/\d/);
      expect(p.summary).toBe("my PIN is [number] and the code was [number], ok");
    });

    it("strips digit runs from the summary and closes the session to further reads", async () => {
      await h.verifyDemo();
      await h.post("escalate", { conversation_id: CONV, reason: "my PIN is 4321 and my number is 5550100000" });
      const p = h.logs.events("escalation")[0]!;
      expect(JSON.stringify(p)).not.toContain("4321");
      expect(JSON.stringify(p)).not.toContain("5550100000");
      const after = await h.post("list_my_open_issues", { conversation_id: CONV });
      expect(after.status).toBe("not_verified");
    });
  });

  it("with SLOW_TOOLS_MS set, tool responses are delayed", async () => {
    await h.app.close();
    h = await harness({ slowToolsMs: 80 });
    const started = Date.now();
    await h.post("verify_caller", { conversation_id: CONV, caller_id: DEMO_PHONE, digits: "" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  });
});

function demoHash(): string {
  return "7306a37e93f8ac2fce5fd8b452a2da071ca1088bf35cd087aac139b517d667fb";
}
