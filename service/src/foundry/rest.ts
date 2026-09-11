// The real FoundryAdapter (plan U8): five reads and one Action over the
// Foundry REST API v2, authenticated with the delegated user token from
// FoundryDelegatedAuth (plan KTD3).
//
// Decision: this talks to the REST API directly instead of a generated OSDK
// package. The SDK install token is only shown in the Developer Console, so
// it cannot be provisioned into the build without a human step, and the REST
// surface is equivalent for these seven calls (get by primary key, search,
// aggregate, list linked objects, apply action). The generated SDK can replace
// this class later without changing the FoundryAdapter interface.
//
// Endpoints (docs.palantir.com, Ontology API v2):
//   GET  /api/v2/ontologies/{ontology}/objects/{type}/{pk}
//   GET  /api/v2/ontologies/{ontology}/objects/{type}/{pk}/links/{link}
//   POST /api/v2/ontologies/{ontology}/objects/{type}/search     {where, orderBy, pageSize, select}
//   POST /api/v2/ontologies/{ontology}/objects/{type}/aggregate  {aggregation, groupBy, where}
//   POST /api/v2/ontologies/{ontology}/actions/{action}/apply    {parameters, options}
//
// Two shapes the docs mirror could not confirm are hedged: the `in` filter
// (documented as {type:"in", field, value:[...]}) and the aggregate `count`
// (falls back to a page-size-100 search when the aggregate endpoint rejects
// the request). The team queue avoids the `not` filter entirely by fetching
// one extra row and removing the input issue in the service.
//
// Every request carries the bearer token, Accept: application/json, and an
// AbortSignal.timeout; a 401 forces a token refresh and is retried once with
// the new token (a failed refresh is `unauthorized` with no retry). Nothing here
// puts a response body into an error, a return value, or a log line: the
// logger receives only an event name, the HTTP status, and a category.

import { FoundryAuthError } from "../lib/foundry-auth-types.js";
import { asRecord } from "../lib/types.js";
import type { IssueStatus } from "../lib/types.js";
import type { SimilarCandidate } from "../lib/similarity.js";
import type { VerifiedSession } from "../lib/tiers.js";
import { DEFAULT_ONTOLOGY_NAMES, type OntologyNames } from "../lib/ontology-names.js";
import type {
  CreateIssueInput,
  CreateIssueResult,
  FoundryAdapter,
  IssueDetail,
  IssueSummary,
  TeamQueue,
} from "./adapter.js";

export const DEFAULT_TIMEOUT_MS = 8_000;
const TOP_PAGE_SIZE = 3;
const SIMILAR_PAGE_SIZE = 20;
const FALLBACK_COUNT_PAGE_SIZE = 100;
const SITE_USERS_PAGE_SIZE = 100;
const COUNT_METRIC = "count";

export type FoundryRequestErrorCategory = "timeout" | "network" | "unauthorized" | "http" | "malformed_response";

/**
 * The only error this module throws. Carries a category and the HTTP status
 * when Foundry answered; never a token, a body, or an error message from Foundry.
 */
export class FoundryRequestError extends Error {
  readonly category: FoundryRequestErrorCategory;
  readonly httpStatus: number | undefined;

  constructor(category: FoundryRequestErrorCategory, httpStatus?: number) {
    super(httpStatus === undefined ? `Foundry request ${category}` : `Foundry request ${category} (HTTP ${httpStatus})`);
    this.name = "FoundryRequestError";
    this.category = category;
    this.httpStatus = httpStatus;
  }
}

export interface RestLogger {
  warn(fields: Record<string, unknown>, message?: string): void;
}

/**
 * What the adapter needs from the auth holder: a token per request, and a way
 * to force a new one after a 401 (getToken alone returns the cached token
 * until it is within its refresh window).
 */
export interface TokenSource {
  getToken(): Promise<string>;
  refresh(): Promise<void>;
}

