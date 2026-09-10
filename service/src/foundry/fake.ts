// In-memory FoundryAdapter over the seed CSVs (ontology/seed/*.csv). Used for
// local runs and route tests before the OSDK adapter exists (U8). Answers the
// same interface with the same two-hop pivots: team queue is issue -> team ->
// that team's open issues; site count is session site -> users -> open issues.
// server.ts refuses this adapter in production.

import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import type { SimilarCandidate } from "../lib/similarity.js";
import type { IssueStatus, Priority } from "../lib/types.js";
import type { VerifiedSession } from "../lib/tiers.js";
import type {
  CreateIssueInput,
  CreateIssueResult,
  FoundryAdapter,
  IssueDetail,
  IssueSummary,
  TeamQueue,
} from "./adapter.js";

export interface UserRow {
  userId: string;
  fullName: string;
  phoneE164: string;
  pinHash: string;
  siteId: string;
}

export interface IssueRow {
  issueId: string;
  title: string;
  description: string;
  status: IssueStatus;
  priority: Priority;
  resolution: string;
  reportedByUserId: string;
  assignedTeamId: string;
  sourceConversationId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SiteRow {
  siteId: string;
  name: string;
}

export interface TeamRow {
  teamId: string;
  name: string;
}

export interface FakeRows {
  users: UserRow[];
  issues: IssueRow[];
  sites: SiteRow[];
  teams: TeamRow[];
}

export type FailCategory = Extract<CreateIssueResult, { kind: "failed" }>["category"];

/** The team every new issue lands on (KTD8); seeded in teams.csv. */
export const TRIAGE_TEAM_ID = "triage";

/** Minimal RFC 4180 parser: quoted fields, doubled quotes, CRLF, newlines inside quotes. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows;
  if (!header) return [];
  return body
    .filter((r) => r.length > 1 || (r[0] ?? "").length > 0)
    .map((r) => Object.fromEntries(header.map((name, i) => [name, r[i] ?? ""])));
}

function isOpen(issue: IssueRow): boolean {
  return issue.status !== "resolved";
}

function newestFirst(a: IssueRow, b: IssueRow): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

function summary(issue: IssueRow): IssueSummary {
  return { issueId: issue.issueId, title: issue.title, status: issue.status };
}

const MAX_TOP = 3;

export class FakeFoundryAdapter implements FoundryAdapter {
  readonly users: UserRow[];
  readonly issues: IssueRow[];
  readonly sites: SiteRow[];
  readonly teams: TeamRow[];

  /** Test hooks. */
  readCalls = 0;
  createCalls = 0;
  createDelayMs = 0;
  lastCreate: { session: VerifiedSession; input: CreateIssueInput } | null = null;
  private pendingFailure: FailCategory | null = null;
  private pendingThrow: unknown = null;

  constructor(rows: FakeRows) {
    this.users = [...rows.users];
    this.issues = [...rows.issues];
    this.sites = [...rows.sites];
    this.teams = [...rows.teams];
  }

  static fromCsvDir(dir: string): FakeFoundryAdapter {
    const load = (name: string) => parseCsv(readFileSync(join(dir, name), "utf8"));
    return new FakeFoundryAdapter({
      users: load("users.csv") as unknown as UserRow[],
      issues: load("issues.csv") as unknown as IssueRow[],
      sites: load("sites.csv") as unknown as SiteRow[],
      teams: load("teams.csv") as unknown as TeamRow[],
    });
  }

  /** Make the next createIssue fail with the given category (AE7). */
  failNext(category: FailCategory): void {
    this.pendingFailure = category;
  }

  /** Make the next createIssue throw, to test the route's error envelope. */
  throwNext(error: unknown): void {
    this.pendingThrow = error;
  }

  addIssue(partial: Partial<IssueRow> & Pick<IssueRow, "issueId" | "title" | "status" | "reportedByUserId" | "assignedTeamId">): void {
    const now = new Date(0).toISOString();
    this.issues.push({
      description: "",
      priority: "normal",
      resolution: "",
      sourceConversationId: "",
      createdAt: now,
      updatedAt: now,
      ...partial,
    });
  }

  private teamName(teamId: string): string {
    return this.teams.find((t) => t.teamId === teamId)?.name ?? teamId;
  }

