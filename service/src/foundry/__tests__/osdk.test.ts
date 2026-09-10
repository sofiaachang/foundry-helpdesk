// The osdk slot before U8: a placeholder adapter that fails closed. Nothing
// here talks to Foundry; the tests prove that every tool call becomes the
// contract's failed envelope while verification (which needs only the user
// lookup) still works when a delegate is supplied.

import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type App } from "../../app.js";
import { buildHandlers } from "../../handlers.js";
import { FakeFoundryAdapter } from "../fake.js";
import { FoundryNotReadyError, NotReadyFoundryAdapter, tokenProvider } from "../osdk.js";
import { CreateIdempotency } from "../../lib/idempotency.js";
import { CallerLockout, SessionStore } from "../../lib/sessions.js";
import { Verifier } from "../../lib/verification.js";
import { FAILED_SPEECH, type Envelope } from "../../lib/types.js";
import { wrapAllHandlers } from "../../observability/timing.js";
import { testConfig } from "../../test-support/config.js";
import { CapturingLogger } from "../../test-support/logger.js";
import type { VerifiedSession } from "../../lib/tiers.js";

const SEED_DIR = fileURLToPath(new URL("../../../../ontology/seed", import.meta.url));
const SECRET = "test-secret-0123456789abcdef";
const PEPPER = "example-pepper-do-not-use";
const CONV = "conv_1234567890";
const DEMO_PHONE = "+15550100000";
const DEMO_PIN = "4321";

// Only the tier gate may mint a VerifiedSession in shipped code; a test may
// fabricate one to call the adapter directly.
const SESSION = { conversationId: CONV, userId: "u1", siteId: "s1" } as unknown as VerifiedSession;

describe("NotReadyFoundryAdapter", () => {
  it("logs foundry_adapter_not_ready exactly once at construction", () => {
    const logs = new CapturingLogger();
    new NotReadyFoundryAdapter(logs as never);
    expect(logs.events("foundry_adapter_not_ready")).toHaveLength(1);
    expect(logs.lines.filter((l) => l.level === "warn")).toHaveLength(1);
  });

  it("rejects every adapter method with FoundryNotReadyError without a delegate", async () => {
    const logs = new CapturingLogger();
    const adapter = new NotReadyFoundryAdapter(logs as never);
    const calls: Array<Promise<unknown>> = [
      adapter.findUserByPhone(DEMO_PHONE),
      adapter.getIssue(SESSION, "4127"),
      adapter.listOpenIssuesForUser(SESSION),
      adapter.getTeamQueueForIssue(SESSION, "4127"),
      adapter.countOpenIssuesAtSite(SESSION),
      adapter.findResolvedIssuesMatching(SESSION, ["vpn"]),
      adapter.createIssue(SESSION, { issueId: "1", title: "t", description: "d", priority: "normal", sourceConversationId: CONV }),
    ];
    for (const call of calls) {
      await expect(call).rejects.toBeInstanceOf(FoundryNotReadyError);
    }
    const err = await adapter.getIssue(SESSION, "4127").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("FoundryNotReadyError");
    // Method calls add no log lines: the single warning is the construction one.
    expect(logs.events("foundry_adapter_not_ready")).toHaveLength(1);
  });

  it("delegates only findUserByPhone when a user lookup is supplied", async () => {
    const logs = new CapturingLogger();
    const fake = FakeFoundryAdapter.fromCsvDir(SEED_DIR);
    const adapter = new NotReadyFoundryAdapter(logs as never, { userLookup: fake });
    const user = await adapter.findUserByPhone(DEMO_PHONE);
    expect(user).not.toBeNull();
    await expect(adapter.getIssue(SESSION, "4127")).rejects.toBeInstanceOf(FoundryNotReadyError);
  });

  it("keeps the token provider shape the generated client will use", async () => {
    const provider = tokenProvider({
      beginLogin: () => "",
      completeLogin: async () => {},
      getToken: async () => "tok",
      status: () => ({ status: "ok", expiresAt: null }),
    });
    await expect(provider()).resolves.toBe("tok");
  });
});

describe("osdk mode routes with the not-ready adapter", () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
  });

  it("get_issue_status on a verified session returns failed + escalate with no error text", async () => {
    const logs = new CapturingLogger();
    const fake = FakeFoundryAdapter.fromCsvDir(SEED_DIR);
    const adapter = new NotReadyFoundryAdapter(logs as never, { userLookup: fake });
    const clock = () => Date.now();
    const sessions = new SessionStore({ clock });
    const lockout = new CallerLockout({ clock });
    const verifier = new Verifier({ sessions, lockout, lookup: (p) => adapter.findUserByPhone(p), pepper: PEPPER });
    const idempotency = new CreateIdempotency({ clock });
    const handlers = buildHandlers({ adapter, sessions, lockout, verifier, idempotency, logger: logs as never, clock });
    app = await buildApp({
      config: testConfig({ adapter: "osdk", sharedSecrets: [SECRET], pinPepper: PEPPER }),
      logger: logs as never,
      handlers: wrapAllHandlers(handlers, { logger: logs as never, slowToolsMs: 0 }),
    });
    const post = async (tool: string, body: unknown): Promise<Envelope> => {
      const res = await app!.inject({ method: "POST", url: `/tools/${tool}`, headers: { "x-helpdesk-secret": SECRET }, payload: body as object });
      expect(res.statusCode).toBe(200);
      return res.json() as Envelope;
    };

    const verified = await post("verify_caller", { conversation_id: CONV, caller_id: DEMO_PHONE, digits: DEMO_PIN });
    expect(verified.status).toBe("ok");

    const env = await post("get_issue_status", { conversation_id: CONV, issue_id: "4127" });
    expect(env).toEqual({ status: "failed", speech: FAILED_SPEECH, escalate: true, data: {} });
    const wire = JSON.stringify(env);
    expect(wire).not.toMatch(/not ready|NotReady|U8|Foundry/i);

    // The failure is logged by name only, never with a message body.
    const failedEvents = logs.events("tool_failed");
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]).toMatchObject({ tool: "get_issue_status", name: "FoundryNotReadyError" });
  });
});