export interface RestFoundryAdapterOptions {
  stackUrl: string;
  /** Ontology RID or api name; goes into the path. */
  ontology: string;
  tokens: TokenSource;
  logger: RestLogger;
  names?: OntologyNames;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

type Filter = Record<string, unknown>;
type FailCategory = Extract<CreateIssueResult, { kind: "failed" }>["category"];

interface Reply {
  status: number;
  body: unknown;
}

const eq = (field: string, value: string): Filter => ({ type: "eq", field, value });
const inList = (field: string, value: string[]): Filter => ({ type: "in", field, value });
// AndQueryV2/OrQueryV2 carry their children under `value`, like every other SearchJsonQueryV2 node.
const and = (...queries: Filter[]): Filter => ({ type: "and", value: queries });
const or = (...queries: Filter[]): Filter => ({ type: "or", value: queries });
const containsAnyTerm = (field: string, value: string): Filter => ({ type: "containsAnyTerm", field, value });

function str(record: Record<string, unknown> | null, key: string): string {
  const v = record?.[key];
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

function rows(body: unknown): Record<string, unknown>[] {
  const data = asRecord(body)?.data;
  if (!Array.isArray(data)) return [];
  return data.map(asRecord).filter((r): r is Record<string, unknown> => r !== null);
}

export class RestFoundryAdapter implements FoundryAdapter {
  private readonly ontologyPath: string;
  private readonly tokens: TokenSource;
  private readonly logger: RestLogger;
  private readonly names: OntologyNames;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: RestFoundryAdapterOptions) {
    const base = opts.stackUrl.replace(/\/+$/, "");
    this.ontologyPath = `${base}/api/v2/ontologies/${encodeURIComponent(opts.ontology)}`;
    this.tokens = opts.tokens;
    this.logger = opts.logger;
    this.names = opts.names ?? DEFAULT_ONTOLOGY_NAMES;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // ---- reads ---------------------------------------------------------------

  async findUserByPhone(phoneE164: string): Promise<{ userId: string; fullName: string; pinHash: string; siteId: string } | null> {
    const { objectType, properties: p } = this.names.user;
    const body = await this.search(objectType, {
      where: eq(p.phoneE164, phoneE164.trim()),
      pageSize: 1,
      select: [p.userId, p.fullName, p.pinHash, p.siteId],
    });
    const row = rows(body)[0];
    if (!row) return null;
    return { userId: str(row, p.userId), fullName: str(row, p.fullName), pinHash: str(row, p.pinHash), siteId: str(row, p.siteId) };
  }

  async getIssue(_session: VerifiedSession, issueId: string): Promise<IssueDetail | null> {
    const issue = await this.getObject(this.names.issue.objectType, issueId);
    if (!issue) return null;
    const p = this.names.issue.properties;
    return {
      ...this.summary(issue),
      teamName: await this.teamNameFor(issueId, str(issue, p.assignedTeamId)),
      updatedAt: str(issue, p.updatedAt),
      reportedByUserId: str(issue, p.reportedByUserId),
    };
  }

  async listOpenIssuesForUser(session: VerifiedSession): Promise<{ count: number; top: IssueSummary[] }> {
    const p = this.names.issue.properties;
    const where = and(eq(p.reportedByUserId, session.userId), this.openStatusFilter());
    const top = await this.topIssues(where, TOP_PAGE_SIZE);
    const count = await this.countIssues(where);
    return { count, top };
  }

  async getTeamQueueForIssue(_session: VerifiedSession, issueId: string): Promise<TeamQueue | null> {
    const p = this.names.issue.properties;
    const issue = await this.getObject(this.names.issue.objectType, issueId);
    if (!issue) return null;
    const teamId = str(issue, p.assignedTeamId);
    const teamName = await this.teamNameFor(issueId, teamId);
    // Hop 2: the team's open issues. The input issue is removed here rather
    // than with a `not` filter, so one extra row is fetched to keep three.
    const where = and(eq(p.assignedTeamId, teamId), this.openStatusFilter());
    const top = (await this.topIssues(where, TOP_PAGE_SIZE + 1)).filter((i) => i.issueId !== issueId).slice(0, TOP_PAGE_SIZE);
    const inputIsOpen = this.issueStatus(str(issue, p.status)) !== "resolved";
    const openCount = Math.max(0, (await this.countIssues(where)) - (inputIsOpen ? 1 : 0));
    return { teamName, reportedByUserId: str(issue, p.reportedByUserId), openCount, top };
  }

  async countOpenIssuesAtSite(session: VerifiedSession): Promise<{ siteName: string; openCount: number }> {
    const u = this.names.user;
    // Hop 1: site -> users. Hop 2: users -> open issues, counted.
    const users = await this.search(u.objectType, {
      where: eq(u.properties.siteId, session.siteId),
      pageSize: SITE_USERS_PAGE_SIZE,
      select: [u.properties.userId],
    });
    const userIds = rows(users).map((r) => str(r, u.properties.userId)).filter((id) => id.length > 0);
    const p = this.names.issue.properties;
    const openCount = userIds.length === 0 ? 0 : await this.countIssues(and(inList(p.reportedByUserId, userIds), this.openStatusFilter()));
    const site = await this.getObject(this.names.site.objectType, session.siteId);
    const siteName = str(site, this.names.site.properties.name) || session.siteId;
    return { siteName, openCount };
  }

  async findResolvedIssuesMatching(_session: VerifiedSession, terms: string[]): Promise<SimilarCandidate[]> {
    if (terms.length === 0) return [];
    const p = this.names.issue.properties;
    const words = terms.join(" ");
    const body = await this.search(this.names.issue.objectType, {
      where: and(eq(p.status, this.names.statusValues.resolved), or(containsAnyTerm(p.title, words), containsAnyTerm(p.description, words))),
      orderBy: { fields: [{ field: p.updatedAt, direction: "desc" }] },
      pageSize: SIMILAR_PAGE_SIZE,
      select: [p.issueId, p.title, p.description, p.resolution],
    });
    return rows(body).map((r) => ({
      issueId: str(r, p.issueId),
      title: str(r, p.title),
      description: str(r, p.description),
      resolution: str(r, p.resolution),
    }));
  }

  // ---- write ---------------------------------------------------------------

  async createIssue(session: VerifiedSession, input: CreateIssueInput): Promise<CreateIssueResult> {
    const { createIssue, parameters: a } = this.names.action;
    const request = {
      parameters: {
        [a.issueId]: input.issueId,
        [a.title]: input.title,
        [a.description]: input.description,
        [a.priority]: input.priority,
        [a.reportedBy]: session.userId,
        [a.assignedTeam]: this.names.triageTeamId,
        [a.sourceConversationId]: input.sourceConversationId,
      },
      options: { returnEdits: "ALL" },
    };
    let reply: Reply;
    try {
      reply = await this.request("POST", `/actions/${encodeURIComponent(createIssue)}/apply`, request, { tolerate: "all" });
    } catch (error) {
      const status = error instanceof FoundryRequestError ? error.httpStatus : undefined;
      return this.createFailed(status, "unknown");
    }
    const outcome = this.mapCreateReply(reply);
    if (outcome.kind === "failed") return this.createFailed(reply.status, outcome.category, outcome.parameter);
    return outcome;
  }

  private mapCreateReply(reply: Reply): CreateIssueResult {
    const { status, body } = reply;
    const record = asRecord(body);
    const errorName = str(record, "errorName");
    if (errorName === "ObjectAlreadyExists") return { kind: "failed", category: "duplicate_key", parameter: this.names.action.parameters.issueId };
    if (status === 403) return { kind: "failed", category: "permission" };

    const validation = this.validationFailure(record);
    if (validation) return validation;

    if (status >= 200 && status < 300) {
      const objectType = this.names.issue.objectType;
      const added = this.addedObjects(record);
      const created = added.find((e) => e.objectType === objectType) ?? (added.length === 1 ? added[0] : undefined);
      if (created && created.primaryKey.length > 0) return { kind: "created", issueId: created.primaryKey };
      return { kind: "failed", category: "unknown" };
    }
    if (status === 400) return { kind: "failed", category: "validation" };
    return { kind: "failed", category: "unknown" };
  }

  /**
   * Reads the validation block from a success body (`validation`) or an
   * ActionValidationFailed error body (`parameters.validation` /
   * `parameters.validationResult`). A failed submission criterion is the
   * Action's fail-closed path (plan KTD4a) and maps to `permission`; an
   * invalid `issueId` is the duplicate-key signal (plan KTD16).
   */
  private validationFailure(record: Record<string, unknown> | null): Extract<CreateIssueResult, { kind: "failed" }> | null {
    const params = asRecord(record?.parameters);
    const validation = asRecord(record?.validation) ?? asRecord(params?.validation) ?? asRecord(params?.validationResult);
    if (!validation) return null;
    const criteria = Array.isArray(validation.submissionCriteria) ? validation.submissionCriteria : [];
    if (criteria.some((c) => asRecord(c)?.result === "INVALID")) return { kind: "failed", category: "permission" };
    const invalid = Object.entries(asRecord(validation.parameters) ?? {})
      .filter(([, v]) => asRecord(v)?.result === "INVALID")
      .map(([id]) => id);
    if (invalid.length === 0) {
      return validation.result === "INVALID" ? { kind: "failed", category: "validation" } : null;
    }
    const issueIdParam = this.names.action.parameters.issueId;
    if (invalid.includes(issueIdParam)) return { kind: "failed", category: "duplicate_key", parameter: issueIdParam };
    return { kind: "failed", category: "validation", parameter: invalid[0] };
  }

  private addedObjects(record: Record<string, unknown> | null): Array<{ objectType: string; primaryKey: string }> {
    const edits = asRecord(record?.edits)?.edits;
    if (!Array.isArray(edits)) return [];
    const out: Array<{ objectType: string; primaryKey: string }> = [];
    for (const edit of edits) {
      const e = asRecord(edit);
      if (e?.type !== "addObject") continue;
      out.push({ objectType: str(e, "objectType"), primaryKey: str(e, "primaryKey") });
    }
    return out;
  }

  private createFailed(status: number | undefined, category: FailCategory, parameter?: string): CreateIssueResult {
    this.logger.warn({ event: "foundry_create_failed", status: status ?? null, category, parameter: parameter ?? null });
    return parameter === undefined ? { kind: "failed", category } : { kind: "failed", category, parameter };
  }

  // ---- helpers -------------------------------------------------------------

  private openStatusFilter(): Filter {
    const s = this.names.statusValues;
    return inList(this.names.issue.properties.status, [s.open, s.in_progress]);
  }

  private issueStatus(stored: string): IssueStatus {
    const s = this.names.statusValues;
    if (stored === s.in_progress) return "in_progress";
    if (stored === s.resolved) return "resolved";
    return "open";
  }

  private summary(row: Record<string, unknown>): IssueSummary {
    const p = this.names.issue.properties;
    return { issueId: str(row, p.issueId), title: str(row, p.title), status: this.issueStatus(str(row, p.status)) };
  }

  private async topIssues(where: Filter, pageSize: number): Promise<IssueSummary[]> {
    const p = this.names.issue.properties;
    const body = await this.search(this.names.issue.objectType, {
      where,
      orderBy: { fields: [{ field: p.updatedAt, direction: "desc" }] },
      pageSize,
      select: [p.issueId, p.title, p.status],
    });
    return rows(body).map((r) => this.summary(r));
  }

  /** Aggregate count with the same filter; falls back to counting a page-size-100 search when the aggregate is refused. */
  private async countIssues(where: Filter): Promise<number> {
    const objectType = this.names.issue.objectType;
    const reply = await this.request("POST", `/objects/${encodeURIComponent(objectType)}/aggregate`, {
      aggregation: [{ type: "count", name: COUNT_METRIC }],
      groupBy: [],
      where,
    }, { tolerate: [400, 404] });
    if (reply.status >= 200 && reply.status < 300) {
      const metrics = asRecord(rows(reply.body)[0])?.metrics;
      const metric = Array.isArray(metrics) ? metrics.map(asRecord).find((m) => m?.name === COUNT_METRIC) : undefined;
      const value = Number(metric?.value);
      if (Number.isFinite(value)) return value;
      if (rows(reply.body).length === 0) return 0;
    }
    this.logger.warn({ event: "foundry_aggregate_fallback", status: reply.status });
    const page = await this.search(objectType, { where, pageSize: FALLBACK_COUNT_PAGE_SIZE, select: [this.names.issue.properties.issueId] });
    return rows(page).length;
  }

  /** Team name via the issue's assignedTeam link, then the Team object by key, then the raw id. */
  private async teamNameFor(issueId: string, teamId: string): Promise<string> {
    const { objectType, links } = this.names.issue;
    const nameProp = this.names.team.properties.name;
    const linked = await this.request(
      "GET",
      `/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(issueId)}/links/${encodeURIComponent(links.assignedTeam)}`,
      undefined,
      { tolerate: [404] },
    );
    const viaLink = str(rows(linked.body)[0] ?? null, nameProp);
    if (viaLink.length > 0) return viaLink;
    if (teamId.length === 0) return "";
    const team = await this.getObject(this.names.team.objectType, teamId);
    return str(team, nameProp) || teamId;
  }

  private async search(objectType: string, body: Record<string, unknown>): Promise<unknown> {
    const reply = await this.request("POST", `/objects/${encodeURIComponent(objectType)}/search`, body);
    return reply.body;
  }

  /** GET by primary key; null on 404. */
  private async getObject(objectType: string, primaryKey: string): Promise<Record<string, unknown> | null> {
    const reply = await this.request("GET", `/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(primaryKey)}`, undefined, {
      tolerate: [404],
    });
    if (reply.status === 404) return null;
    return asRecord(reply.body);
  }

  /**
   * One authenticated request. On a 401 it forces a token refresh and retries
   * once with the new token; a refresh that fails is `unauthorized`. Any
   * non-2xx status not covered by `tolerate` (a status list, or "all" for the
   * Action, whose error bodies carry the validation block) throws
   * FoundryRequestError with the status only. The body is parsed as JSON and returned to the caller for
   * field extraction; it is never logged or placed in an error.
   */
  private async request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    opts: { tolerate?: number[] | "all" } = {},
  ): Promise<Reply> {
    const url = `${this.ontologyPath}${path}`;
    const resource = path.split("/").slice(1, 3).join("/");
    const attempt = async (token: string): Promise<Response> => {
      try {
        return await this.fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        const category: FoundryRequestErrorCategory = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
        this.logger.warn({ event: "foundry_request_failed", method, resource, status: null, category });
        throw new FoundryRequestError(category);
      }
    };

    let response = await attempt(await this.tokens.getToken());
    if (response.status === 401) {
      // getToken() alone would hand back the same cached token until it is
      // within its refresh window, so a token revoked mid-life must be
      // refreshed explicitly before the single retry.
      try {
        await this.tokens.refresh();
      } catch (error) {
        if (!(error instanceof FoundryAuthError)) throw error;
        this.logger.warn({ event: "foundry_request_failed", method, resource, status: 401, category: "unauthorized" });
        throw new FoundryRequestError("unauthorized", 401);
      }
      response = await attempt(await this.tokens.getToken());
      if (response.status === 401) {
        this.logger.warn({ event: "foundry_request_failed", method, resource, status: 401, category: "unauthorized" });
        throw new FoundryRequestError("unauthorized", 401);
      }
    }

    const status = response.status;
    let parsed: unknown = null;
    const text = await response.text().catch(() => "");
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (status >= 200 && status < 300) {
          this.logger.warn({ event: "foundry_request_failed", method, resource, status, category: "malformed_response" });
          throw new FoundryRequestError("malformed_response", status);
        }
      }
    }
    const ok = (status >= 200 && status < 300) || opts.tolerate === "all" || (opts.tolerate ?? []).includes(status);
    if (!ok) {
      this.logger.warn({ event: "foundry_request_failed", method, resource, status, category: "http" });
      throw new FoundryRequestError("http", status);
    }
    return { status, body: parsed };
  }
}
