// Shared contract shapes. Mirrors docs/contract/integration-contract.md; that
// document is authoritative when they disagree.

export const STATUSES = [
  "ok",
  "not_verified",
  "locked",
  "not_found",
  "refused_tier",
  "failed",
  "escalate",
] as const;
export type Status = (typeof STATUSES)[number];

export interface Envelope<TData = Record<string, unknown>> {
  status: Status;
  speech: string;
  escalate: boolean;
  data: TData;
}

export const TOOL_NAMES = [
  "verify_caller",
  "get_issue_status",
  "list_my_open_issues",
  "get_team_queue_for_issue",
  "count_site_open_issues",
  "find_similar_issues",
  "create_issue",
  "escalate",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export type Priority = "low" | "normal" | "high";
export type IssueStatus = "open" | "in_progress" | "resolved";

/** Conversation identifiers come from ElevenLabs; anything else is refused. */
export const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export const FAILED_SPEECH = "I couldn't complete that. I can have a person call you back.";

export function failed(): Envelope {
  return { status: "failed", speech: FAILED_SPEECH, escalate: true, data: {} };
}
