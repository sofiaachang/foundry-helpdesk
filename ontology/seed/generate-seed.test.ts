// Run: node --test ontology/seed/generate-seed.test.ts
// Unit tests for the synthetic seed generator (plan U3 test scenarios).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AE5_DESCRIPTION,
  AE6_DESCRIPTION,
  generateSeed,
  hashPin,
  salientTerms,
  termOverlap,
} from "./generate-seed.ts";

const OPTS = {
  seed: 42,
  pepper: "test-pepper",
  demoPhone: "+15550100000",
  demoPin: "4321",
};

function parseCsv(text: string): string[][] {
  // Minimal RFC 4180 parser sufficient for the generator's output.
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

test("same seed produces identical CSV text on two runs", () => {
  const a = generateSeed(OPTS);
  const b = generateSeed(OPTS);
  for (const name of Object.keys(a.csv) as (keyof typeof a.csv)[]) {
    assert.equal(a.csv[name], b.csv[name], `${name} differs between runs`);
  }
  const c = generateSeed({ ...OPTS, seed: 43 });
  assert.notEqual(a.csv["issues.csv"], c.csv["issues.csv"], "a different seed should change the output");
});

test("row counts and fixed rows match the plan", () => {
  const out = generateSeed(OPTS);
  assert.equal(out.sites.length, 3);
  assert.equal(out.teams.length, 4);
  assert.equal(out.users.length, 12);
  assert.equal(out.issues.length, 40);
  assert.ok(out.teams.some((t) => t.teamId === "triage" && t.name === "Triage"));
  const demo = out.users.find((u) => u.userId === "u-demo");
  assert.ok(demo, "demo caller u-demo exists");
  assert.equal(demo!.phoneE164, OPTS.demoPhone);
  const statuses = new Set(out.issues.map((i) => i.status));
  assert.deepEqual([...statuses].sort(), ["in_progress", "open", "resolved"]);
  const priorities = new Set(out.issues.map((i) => i.priority));
  assert.deepEqual([...priorities].sort(), ["high", "low", "normal"]);
});

test("referential integrity: issues reference users and teams, users reference sites", () => {
  const out = generateSeed(OPTS);
  const userIds = new Set(out.users.map((u) => u.userId));
  const teamIds = new Set(out.teams.map((t) => t.teamId));
  const siteIds = new Set(out.sites.map((s) => s.siteId));
  for (const issue of out.issues) {
    assert.ok(userIds.has(issue.reportedByUserId), `issue ${issue.issueId} reporter ${issue.reportedByUserId} missing`);
    assert.ok(teamIds.has(issue.assignedTeamId), `issue ${issue.issueId} team ${issue.assignedTeamId} missing`);
  }
  for (const user of out.users) {
    assert.ok(siteIds.has(user.siteId), `user ${user.userId} site ${user.siteId} missing`);
  }
});

test("exactly one resolved issue matches AE5 on >= 3 salient terms; none matches AE6 on > 1", () => {
  const out = generateSeed(OPTS);
  const ae5Terms = salientTerms(AE5_DESCRIPTION);
  const ae6Terms = salientTerms(AE6_DESCRIPTION);
  assert.ok(ae5Terms.includes("vpn") && ae5Terms.includes("wifi") && ae5Terms.includes("reconnect"));
  assert.ok(!ae5Terms.includes("the") && !ae5Terms.includes("i"));

  const ae5Matches = out.issues.filter(
    (i) => termOverlap(ae5Terms, salientTerms(`${i.title} ${i.description}`)) >= 3,
  );
  assert.equal(ae5Matches.length, 1, `expected one AE5 match, got ${ae5Matches.map((i) => i.issueId).join(",")}`);
  assert.equal(ae5Matches[0].status, "resolved");
  assert.ok(ae5Matches[0].resolution.length > 10, "AE5 issue carries a resolution");

  for (const i of out.issues) {
    const overlap = termOverlap(ae6Terms, salientTerms(`${i.title} ${i.description}`));
    assert.ok(overlap <= 1, `issue ${i.issueId} "${i.title}" shares ${overlap} AE6 terms`);
  }
});

test("resolution text only on resolved issues; sourceConversationId empty", () => {
  const out = generateSeed(OPTS);
  for (const i of out.issues) {
    if (i.status === "resolved") assert.ok(i.resolution.length > 0, `resolved ${i.issueId} lacks resolution`);
    else assert.equal(i.resolution, "", `non-resolved ${i.issueId} has resolution`);
    assert.equal(i.sourceConversationId, "");
    assert.ok(!Number.isNaN(Date.parse(i.createdAt)), "createdAt is ISO");
    assert.ok(!Number.isNaN(Date.parse(i.updatedAt)), "updatedAt is ISO");
    assert.ok(Date.parse(i.updatedAt) >= Date.parse(i.createdAt), "updatedAt >= createdAt");
  }
});

test("demo PIN hash verifies with the same HMAC and fails with a different pepper", () => {
  const out = generateSeed(OPTS);
  const demo = out.users.find((u) => u.userId === "u-demo")!;
  assert.equal(demo.pinHash, hashPin(OPTS.pepper, "u-demo", OPTS.demoPin));
  assert.notEqual(demo.pinHash, hashPin("other-pepper", "u-demo", OPTS.demoPin));
  assert.notEqual(demo.pinHash, hashPin(OPTS.pepper, "u-demo", "0000"));
  assert.match(demo.pinHash, /^[0-9a-f]{64}$/);
  // Every user has a distinct PIN and the PINs never appear in the CSV.
  const pins = new Set(Object.values(out.pins));
  assert.equal(pins.size, out.users.length);
  for (const pin of pins) {
    assert.match(pin, /^\d{4}$/);
    assert.ok(!out.csv["users.csv"].includes(`,${pin},`), "PIN leaked into users.csv");
  }
});

test("no two users share a phone number and all are E.164", () => {
  const out = generateSeed(OPTS);
  const phones = out.users.map((u) => u.phoneE164);
  assert.equal(new Set(phones).size, phones.length);
  for (const p of phones) assert.match(p, /^\+[1-9]\d{7,14}$/);
});

test("issue ids are unique 4-digit strings between 1000 and 4999", () => {
  const out = generateSeed(OPTS);
  const ids = out.issues.map((i) => i.issueId);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.match(id, /^\d{4}$/);
    const n = Number(id);
    assert.ok(n >= 1000 && n <= 4999, `id ${id} out of range`);
  }
});

