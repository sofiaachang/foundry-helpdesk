// The eight tool handlers (plan U9). Each one validates its body against the
// contract, runs the tier gate, calls the injected adapter with the
// VerifiedSession the gate minted, shapes the answer for speech, and returns
// the contract envelope. The adapter arrives by injection from server.ts; this
// file imports only its type, so it cannot reach Foundry on its own
// (scripts/check-no-disclosure.sh).

import { randomInt } from "node:crypto";
import type { CreateIssueInput, FoundryAdapter } from "./foundry/adapter.js";
import { normalizeIssueId } from "./lib/identifiers.js";
import { CreateIdempotency } from "./lib/idempotency.js";
import { rankSimilar, salientTerms } from "./lib/similarity.js";
import type { CallerLockout, Clock, SessionStore } from "./lib/sessions.js";
import {
  CREATE_FAILED_SPEECH,
  ESCALATE_SPEECH,
  LOCKED_SPEECH,
  NOT_VERIFIED_SPEECH,
  NO_SIMILAR_SPEECH,
  REFUSED_TIER_SPEECH,
  RETRY_SPEECH,
  VERIFIED_SPEECH,
  createdSpeech,
  issueIdNotCaughtSpeech,
  issueNotFoundSpeech,
  issueStatusSpeech,
  myOpenIssuesSpeech,
  similarMatchSpeech,
  siteCountSpeech,
  teamQueueSpeech,
} from "./lib/speech.js";
import { gate, ownsIssue, type VerifiedSession } from "./lib/tiers.js";
import { type Envelope, type Priority, type ToolName, failed } from "./lib/types.js";
import type { Verifier } from "./lib/verification.js";
import type { Logger } from "./observability/log.js";
import type { ToolContext, ToolHandler, ToolHandlers } from "./routes/tools.js";

export interface HandlerDeps {
  adapter: FoundryAdapter;
  sessions: SessionStore;
  /** Owned by the verifier; listed so the composition root wires one instance for both. */
  lockout: CallerLockout;
  verifier: Verifier;
  idempotency: CreateIdempotency;
  logger: Logger;
  clock: Clock;
  /** Four-digit identifier in 5000..9999 (KTD16). Injected so tests are deterministic. */
  drawIssueId?: () => string;
}

/** Everything the escalation log line may carry (KTD12). Never digits, never caller id. */
export interface EscalationLogFields {
  event: "escalation";
  conversation_id: string;
  verification_state: string;
  caller_name?: string;
  last_tool: ToolName | null;
  summary: string;
  timestamp: string;
}

export const ISSUE_ID_MIN = 5000;
export const ISSUE_ID_MAX = 9999;

export function defaultDrawIssueId(): string {
  return String(randomInt(ISSUE_ID_MIN, ISSUE_ID_MAX + 1));
}

