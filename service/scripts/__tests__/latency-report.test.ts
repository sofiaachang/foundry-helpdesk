// The report script is pure functions over parsed log lines; the CLI is a thin
// shell around them.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildReport, joinByConversation, median, parseLogLines, percentile } from "../latency-report-lib.ts";

const here = dirname(fileURLToPath(import.meta.url));

function turnLine(conversation_id: string, turn_index: number, ttf: number | null, tools: string[] = []): string {
  return JSON.stringify({
    level: 30,
    event: "postcall_turn",
    conversation_id,
    turn_index,
    role: "agent",
    time_in_call_secs: turn_index * 3,
    tool_names: tools,
    ttfb_ms: ttf === null ? null : Math.round(ttf * 0.6),
    ttf_sentence_ms: ttf,
  });
}

function toolLine(conversation_id: string, tool: string, duration_ms: number, status = "ok"): string {
  return JSON.stringify({ level: 30, event: "tool_call", tool, conversation_id, status, duration_ms });
}

// Eleven agent turns, ttf_sentence_ms 100..1100, alternating tool-bearing and plain.
const ELEVEN = Array.from({ length: 11 }, (_, i) => turnLine("conv_0000000001", i, (i + 1) * 100, i % 2 === 0 ? ["get_issue_status"] : []));

describe("median and percentile", () => {
  it("computes median and p95 on a fixture of eleven turns", () => {
    const lines = parseLogLines(ELEVEN.join("\n"));
    const values = lines
      .filter((l) => l.event === "postcall_turn")
      .map((l) => l.ttf_sentence_ms)
      .filter((v): v is number => typeof v === "number");
    expect(values).toHaveLength(11);
    expect(median(values)).toBe(600);
    // Linear interpolation between the 10th and 11th sorted values (1000, 1100).
    expect(percentile(values, 95)).toBe(1050);
    expect(percentile(values, 0)).toBe(100);
    expect(percentile(values, 100)).toBe(1100);
  });

  it("handles even counts and empty inputs", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(percentile([], 95)).toBeNull();
    expect(percentile([7], 95)).toBe(7);
  });
});

describe("parseLogLines", () => {
  it("skips blank and non-JSON lines and unwraps a Railway-style message envelope", () => {
    const text = [
      "",
      "not json at all",
      JSON.stringify({ level: 30, msg: "no event here" }),
      turnLine("conv_0000000001", 0, 300),
      JSON.stringify({ timestamp: "2026-09-09T00:00:00Z", message: toolLine("conv_0000000001", "verify_caller", 80) }),
    ].join("\n");
    const lines = parseLogLines(text);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.event).toBe("postcall_turn");
    expect(lines[1]).toMatchObject({ event: "tool_call", tool: "verify_caller", duration_ms: 80 });
  });
});

describe("joinByConversation", () => {
  it("pairs turn lines with timing lines by conversation id and flags unmatched ones", () => {
    const text = [
      turnLine("conv_0000000001", 0, 300, ["verify_caller"]),
      toolLine("conv_0000000001", "verify_caller", 80),
      turnLine("conv_0000000002", 0, 400),
      toolLine("conv_0000000003", "create_issue", 900),
      toolLine(null as unknown as string, "escalate", 10),
    ].join("\n");
    const joined = joinByConversation(parseLogLines(text));
    expect([...joined.matched.keys()]).toEqual(["conv_0000000001"]);
    expect(joined.matched.get("conv_0000000001")?.turns).toHaveLength(1);
    expect(joined.matched.get("conv_0000000001")?.toolCalls).toHaveLength(1);
    expect(joined.turnsOnly).toEqual(["conv_0000000002"]);
    expect(joined.toolsOnly).toEqual(["conv_0000000003"]);
  });
});

describe("buildReport", () => {
  it("labels the proxy, separates tool-bearing from plain turns, reports per-tool stats, and lists unmatched ids", () => {
    const text = [
      ...ELEVEN,
      toolLine("conv_0000000001", "get_issue_status", 100),
      toolLine("conv_0000000001", "get_issue_status", 300),
      toolLine("conv_0000000001", "create_issue", 700, "failed"),
      turnLine("conv_0000000009", 0, 250),
      toolLine("conv_0000000008", "escalate", 20),
    ].join("\n");
    const report = buildReport(parseLogLines(text));
    expect(report).toContain("time to first sentence, the R20 proxy; true time to first audio adds text-to-speech latency the webhook does not expose");
    // Tool-bearing turns: 100,300,500,700,900,1100 -> median 600, p95 1050.
    expect(report).toMatch(/Tool-bearing turns\s*\|\s*6\s*\|\s*600\s*\|\s*1050/);
    // Plain turns: 200,400,600,800,1000 and 250 -> median 500, p95 950.
    expect(report).toMatch(/Plain turns\s*\|\s*6\s*\|\s*500\s*\|\s*950/);
    expect(report).toMatch(/get_issue_status\s*\|\s*2\s*\|\s*200\s*\|\s*290/);
    expect(report).toMatch(/create_issue\s*\|\s*1\s*\|\s*700\s*\|\s*700/);
    expect(report).toContain("conv_0000000009");
    expect(report).toContain("conv_0000000008");
  });

  it("says so when there is nothing to report", () => {
    const report = buildReport([]);
    expect(report).toContain("no postcall_turn lines");
  });
});

describe("latency-report CLI", () => {
  it("prints the report for an ndjson export", () => {
    const dir = mkdtempSync(join(tmpdir(), "latency-"));
    const file = join(dir, "export.ndjson");
    writeFileSync(file, [...ELEVEN, toolLine("conv_0000000001", "verify_caller", 80)].join("\n"));
    const r = spawnSync(process.execPath, [resolve(here, "../latency-report.ts"), file], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("R20 proxy");
    expect(r.stdout).toContain("verify_caller");
  });

  it("exits non-zero without a file argument", () => {
    const r = spawnSync(process.execPath, [resolve(here, "../latency-report.ts")], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("usage");
  });
});
