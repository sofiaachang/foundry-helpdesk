// Pure functions behind scripts/latency-report.ts (plan U15, KTD13). Input is
// an ndjson export of the service log; output is a markdown report. No I/O here.
//
// Imports use explicit .ts extensions because Node 26 runs these scripts
// directly (type stripping), and scripts/ sits outside the tsc rootDir.

import { asRecord } from "../src/lib/types.ts";

export interface TurnLine {
  event: "postcall_turn";
  conversation_id: string | null;
  turn_index: number;
  role: string | null;
  time_in_call_secs: number | null;
  tool_names: string[];
  ttfb_ms: number | null;
  ttf_sentence_ms: number | null;
}

export interface ToolCallLine {
  event: "tool_call";
  tool: string;
  conversation_id: string | null;
  status: string;
  duration_ms: number;
  issue_id?: string;
}

export type LogLine = TurnLine | ToolCallLine;

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function tryParse(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Accepts a bare pino line, or a Railway export row whose `message` holds the pino line. */
function unwrap(record: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof record.event === "string") return record;
  if (typeof record.message === "string") {
    const inner = tryParse(record.message);
    if (inner && typeof inner.event === "string") return inner;
  }
  return null;
}

function toLogLine(record: Record<string, unknown>): LogLine | null {
  if (record.event === "postcall_turn") {
    const turn_index = numberOrNull(record.turn_index);
    if (turn_index === null) return null;
    const tools = Array.isArray(record.tool_names) ? record.tool_names.filter((t): t is string => typeof t === "string") : [];
    return {
      event: "postcall_turn",
      conversation_id: stringOrNull(record.conversation_id),
      turn_index,
      role: stringOrNull(record.role),
      time_in_call_secs: numberOrNull(record.time_in_call_secs),
      tool_names: tools,
      ttfb_ms: numberOrNull(record.ttfb_ms),
      ttf_sentence_ms: numberOrNull(record.ttf_sentence_ms),
    };
  }
  if (record.event === "tool_call") {
    const duration_ms = numberOrNull(record.duration_ms);
    if (duration_ms === null || typeof record.tool !== "string") return null;
    const line: ToolCallLine = {
      event: "tool_call",
      tool: record.tool,
      conversation_id: stringOrNull(record.conversation_id),
      status: typeof record.status === "string" ? record.status : "unknown",
      duration_ms,
    };
    if (typeof record.issue_id === "string") line.issue_id = record.issue_id;
    return line;
  }
  return null;
}

/** Parses ndjson text, keeping only postcall_turn and tool_call lines. */
export function parseLogLines(text: string): LogLine[] {
  const out: LogLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const record = tryParse(trimmed);
    if (!record) continue;
    const unwrapped = unwrap(record);
    if (!unwrapped) continue;
    const line = toLogLine(unwrapped);
    if (line) out.push(line);
  }
  return out;
}

/** Linear-interpolated percentile (the PERCENTILE.INC / numpy default). Null on empty input. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.min(100, Math.max(0, p));
  const position = (clamped / 100) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower] as number;
  const upperValue = sorted[upper] as number;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

export function median(values: number[]): number | null {
  return percentile(values, 50);
}

export interface ConversationPair {
  turns: TurnLine[];
  toolCalls: ToolCallLine[];
}

export interface JoinResult {
  /** Conversation ids present in both sources, in first-seen order. */
  matched: Map<string, ConversationPair>;
  /** Ids with postcall_turn lines but no tool_call lines. */
  turnsOnly: string[];
  /** Ids with tool_call lines but no postcall_turn lines. */
  toolsOnly: string[];
}

export function joinByConversation(lines: LogLine[]): JoinResult {
  const byId = new Map<string, ConversationPair>();
  for (const line of lines) {
    if (line.conversation_id === null) continue;
    let pair = byId.get(line.conversation_id);
    if (!pair) {
      pair = { turns: [], toolCalls: [] };
      byId.set(line.conversation_id, pair);
    }
    if (line.event === "postcall_turn") pair.turns.push(line);
    else pair.toolCalls.push(line);
  }
  const matched = new Map<string, ConversationPair>();
  const turnsOnly: string[] = [];
  const toolsOnly: string[] = [];
  for (const [id, pair] of byId) {
    if (pair.turns.length > 0 && pair.toolCalls.length > 0) matched.set(id, pair);
    else if (pair.turns.length > 0) turnsOnly.push(id);
    else toolsOnly.push(id);
  }
  return { matched, turnsOnly, toolsOnly };
}

const TTF_SENTENCE_LABEL =
  "time to first sentence, the R20 proxy; true time to first audio adds text-to-speech latency the webhook does not expose";

function fmt(value: number | null): string {
  return value === null ? "n/a" : String(Math.round(value));
}

function statsRow(label: string, values: number[]): string {
  return `| ${label} | ${values.length} | ${fmt(median(values))} | ${fmt(percentile(values, 95))} |`;
}

export function buildReport(lines: LogLine[]): string {
  const turns = lines.filter((l): l is TurnLine => l.event === "postcall_turn");
  const toolCalls = lines.filter((l): l is ToolCallLine => l.event === "tool_call");
  const out: string[] = ["# Latency report", ""];

  out.push(`## Time to first sentence (${TTF_SENTENCE_LABEL})`, "");
  if (turns.length === 0) {
    out.push("_No data: no postcall_turn lines in the export._", "");
  } else {
    const withMetric = turns.filter((t) => t.ttf_sentence_ms !== null);
    const toolBearing = withMetric.filter((t) => t.tool_names.length > 0).map((t) => t.ttf_sentence_ms as number);
    const plain = withMetric.filter((t) => t.tool_names.length === 0).map((t) => t.ttf_sentence_ms as number);
    out.push(
      "| Turn kind | Count | Median ms | p95 ms |",
      "|---|---|---|---|",
      statsRow("Tool-bearing turns", toolBearing),
      statsRow("Plain turns", plain),
      statsRow("All turns", [...toolBearing, ...plain]),
      "",
      `Turns in export: ${turns.length}; turns without a ttf_sentence metric (user turns, or agent turns with no LLM call): ${turns.length - withMetric.length}.`,
      "",
    );
  }

  out.push("## Per-tool duration (service-side, from tool_call lines)", "");
  if (toolCalls.length === 0) {
    out.push("_No data: no tool_call lines in the export._", "");
  } else {
    const byTool = new Map<string, number[]>();
    for (const call of toolCalls) {
      const list = byTool.get(call.tool) ?? [];
      list.push(call.duration_ms);
      byTool.set(call.tool, list);
    }
    out.push("| Tool | Count | Median ms | p95 ms |", "|---|---|---|---|");
    for (const [tool, durations] of [...byTool].sort(([a], [b]) => a.localeCompare(b))) {
      out.push(statsRow(tool, durations));
    }
    out.push("");
  }

  const joined = joinByConversation(lines);
  out.push("## Conversation join", "");
  out.push(`Conversations with both webhook turns and tool timings: ${joined.matched.size}.`);
  out.push(
    `Conversations with webhook turns but no tool timings: ${joined.turnsOnly.length}${joined.turnsOnly.length ? ` (${joined.turnsOnly.join(", ")})` : ""}.`,
  );
  out.push(
    `Conversations with tool timings but no webhook turns: ${joined.toolsOnly.length}${joined.toolsOnly.length ? ` (${joined.toolsOnly.join(", ")})` : ""}.`,
  );
  out.push("");
  return out.join("\n");
}
