// RestFoundryAdapter against an injected fake fetch (plan U8). No test here
// touches the network: every request shape, status mapping, and the "no
// response body in errors or logs" property is asserted on recorded calls.

import { describe, expect, it } from "vitest";
import { DEFAULT_ONTOLOGY_NAMES, mergeOntologyNames, type OntologyNames } from "../../lib/ontology-names.js";
import type { VerifiedSession } from "../../lib/tiers.js";
import { FoundryAuthError } from "../../lib/foundry-auth-types.js";
import { CapturingLogger } from "../../test-support/logger.js";
import { FoundryRequestError, RestFoundryAdapter } from "../rest.js";

const STACK = "https://zap.example.palantirfoundry.com/";
const ONTOLOGY = "ri.ontology.main.ontology.abc";
const BASE = `https://zap.example.palantirfoundry.com/api/v2/ontologies/${encodeURIComponent(ONTOLOGY)}`;
const CONV = "conv_1234567890";
const SECRET_BODY = "SECRET_BODY_TEXT_MUST_NOT_LEAK";

// Only the tier gate may mint a VerifiedSession in shipped code; a test may
// fabricate one to call the adapter directly.
const SESSION = { conversationId: CONV, userId: "u1", fullName: "Ada Lovelace", siteId: "s1" } as unknown as VerifiedSession;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | null | undefined;
}

type Route = (call: Call) => Response | undefined;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function on(method: string, path: string, respond: (call: Call) => Response | unknown): Route {
  return (call) => {
    if (call.method !== method || call.url !== `${BASE}${path}`) return undefined;
    const out = respond(call);
    return out instanceof Response ? out : json(200, out);
  };
}

const OPEN_STATUSES = ["open", "in_progress"];

interface HarnessOptions {
  /** Token handed out by getToken; advances to the next entry only when refresh() is called. */
  tokens?: string[];
  /** Thrown by refresh() instead of advancing the token. */
  refreshError?: Error;
  timeoutMs?: number;
  names?: OntologyNames;
}

function harness(routes: Route[], opts: HarnessOptions = {}) {
  const calls: Call[] = [];
  const tokens = opts.tokens ?? ["tok-1"];
  let tokenCalls = 0;
  let refreshCalls = 0;
  let tokenIndex = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      signal: init?.signal,
    };
    calls.push(call);
    for (const route of routes) {
      const res = route(call);
      if (res) return res;
    }
    throw new Error(`unrouted ${call.method} ${call.url}`);
  };
  const logs = new CapturingLogger();
  const adapter = new RestFoundryAdapter({
    stackUrl: STACK,
    ontology: ONTOLOGY,
    tokens: {
      getToken: async () => {
        tokenCalls += 1;
        return tokens[Math.min(tokenIndex, tokens.length - 1)] ?? "";
      },
      refresh: async () => {
        refreshCalls += 1;
        if (opts.refreshError) throw opts.refreshError;
        tokenIndex += 1;
      },
    },
    fetch: fetchImpl,
    logger: logs as never,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.names === undefined ? {} : { names: opts.names }),
  });
  return { adapter, calls, logs, tokenCalls: () => tokenCalls, refreshCalls: () => refreshCalls };
}

const issueRow = (over: Record<string, unknown> = {}) => ({
  __primaryKey: "4127",
  __apiName: "HelpdeskIssue",
  issueId: "4127",
  title: "VPN drops",
  description: "VPN tunnel drops every few minutes",
  status: "in_progress",
  priority: "normal",
  resolution: "",
  reportedByUserId: "u1",
  assignedTeamId: "net",
  sourceConversationId: "",
  createdAt: "2026-09-01T10:00:00Z",
  updatedAt: "2026-09-02T10:00:00Z",
  ...over,
});

const linkedTeam = on("GET", "/objects/HelpdeskIssue/4127/links/assignedTeam", () => ({ data: [{ teamId: "net", name: "Network" }] }));