test("CSV output has the ERD columns and parses back to the same rows", () => {
  const out = generateSeed(OPTS);
  const users = parseCsv(out.csv["users.csv"]);
  assert.deepEqual(users[0], ["userId", "fullName", "phoneE164", "pinHash", "siteId"]);
  assert.equal(users.length - 1, 12);
  const issues = parseCsv(out.csv["issues.csv"]);
  assert.deepEqual(issues[0], [
    "issueId", "title", "description", "status", "priority", "resolution",
    "reportedByUserId", "assignedTeamId", "sourceConversationId", "createdAt", "updatedAt",
  ]);
  assert.equal(issues.length - 1, 40);
  for (let r = 1; r < issues.length; r++) {
    assert.equal(issues[r].length, 11, `issue row ${r} has ${issues[r].length} fields`);
    assert.equal(issues[r][1], out.issues[r - 1].title);
    assert.equal(issues[r][2], out.issues[r - 1].description);
  }
  assert.deepEqual(parseCsv(out.csv["sites.csv"])[0], ["siteId", "name"]);
  assert.deepEqual(parseCsv(out.csv["teams.csv"])[0], ["teamId", "name"]);
});

test("demo caller owns issues covering AE3 and AE4 and the demo phone comes from options", () => {
  const out = generateSeed({ ...OPTS, demoPhone: "+14155550123" });
  const demo = out.users.find((u) => u.userId === "u-demo")!;
  assert.equal(demo.phoneE164, "+14155550123");
  const mine = out.issues.filter((i) => i.reportedByUserId === "u-demo");
  assert.ok(mine.some((i) => i.status === "open"), "demo caller has an open issue");
  assert.ok(mine.some((i) => i.issueId === "4127"), "demo caller owns the KTD16 example issue 4127");
});