  async findUserByPhone(phoneE164: string): Promise<UserRow | null> {
    const user = this.users.find((u) => u.phoneE164 === phoneE164);
    return user ? { ...user } : null;
  }

  async getIssue(_session: VerifiedSession, issueId: string): Promise<IssueDetail | null> {
    this.readCalls++;
    const issue = this.issues.find((i) => i.issueId === issueId);
    if (!issue) return null;
    return { ...summary(issue), teamName: this.teamName(issue.assignedTeamId), updatedAt: issue.updatedAt, reportedByUserId: issue.reportedByUserId };
  }

  async listOpenIssuesForUser(session: VerifiedSession): Promise<{ count: number; top: IssueSummary[] }> {
    this.readCalls++;
    const mine = this.issues.filter((i) => i.reportedByUserId === session.userId && isOpen(i)).sort(newestFirst);
    return { count: mine.length, top: mine.slice(0, MAX_TOP).map(summary) };
  }

  async getTeamQueueForIssue(_session: VerifiedSession, issueId: string): Promise<TeamQueue | null> {
    this.readCalls++;
    const issue = this.issues.find((i) => i.issueId === issueId);
    if (!issue) return null;
    // Hop 1: issue -> team. Hop 2: team -> its open issues, minus the input.
    const teamId = issue.assignedTeamId;
    const queue = this.issues.filter((i) => i.assignedTeamId === teamId && i.issueId !== issueId && isOpen(i)).sort(newestFirst);
    return {
      teamName: this.teamName(teamId),
      reportedByUserId: issue.reportedByUserId,
      openCount: queue.length,
      top: queue.slice(0, MAX_TOP).map(summary),
    };
  }

  async countOpenIssuesAtSite(session: VerifiedSession): Promise<{ siteName: string; openCount: number }> {
    this.readCalls++;
    // Hop 1: site -> users. Hop 2: users -> open issues.
    const userIds = new Set(this.users.filter((u) => u.siteId === session.siteId).map((u) => u.userId));
    const openCount = this.issues.filter((i) => userIds.has(i.reportedByUserId) && isOpen(i)).length;
    const siteName = this.sites.find((s) => s.siteId === session.siteId)?.name ?? session.siteId;
    return { siteName, openCount };
  }

  async findResolvedIssuesMatching(
    _session: VerifiedSession,
    terms: string[],
  ): Promise<SimilarCandidate[]> {
    this.readCalls++;
    if (terms.length === 0) return [];
    const wanted = new Set(terms.map((t) => t.toLowerCase()));
    const containsAnyTerm = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).some((w) => wanted.has(w));
    return this.issues
      .filter((i) => i.status === "resolved" && (containsAnyTerm(i.title) || containsAnyTerm(i.description)))
      .sort(newestFirst)
      .map((i) => ({ issueId: i.issueId, resolution: i.resolution, title: i.title, description: i.description }));
  }

  async createIssue(session: VerifiedSession, input: CreateIssueInput): Promise<CreateIssueResult> {
    this.createCalls++;
    this.lastCreate = { session, input };
    if (this.createDelayMs > 0) await delay(this.createDelayMs);
    if (this.pendingThrow !== null) {
      const error = this.pendingThrow;
      this.pendingThrow = null;
      throw error;
    }
    if (this.pendingFailure) {
      const category = this.pendingFailure;
      this.pendingFailure = null;
      return { kind: "failed", category };
    }
    if (!/^\d{4}$/.test(input.issueId)) return { kind: "failed", category: "validation", parameter: "issueId" };
    if (input.title.trim().length === 0) return { kind: "failed", category: "validation", parameter: "title" };
    if (input.description.trim().length === 0) return { kind: "failed", category: "validation", parameter: "description" };
    if (this.issues.some((i) => i.issueId === input.issueId)) return { kind: "failed", category: "duplicate_key", parameter: "issueId" };
    const now = new Date().toISOString();
    this.issues.push({
      issueId: input.issueId,
      title: input.title,
      description: input.description,
      status: "open",
      priority: input.priority,
      resolution: "",
      reportedByUserId: session.userId,
      assignedTeamId: TRIAGE_TEAM_ID,
      sourceConversationId: input.sourceConversationId,
      createdAt: now,
      updatedAt: now,
    });
    return { kind: "created", issueId: input.issueId };
  }
}