describe("RestFoundryAdapter request plumbing", () => {
  it("sends bearer token, accept header, json body, and an abort signal on every request", async () => {
    const { adapter, calls } = harness([on("POST", "/objects/HelpdeskUser/search", () => ({ data: [] }))]);
    await adapter.findUserByPhone("+15550100000");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.headers.authorization).toBe("Bearer tok-1");
    expect(call.headers.accept).toBe("application/json");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries exactly once after a 401, forcing a refresh so the retry carries a new token, then gives up", async () => {
    let attempts = 0;
    const { adapter, calls, tokenCalls, refreshCalls } = harness(
      [
        on("GET", "/objects/HelpdeskIssue/4127", () => {
          attempts += 1;
          return attempts === 1 ? json(401, { errorName: "Unauthorized" }) : issueRow();
        }),
        linkedTeam,
      ],
      { tokens: ["t1", "t2"] },
    );
    const issue = await adapter.getIssue(SESSION, "4127");
    expect(issue?.issueId).toBe("4127");
    expect(calls[0]!.headers.authorization).toBe("Bearer t1");
    expect(calls[1]!.headers.authorization).toBe("Bearer t2");
    expect(tokenCalls()).toBeGreaterThanOrEqual(2);
    expect(refreshCalls()).toBe(1);

    const twice = harness([on("GET", "/objects/HelpdeskIssue/4127", () => json(401, {}))], { tokens: ["t1", "t2"] });
    const err = await twice.adapter.getIssue(SESSION, "4127").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FoundryRequestError);
    expect((err as FoundryRequestError).category).toBe("unauthorized");
    expect(twice.calls).toHaveLength(2);
    expect(twice.refreshCalls()).toBe(1);
    expect(twice.calls).toHaveLength(2);
  });

  it("does not retry the same token after a 401, and maps a refresh that fails to unauthorized", async () => {
    const same = harness([on("GET", "/objects/HelpdeskIssue/4127", () => json(401, {}))], { tokens: ["t1"] });
    await same.adapter.getIssue(SESSION, "4127").catch(() => undefined);
    expect(same.refreshCalls()).toBe(1);

    const failing = harness([on("GET", "/objects/HelpdeskIssue/4127", () => json(401, {}))], {
      tokens: ["t1", "t2"],
      refreshError: new FoundryAuthError("refresh_failed", 401),
    });
    const err = await failing.adapter.getIssue(SESSION, "4127").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FoundryRequestError);
    expect((err as FoundryRequestError).category).toBe("unauthorized");
    expect((err as FoundryRequestError).httpStatus).toBe(401);
    // No second request goes out with a token the refresh could not renew.
    expect(failing.calls).toHaveLength(1);
    expect(failing.logs.events("foundry_request_failed")[0]).toMatchObject({ status: 401, category: "unauthorized" });
  });

  it("never puts a response body into a thrown error or a log line", async () => {
    const { adapter, logs } = harness([on("GET", "/objects/HelpdeskIssue/4127", () => json(500, { message: SECRET_BODY, errorName: SECRET_BODY }))]);
    const err = await adapter.getIssue(SESSION, "4127").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FoundryRequestError);
    expect((err as Error).message).not.toContain(SECRET_BODY);
    expect((err as FoundryRequestError).httpStatus).toBe(500);
    expect(JSON.stringify(err)).not.toContain(SECRET_BODY);
    expect(logs.text()).not.toContain(SECRET_BODY);
    expect(logs.events("foundry_request_failed")[0]).toMatchObject({ status: 500, category: "http" });
  });

  it("aborts through the timeout signal and reports category timeout", async () => {
    const hanging: Route = (call) => {
      if (!call.url.endsWith("/objects/HelpdeskIssue/4127")) return undefined;
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    const { adapter, calls } = harness([hanging], { timeoutMs: 5 });
    const err = await adapter.getIssue(SESSION, "4127").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FoundryRequestError);
    expect((err as FoundryRequestError).category).toBe("timeout");
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses overridden object type and property names", async () => {
    const names = mergeOntologyNames(DEFAULT_ONTOLOGY_NAMES, {
      user: { objectType: "HdUser", properties: { phoneE164: "phone" } },
    });
    const { adapter, calls } = harness([on("POST", "/objects/HdUser/search", () => ({ data: [] }))], { names });
    await adapter.findUserByPhone("+15550100000");
    expect(calls[0]!.body).toMatchObject({ where: { type: "eq", field: "phone", value: "+15550100000" } });
  });
});