const PRIORITIES: readonly Priority[] = ["low", "normal", "high"];
const COMMON_FIELDS = new Set(["conversation_id", "caller_id"]);
const CREATE_FIELDS = new Set([...COMMON_FIELDS, "title", "description", "priority"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringField(body: Record<string, unknown>, name: string, min: number, max: number): string | null {
  const value = body[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= min && trimmed.length <= max ? trimmed : null;
}

function envelope(status: Envelope["status"], speech: string, escalate: boolean, data: Record<string, unknown> = {}): Envelope {
  return { status, speech, escalate, data };
}

const notVerified = () => envelope("not_verified", NOT_VERIFIED_SPEECH, false);
const locked = () => envelope("locked", LOCKED_SPEECH, true);
const refusedTier = () => envelope("refused_tier", REFUSED_TIER_SPEECH, true);

/** Thrown inside the idempotent create so the record settles as `failed` and a retry never re-applies. */
class CreateFailedError extends Error {
  constructor(readonly category: string) {
    super(`create failed: ${category}`);
  }
}

/** Only the summary needs digit stripping: it is the one free-text field in the packet. */
function stripDigits(text: string): string {
  return text.replace(/\d{2,}/g, "[number]").replace(/\s+/g, " ").trim();
}

export function buildHandlers(deps: HandlerDeps): ToolHandlers {
  const { adapter, sessions, verifier, idempotency, logger, clock } = deps;
  const drawIssueId = deps.drawIssueId ?? defaultDrawIssueId;

  /** Last tool and last confirmed issue title per conversation, for the escalation packet. */
  const recent = new Map<string, { lastTool: ToolName; summary?: string; at: number }>();
  const remember = (conversationId: string, lastTool: ToolName, summary?: string) => {
    const prev = recent.get(conversationId);
    recent.set(conversationId, { lastTool, summary: summary ?? prev?.summary, at: clock() });
  };

  /** Runs a tier-1 tool: gate, then the body with the minted session. Any throw becomes `failed`. */
  const tier1 =
    (name: ToolName, run: (session: VerifiedSession, body: Record<string, unknown>) => Promise<Envelope>): ToolHandler =>
    async (ctx: ToolContext) => {
      const body = asRecord(ctx.body) ?? {};
      const result = gate(sessions, name, body.conversation_id);
      if (result.kind === "not_verified") return notVerified();
      if (result.kind === "locked") return locked();
      if (result.kind === "refused_tier" || result.kind === "tier0") return refusedTier();
      try {
        const env = await run(result.session, body);
        remember(result.session.conversationId, name);
        return env;
      } catch (error) {
        logger.warn({ event: "tool_failed", tool: name, name: error instanceof Error ? error.name : "Error" });
        return failed();
      }
    };

  const verify_caller: ToolHandler = async (ctx) => {
    const body = asRecord(ctx.body) ?? {};
    const raw = body.digits;
    const digits = typeof raw === "string" && raw.length <= 8 ? raw : "";
    const result = await verifier.verify({ conversationId: body.conversation_id, callerId: body.caller_id, digits });
    switch (result.status) {
      case "verified":
        return envelope("ok", VERIFIED_SPEECH, false, { verified: true });
      case "retry":
        return envelope("not_verified", RETRY_SPEECH, false, { verified: false, attempts: result.attempts });
      case "locked":
        return locked();
      case "not_verified":
        return notVerified();
    }
  };

  const get_issue_status = tier1("get_issue_status", async (session, body) => {
    const issueId = normalizeIssueId(body.issue_id);
    if (!issueId) return envelope("not_found", issueIdNotCaughtSpeech(), false);
    const issue = await adapter.getIssue(session, issueId);
    if (!issue || !ownsIssue(session, issue.reportedByUserId)) {
      return envelope("not_found", issueNotFoundSpeech(issueId), false, { issue_id: issueId });
    }
    return envelope("ok", issueStatusSpeech(issue), false, { issue_id: issue.issueId, status: issue.status, team: issue.teamName });
  });

  const list_my_open_issues = tier1("list_my_open_issues", async (session) => {
    const { count, top } = await adapter.listOpenIssuesForUser(session);
    const issues = top.slice(0, 3).map((i) => ({ issue_id: i.issueId, title: i.title, status: i.status }));
    return envelope("ok", myOpenIssuesSpeech(count, top), false, { count, issues });
  });

  const get_team_queue_for_issue = tier1("get_team_queue_for_issue", async (session, body) => {
    const issueId = normalizeIssueId(body.issue_id);
    if (!issueId) return envelope("not_found", issueIdNotCaughtSpeech(), false);
    const queue = await adapter.getTeamQueueForIssue(session, issueId);
    if (!queue || !ownsIssue(session, queue.reportedByUserId)) {
      return envelope("not_found", issueNotFoundSpeech(issueId), false, { issue_id: issueId });
    }
    const issues = queue.top.slice(0, 3).map((i) => ({ issue_id: i.issueId, title: i.title, status: i.status }));
    return envelope("ok", teamQueueSpeech(queue.teamName, queue.openCount, queue.top), false, {
      team: queue.teamName,
      open_count: queue.openCount,
      issues,
    });
  });

  const count_site_open_issues = tier1("count_site_open_issues", async (session) => {
    const { siteName, openCount } = await adapter.countOpenIssuesAtSite(session);
    return envelope("ok", siteCountSpeech(siteName, openCount), false, { site: siteName, open_count: openCount });
  });

  const find_similar_issues = tier1("find_similar_issues", async (session, body) => {
    const description = stringField(body, "description", 10, 1000);
    if (!description) return failed();
    const terms = salientTerms(description);
    const candidates = terms.length > 0 ? await adapter.findResolvedIssuesMatching(session, terms) : [];
    const match = rankSimilar(description, candidates);
    if (!match) return envelope("not_found", NO_SIMILAR_SPEECH, false, { match: null });
    return envelope("ok", similarMatchSpeech(match.resolution), false, {
      match: { issue_id: match.issueId, resolution: match.resolution },
    });
  });

  const create_issue = tier1("create_issue", async (session, body) => {
    // Reporter, team, and conversation id are never accepted from the body (KTD8).
    for (const key of Object.keys(body)) if (!CREATE_FIELDS.has(key)) return failed();
    const title = stringField(body, "title", 5, 120);
    const description = stringField(body, "description", 10, 2000);
    const priority = body.priority;
    if (!title || !description || typeof priority !== "string" || !(PRIORITIES as readonly string[]).includes(priority)) {
      return failed();
    }
    const fields = { title, description, priority: priority as Priority };
    remember(session.conversationId, "create_issue", title);

    const apply = async (): Promise<string> => {
      const attempt = async (issueId: string) => {
        const input: CreateIssueInput = { issueId, ...fields, sourceConversationId: session.conversationId };
        return adapter.createIssue(session, input);
      };
      let result = await attempt(drawIssueId());
      // A duplicate key is redrawn once (KTD16); anything else is final for this conversation.
      if (result.kind === "failed" && result.category === "duplicate_key") result = await attempt(drawIssueId());
      if (result.kind === "failed") throw new CreateFailedError(result.category);
      return result.issueId;
    };

    const outcome = idempotency.run(session.conversationId, fields, apply);
    if (outcome.kind === "mismatch") {
      logger.warn({ event: "create_mismatch", conversation_id: session.conversationId });
      return envelope("failed", CREATE_FAILED_SPEECH, true);
    }
    try {
      const issueId = await outcome.result;
      return envelope("ok", createdSpeech(issueId), false, { issue_id: issueId });
    } catch (error) {
      const category = error instanceof CreateFailedError ? error.category : "thrown";
      logger.warn({ event: "create_failed", conversation_id: session.conversationId, category });
      return envelope("failed", CREATE_FAILED_SPEECH, true);
    }
  });

  const escalate: ToolHandler = async (ctx) => {
    const body = asRecord(ctx.body) ?? {};
    // A malformed id is refused like every other tool; a valid one may start the session (tier 0).
    const session = sessions.getOrCreate(body.conversation_id);
    if (!session) return notVerified();
    const conversationId = session.conversationId;
    const reason = stringField(body, "reason", 0, 300) ?? "";
    const memory = recent.get(conversationId);
    const packet: EscalationLogFields = {
      event: "escalation",
      conversation_id: conversationId,
      verification_state: session.state,
      last_tool: memory?.lastTool ?? null,
      summary: stripDigits(memory?.summary ?? reason),
      timestamp: new Date(clock()).toISOString(),
    };
    if (session.state === "verified" && session.user) packet.caller_name = session.user.fullName;
    logger.info(packet);
    sessions.markEscalated(conversationId);
    recent.delete(conversationId);
    return envelope("escalate", ESCALATE_SPEECH, true, { recorded: true });
  };

  return {
    verify_caller,
    get_issue_status,
    list_my_open_issues,
    get_team_queue_for_issue,
    count_site_open_issues,
    find_similar_issues,
    create_issue,
    escalate,
  };
}