describe("findUserByPhone", () => {
  it("searches HelpdeskUser by phoneE164 and maps the first row", async () => {
    const { adapter, calls } = harness([
      on("POST", "/objects/HelpdeskUser/search", () => ({
        data: [{ userId: "u1", fullName: "Ada Lovelace", phoneE164: "+15550100000", pinHash: "abc", siteId: "s1" }],
      })),
    ]);
    const user = await adapter.findUserByPhone("+15550100000");
    expect(user).toEqual({ userId: "u1", fullName: "Ada Lovelace", pinHash: "abc", siteId: "s1" });
    expect(calls[0]!.body).toEqual({
      where: { type: "eq", field: "phoneE164", value: "+15550100000" },
      pageSize: 1,
      select: ["userId", "fullName", "pinHash", "siteId"],
    });
  });

  it("returns null when nothing matches", async () => {
    const { adapter } = harness([on("POST", "/objects/HelpdeskUser/search", () => ({ data: [] }))]);
    expect(await adapter.findUserByPhone("+15550100001")).toBeNull();
  });
});

describe("getIssue", () => {
  it("gets by primary key, follows the assignedTeam link, and carries the ownership field", async () => {
    const { adapter, calls } = harness([on("GET", "/objects/HelpdeskIssue/4127", () => issueRow()), linkedTeam]);
    const issue = await adapter.getIssue(SESSION, "4127");
    expect(issue).toEqual({
      issueId: "4127",
      title: "VPN drops",
      status: "in_progress",
      teamName: "Network",
      updatedAt: "2026-09-02T10:00:00Z",
      reportedByUserId: "u1",
    });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${BASE}/objects/HelpdeskIssue/4127`,
      `GET ${BASE}/objects/HelpdeskIssue/4127/links/assignedTeam`,
    ]);
  });

  it("returns null on 404 without following links", async () => {
    const { adapter, calls } = harness([on("GET", "/objects/HelpdeskIssue/9999", () => json(404, { errorName: "ObjectNotFound" }))]);
    expect(await adapter.getIssue(SESSION, "9999")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("falls back to the Team object when the link returns no rows", async () => {
    const { adapter } = harness([
      on("GET", "/objects/HelpdeskIssue/4127", () => issueRow()),
      on("GET", "/objects/HelpdeskIssue/4127/links/assignedTeam", () => ({ data: [] })),
      on("GET", "/objects/Team/net", () => ({ teamId: "net", name: "Network (by pk)" })),
    ]);
    const issue = await adapter.getIssue(SESSION, "4127");
    expect(issue?.teamName).toBe("Network (by pk)");
  });

  it("encodes the primary key in the path", async () => {
    const { adapter, calls } = harness([(call) => (call.method === "GET" ? json(404, {}) : undefined)]);
    await adapter.getIssue(SESSION, "a/b c");
    expect(calls[0]!.url).toBe(`${BASE}/objects/HelpdeskIssue/a%2Fb%20c`);
  });
});

describe("listOpenIssuesForUser", () => {
  const where = {
    type: "and",
    value: [
      { type: "eq", field: "reportedByUserId", value: "u1" },
      { type: "in", field: "status", value: OPEN_STATUSES },
    ],
  };

  it("searches the caller's open issues newest first, page size 3, and counts with an aggregate", async () => {
    const { adapter, calls } = harness([
      on("POST", "/objects/HelpdeskIssue/search", () => ({
        data: [issueRow({ issueId: "4127" }), issueRow({ issueId: "4001", status: "open", title: "Printer" }), issueRow({ issueId: "3999" })],
      })),
      on("POST", "/objects/HelpdeskIssue/aggregate", () => ({ data: [{ group: {}, metrics: [{ name: "count", value: 7 }] }] })),
    ]);
    const result = await adapter.listOpenIssuesForUser(SESSION);
    expect(result.count).toBe(7);
    expect(result.top.map((i) => i.issueId)).toEqual(["4127", "4001", "3999"]);
    expect(result.top[1]).toEqual({ issueId: "4001", title: "Printer", status: "open" });
    expect(calls[0]!.body).toEqual({
      where,
      orderBy: { fields: [{ field: "updatedAt", direction: "desc" }] },
      pageSize: 3,
      select: ["issueId", "title", "status"],
    });
    expect(calls[1]!.body).toEqual({ aggregation: [{ type: "count", name: "count" }], groupBy: [], where });
  });

  it("falls back to a page-size-100 search count when the aggregate endpoint rejects the request", async () => {
    const { adapter, calls } = harness([
      on("POST", "/objects/HelpdeskIssue/search", (call) => {
        const body = call.body as { pageSize: number };
        if (body.pageSize === 100) return { data: [issueRow(), issueRow(), issueRow(), issueRow()] };
        return { data: [issueRow()] };
      }),
      on("POST", "/objects/HelpdeskIssue/aggregate", () => json(400, { errorName: "InvalidAggregationRange" })),
    ]);
    const result = await adapter.listOpenIssuesForUser(SESSION);
    expect(result.count).toBe(4);
    expect(calls[2]!.body).toMatchObject({ pageSize: 100, where, select: ["issueId"] });
  });
});

describe("getTeamQueueForIssue", () => {
  const queueWhere = {
    type: "and",
    value: [
      { type: "eq", field: "assignedTeamId", value: "net" },
      { type: "in", field: "status", value: OPEN_STATUSES },
    ],
  };

  it("pivots issue -> team -> open issues, excludes the input, caps at 3, and counts without the input", async () => {
    const { adapter, calls } = harness([
      on("GET", "/objects/HelpdeskIssue/4127", () => issueRow({ status: "open" })),
      linkedTeam,
      on("POST", "/objects/HelpdeskIssue/search", () => ({
        data: [issueRow({ issueId: "4300" }), issueRow({ issueId: "4127" }), issueRow({ issueId: "4200" }), issueRow({ issueId: "4100" })],
      })),
      on("POST", "/objects/HelpdeskIssue/aggregate", () => ({ data: [{ group: {}, metrics: [{ name: "count", value: 5 }] }] })),
    ]);
    const queue = await adapter.getTeamQueueForIssue(SESSION, "4127");
    expect(queue).not.toBeNull();
    expect(queue!.teamName).toBe("Network");
    expect(queue!.reportedByUserId).toBe("u1");
    expect(queue!.openCount).toBe(4);
    expect(queue!.top.map((i) => i.issueId)).toEqual(["4300", "4200", "4100"]);
    expect(queue!.top).not.toContainEqual(expect.objectContaining({ issueId: "4127" }));
    const search = calls.find((c) => c.url.endsWith("/objects/HelpdeskIssue/search"))!;
    expect(search.body).toEqual({
      where: queueWhere,
      orderBy: { fields: [{ field: "updatedAt", direction: "desc" }] },
      pageSize: 4,
      select: ["issueId", "title", "status"],
    });
    const aggregate = calls.find((c) => c.url.endsWith("/objects/HelpdeskIssue/aggregate"))!;
    expect(aggregate.body).toEqual({ aggregation: [{ type: "count", name: "count" }], groupBy: [], where: queueWhere });
  });

  it("does not subtract the input from the count when the input is resolved", async () => {
    const { adapter } = harness([
      on("GET", "/objects/HelpdeskIssue/4127", () => issueRow({ status: "resolved" })),
      linkedTeam,
      on("POST", "/objects/HelpdeskIssue/search", () => ({ data: [issueRow({ issueId: "4300" })] })),
      on("POST", "/objects/HelpdeskIssue/aggregate", () => ({ data: [{ group: {}, metrics: [{ name: "count", value: 1 }] }] })),
    ]);
    const queue = await adapter.getTeamQueueForIssue(SESSION, "4127");
    expect(queue!.openCount).toBe(1);
  });

  it("returns null for an unknown issue", async () => {
    const { adapter, calls } = harness([on("GET", "/objects/HelpdeskIssue/9999", () => json(404, {}))]);
    expect(await adapter.getTeamQueueForIssue(SESSION, "9999")).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe("countOpenIssuesAtSite", () => {
  it("finds users at the session's site, counts their open issues, and names the site", async () => {
    const { adapter, calls } = harness([
      on("POST", "/objects/HelpdeskUser/search", () => ({ data: [{ userId: "u1" }, { userId: "u2" }] })),
      on("POST", "/objects/HelpdeskIssue/aggregate", () => ({ data: [{ group: {}, metrics: [{ name: "count", value: 3 }] }] })),
      on("GET", "/objects/Site/s1", () => ({ siteId: "s1", name: "Head Office" })),
    ]);
    const result = await adapter.countOpenIssuesAtSite(SESSION);
    expect(result).toEqual({ siteName: "Head Office", openCount: 3 });
    expect(calls[0]!.body).toEqual({ where: { type: "eq", field: "siteId", value: "s1" }, pageSize: 100, select: ["userId"] });
    expect(calls[1]!.body).toEqual({
      aggregation: [{ type: "count", name: "count" }],
      groupBy: [],
      where: {
        type: "and",
        value: [
          { type: "in", field: "reportedByUserId", value: ["u1", "u2"] },
          { type: "in", field: "status", value: OPEN_STATUSES },
        ],
      },
    });
  });

  it("returns zero without querying issues when the site has no users, and falls back to the site id as its name", async () => {
    const { adapter, calls } = harness([
      on("POST", "/objects/HelpdeskUser/search", () => ({ data: [] })),
      on("GET", "/objects/Site/s1", () => json(404, {})),
    ]);
    const result = await adapter.countOpenIssuesAtSite(SESSION);
    expect(result).toEqual({ siteName: "s1", openCount: 0 });
    expect(calls.some((c) => c.url.includes("/objects/HelpdeskIssue/"))).toBe(false);
  });
});

describe("findResolvedIssuesMatching", () => {
  it("searches resolved issues only, title or description containing any term, page size 20", async () => {
    const { adapter, calls } = harness([
      on("POST", "/objects/HelpdeskIssue/search", () => ({
        data: [issueRow({ issueId: "1201", status: "resolved", resolution: "Reinstalled the VPN client" })],
      })),
    ]);
    const rows = await adapter.findResolvedIssuesMatching(SESSION, ["vpn", "tunnel", "drops"]);
    expect(rows).toEqual([{ issueId: "1201", title: "VPN drops", description: "VPN tunnel drops every few minutes", resolution: "Reinstalled the VPN client" }]);
    expect(calls[0]!.body).toEqual({
      where: {
        type: "and",
        value: [
          { type: "eq", field: "status", value: "resolved" },
          {
            type: "or",
            value: [
              { type: "containsAnyTerm", field: "title", value: "vpn tunnel drops" },
              { type: "containsAnyTerm", field: "description", value: "vpn tunnel drops" },
            ],
          },
        ],
      },
      orderBy: { fields: [{ field: "updatedAt", direction: "desc" }] },
      pageSize: 20,
      select: ["issueId", "title", "description", "resolution"],
    });
  });

  it("makes no request for an empty term list", async () => {
    const { adapter, calls } = harness([]);
    expect(await adapter.findResolvedIssuesMatching(SESSION, [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("createIssue", () => {
  const input = { issueId: "5123", title: "VPN drops", description: "VPN tunnel drops every few minutes", priority: "normal" as const, sourceConversationId: CONV };
  const APPLY = "/actions/createHelpdeskIssue/apply";

  it("applies the action with returnEdits ALL and reads the new key from the addObject edit", async () => {
    const { adapter, calls } = harness([
      on("POST", APPLY, () => ({
        validation: { result: "VALID", submissionCriteria: [], parameters: {} },
        edits: {
          type: "edits",
          edits: [
            { type: "modifyObject", objectType: "Team", primaryKey: "triage" },
            { type: "addObject", objectType: "HelpdeskIssue", primaryKey: "5123" },
          ],
        },
      })),
    ]);
    const result = await adapter.createIssue(SESSION, input);
    expect(result).toEqual({ kind: "created", issueId: "5123" });
    expect(calls[0]!.body).toEqual({
      parameters: {
        issueId: "5123",
        title: "VPN drops",
        description: "VPN tunnel drops every few minutes",
        priority: "normal",
        reportedBy: "u1",
        assignedTeam: "triage",
        sourceConversationId: CONV,
      },
      options: { returnEdits: "ALL" },
    });
  });

  it("maps a 400 validation failure to failed/validation naming the parameter", async () => {
    const { adapter, logs } = harness([
      on("POST", APPLY, () =>
        json(400, {
          errorCode: "INVALID_ARGUMENT",
          errorName: "ActionValidationFailed",
          parameters: {
            actionType: "createHelpdeskIssue",
            validation: { result: "INVALID", submissionCriteria: [], parameters: { title: { result: "INVALID" }, issueId: { result: "VALID" } } },
            detail: SECRET_BODY,
          },
        }),
      ),
    ]);
    const result = await adapter.createIssue(SESSION, input);
    expect(result).toEqual({ kind: "failed", category: "validation", parameter: "title" });
    expect(logs.events("foundry_create_failed")[0]).toMatchObject({ status: 400, category: "validation" });
    expect(logs.text()).not.toContain(SECRET_BODY);
  });

  it("maps a 200 body whose validation is INVALID the same way", async () => {
    const { adapter } = harness([
      on("POST", APPLY, () => ({ validation: { result: "INVALID", submissionCriteria: [], parameters: { description: { result: "INVALID" } } } })),
    ]);
    expect(await adapter.createIssue(SESSION, input)).toEqual({ kind: "failed", category: "validation", parameter: "description" });
  });

  it("maps ObjectAlreadyExists and an issueId validation failure to duplicate_key", async () => {
    const byName = harness([on("POST", APPLY, () => json(409, { errorCode: "CONFLICT", errorName: "ObjectAlreadyExists" }))]);
    expect(await byName.adapter.createIssue(SESSION, input)).toEqual({ kind: "failed", category: "duplicate_key", parameter: "issueId" });

    const byParameter = harness([
      on("POST", APPLY, () =>
        json(400, {
          errorName: "ActionValidationFailed",
          parameters: { validation: { result: "INVALID", parameters: { issueId: { result: "INVALID" } }, submissionCriteria: [] } },
        }),
      ),
    ]);
    expect(await byParameter.adapter.createIssue(SESSION, input)).toEqual({ kind: "failed", category: "duplicate_key", parameter: "issueId" });
  });

  it("maps 403 and a failed submission criterion to failed/permission", async () => {
    const forbidden = harness([on("POST", APPLY, () => json(403, { errorName: "PermissionDenied", message: SECRET_BODY }))]);
    expect(await forbidden.adapter.createIssue(SESSION, input)).toEqual({ kind: "failed", category: "permission" });
    expect(forbidden.logs.text()).not.toContain(SECRET_BODY);

    const criteria = harness([
      on("POST", APPLY, () =>
        json(400, {
          errorName: "ActionValidationFailed",
          parameters: {
            validation: {
              result: "INVALID",
              parameters: {},
              submissionCriteria: [{ result: "INVALID", configuredFailureMessage: SECRET_BODY }],
            },
          },
        }),
      ),
    ]);
    expect(await criteria.adapter.createIssue(SESSION, input)).toEqual({ kind: "failed", category: "permission" });
    expect(criteria.logs.text()).not.toContain(SECRET_BODY);
  });

  it("maps 500, a missing edit, a timeout, and an exhausted 401 to failed/unknown without leaking the body", async () => {
    const server = harness([on("POST", APPLY, () => json(500, { message: SECRET_BODY }))]);
    expect(await server.adapter.createIssue(SESSION, input)).toEqual({ kind: "failed", category: "unknown" });
    expect(server.logs.text()).not.toContain(SECRET_BODY);
    expect(server.logs.events("foundry_create_failed")[0]).toMatchObject({ status: 500, category: "unknown" });

    const noEdit = harness([on("POST", APPLY, () => ({ validation: { result: "VALID" }, edits: { type: "edits", edits: [] } }))]);
    expect(await noEdit.adapter.createIssue(SESSION, input)).toEqual({ kind: "failed", category: "unknown" });

    const timeout = harness(
      [
        () => {
          throw new DOMException("timed out", "TimeoutError");
        },
      ],
      { timeoutMs: 5 },
    );
    expect(await timeout.adapter.createIssue(SESSION, input)).toEqual({ kind: "failed", category: "unknown" });

    const unauthorized = harness([on("POST", APPLY, () => json(401, {}))], { tokens: ["t1", "t2"] });
    expect(await unauthorized.adapter.createIssue(SESSION, input)).toEqual({ kind: "failed", category: "unknown" });
    expect(unauthorized.calls).toHaveLength(2);
  });
});
