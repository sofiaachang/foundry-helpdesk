#!/usr/bin/env node
// Synthetic seed generator for the voice help desk ontology (plan U3).
// Dependency-free; runs on Node 26 native TypeScript:
//   PIN_PEPPER=... node ontology/seed/generate-seed.ts --out ontology/seed [--seed 42] [--print-demo-pin]
// Writes sites.csv, teams.csv, users.csv, issues.csv. Deterministic for a given seed and env.
import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------- Types (columns per the plan ERD) ----------

export interface Site { siteId: string; name: string }
export interface Team { teamId: string; name: string }
export interface User { userId: string; fullName: string; phoneE164: string; pinHash: string; siteId: string }
export interface Issue {
  issueId: string;
  title: string;
  description: string;
  status: "open" | "in_progress" | "resolved";
  priority: "low" | "normal" | "high";
  resolution: string;
  reportedByUserId: string;
  assignedTeamId: string;
  sourceConversationId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SeedOptions {
  seed: number;
  pepper: string;
  demoPhone: string;
  demoPin: string;
}

export interface SeedOutput {
  sites: Site[];
  teams: Team[];
  users: User[];
  issues: Issue[];
  /** userId -> plaintext PIN. Never written to disk; only the demo PIN may be printed to stderr. */
  pins: Record<string, string>;
  csv: { "sites.csv": string; "teams.csv": string; "users.csv": string; "issues.csv": string };
}

// ---------- Demo scripts and term extraction (shared shape with KTD9) ----------

export const AE5_DESCRIPTION =
  "the VPN client disconnects every few minutes on the office wifi and I have to reconnect";
export const AE6_DESCRIPTION =
  "the label printer on the loading dock prints blank pages after the firmware update";

export const STOP_WORDS = new Set([
  "the", "on", "and", "i", "to", "a", "after", "every", "few", "my", "have", "it", "is", "of", "in",
]);

/** Lower-cased alphanumeric tokens minus stop words, de-duplicated, in first-seen order. */
export function salientTerms(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || STOP_WORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/** Number of terms of `query` that appear in `candidate`. */
export function termOverlap(query: string[], candidate: string[]): number {
  const set = new Set(candidate);
  let n = 0;
  for (const t of query) if (set.has(t)) n++;
  return n;
}

// ---------- PIN hashing (must match the service's verify function, KTD7) ----------

export function hashPin(pepper: string, userId: string, pin: string): string {
  return createHmac("sha256", pepper).update(`${userId}:${pin}`).digest("hex");
}

// ---------- Deterministic PRNG (mulberry32) ----------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed: number) {
  const next = mulberry32(seed);
  return {
    next,
    int(min: number, max: number): number {
      // inclusive bounds
      return min + Math.floor(next() * (max - min + 1));
    },
    pick<T>(items: readonly T[]): T {
      return items[Math.floor(next() * items.length)];
    },
  };
}

/** Build a list of `n` values in the given proportions (remainder goes to the first entry). */
function multiset<T>(n: number, weights: [T, number][]): T[] {
  const out: T[] = [];
  for (const [value, share] of weights) for (let i = 0; i < Math.floor(n * share); i++) out.push(value);
  while (out.length < n) out.push(weights[0][0]);
  return out;
}

/** Fisher-Yates shuffle driven by the seeded PRNG. */
function shuffle<T>(items: T[], next: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

// ---------- Fixed catalog ----------

const SITES: Site[] = [
  { siteId: "site-hq", name: "Harbor Point HQ" },
  { siteId: "site-lab", name: "Riverside Lab" },
  { siteId: "site-wh", name: "Northgate Warehouse" },
];

const TEAMS: Team[] = [
  { teamId: "triage", name: "Triage" },
  { teamId: "network", name: "Network Operations" },
  { teamId: "endpoint", name: "Endpoint Support" },
  { teamId: "platform", name: "Platform Engineering" },
];

const USER_SPECS: { userId: string; fullName: string; siteId: string }[] = [
  { userId: "u-demo", fullName: "Dana Whitfield", siteId: "site-hq" },
  { userId: "u-1002", fullName: "Marcus Oyelaran", siteId: "site-hq" },
  { userId: "u-1003", fullName: "Priya Raghunathan", siteId: "site-hq" },
  { userId: "u-1004", fullName: "Tomasz Wierzbicki", siteId: "site-hq" },
  { userId: "u-1005", fullName: "Elena Castellanos", siteId: "site-lab" },
  { userId: "u-1006", fullName: "Jonah Feldstein", siteId: "site-lab" },
  { userId: "u-1007", fullName: "Amara Nwosu", siteId: "site-lab" },
  { userId: "u-1008", fullName: "Henrik Solberg", siteId: "site-lab" },
  { userId: "u-1009", fullName: "Lucia Ferreira", siteId: "site-wh" },
  { userId: "u-1010", fullName: "Kenji Matsuda", siteId: "site-wh" },
  { userId: "u-1011", fullName: "Beatrice Okafor", siteId: "site-wh" },
  { userId: "u-1012", fullName: "Samuel Lindqvist", siteId: "site-hq" },
];

interface IssueSpec {
  title: string;
  description: string;
  resolution: string;
  pin?: Partial<Pick<Issue, "issueId" | "status" | "priority" | "reportedByUserId" | "assignedTeamId">>;
}

// Word-choice rules for this catalog (enforced by the tests):
// - AE6 terms (label, printer, loading, dock, prints, blank, pages, firmware, update) appear at most
//   once per issue across title + description.
// - AE5 terms (vpn, client, disconnects, minutes, office, wifi, reconnect) appear at most twice per
//   issue except in the single pinned AE5 issue.
const ISSUE_SPECS: IssueSpec[] = [
  {
    title: "VPN client disconnects every few minutes on office wifi",
    description:
      "Since Monday the VPN client drops every few minutes whenever I am on the office wifi and I have to reconnect each time. A wired connection stays up all day.",
    resolution:
      "Disabled the wifi adapter's power-saving mode and switched the VPN client profile to keep-alive. Reconnect loops stopped after the change.",
    pin: { issueId: "2210", status: "resolved", assignedTeamId: "network", reportedByUserId: "u-1003", priority: "normal" },
  },
  {
    title: "Build server SSO login loops back to the sign-in page",
    description:
      "Signing in to the build server with company SSO redirects back to the sign-in page without an error. Incognito mode behaves the same way.",
    resolution: "Clock skew on the build server exceeded the SAML tolerance; NTP was re-enabled and the assertion validates again.",
    pin: { issueId: "4127", status: "open", reportedByUserId: "u-demo", assignedTeamId: "platform", priority: "high" },
  },
  {
    title: "Laptop fan runs at full speed while idle",
    description: "My laptop fan stays at maximum speed even with nothing open. CPU usage in Activity Monitor sits under five percent.",
    resolution: "Reset the SMC and replaced a stuck thermal sensor cable during the hardware swap.",
    pin: { reportedByUserId: "u-demo", assignedTeamId: "endpoint" },
  },
  {
    title: "Jenkins pipeline stuck in queued state for over an hour",
    description: "The nightly integration pipeline sits in the queue and never starts. Other jobs on the same controller run normally.",
    resolution: "The pipeline required a node label that no online agent provided; the agent was brought back and the label matched.",
    pin: { reportedByUserId: "u-demo", assignedTeamId: "platform", status: "in_progress" },
  },
  {
    title: "External monitor flickers at 144 Hz refresh rate",
    description: "The external monitor flickers every couple of seconds when set to 144 Hz. Dropping to 60 Hz removes the flicker but is noticeably worse.",
    resolution: "Replaced the DisplayPort cable with a certified DP 1.4 cable; flicker gone at 144 Hz.",
  },
  {
    title: "Kubernetes pod in CrashLoopBackOff on staging",
    description: "The orders service pod restarts every thirty seconds on the staging cluster with exit code 137. Production is unaffected.",
    resolution: "Memory limit was below the JVM heap setting; limit raised to 1.5 GiB and the pod is stable.",
  },
  {
    title: "Staging database connection pool exhausted",
    description: "Requests against staging fail with 'too many connections'. The pool appears to leak connections after long-running reports.",
    resolution: "Report worker was not returning connections on exception; wrapped the query in a try/finally and restarted the pool.",
  },
  {
    title: "Email attachments over 25 MB are rejected",
    description: "Sending a design file larger than 25 MB bounces with a size error, but the policy was supposed to allow 50 MB internally.",
    resolution: "Mail gateway rule still had the old limit; raised to 50 MB for internal recipients.",
  },
  {
    title: "Git push rejected by pre-receive hook",
    description: "Pushing to the main repository fails with 'pre-receive hook declined' even though the commit passes the local lint check.",
    resolution: "Hook was enforcing signed commits; the reporter's GPG key was added to the allowed signers list.",
  },
  {
    title: "Conference room A camera not detected by Zoom",
    description: "Zoom lists no camera in conference room A. The camera light comes on but the device is missing from the video source list.",
    resolution: "USB hub in the room had failed; replaced the hub and the camera enumerates again.",
  },
  {
    title: "Badge reader at north entrance intermittently fails",
    description: "The badge reader at the north entrance rejects valid badges about one time in five. Second tap usually works.",
    resolution: "Reader had a loose RS-485 connector; reseated and secured.",
  },
  {
    title: "Slack notifications arrive ten minutes late",
    description: "Desktop Slack notifications arrive around ten minutes after the message is posted. Mobile is instant.",
    resolution: "Desktop app was in a low-power background state; disabled App Nap for Slack.",
  },
  {
    title: "Docker Desktop fails to start after macOS upgrade",
    description: "Docker Desktop hangs on 'starting' after the macOS upgrade. Resetting to factory defaults does not help.",
    resolution: "Removed the stale virtualization framework entitlement and reinstalled Docker Desktop 4.x.",
  },
  {
    title: "Request additional 16 GB RAM for data science laptop",
    description: "Training runs on my laptop swap heavily with 16 GB. Requesting an upgrade to 32 GB or a loaner workstation.",
    resolution: "Approved; laptop swapped for a 32 GB model.",
  },
  {
    title: "Terraform plan fails with provider checksum mismatch",
    description: "Running terraform plan in CI fails with a checksum mismatch for the cloud provider. Local plan on the same commit passes.",
    resolution: "CI cache held a partially downloaded provider; cleared the plugin cache and pinned the provider version in the lock file.",
  },
  {
    title: "Internal npm registry returns 502 for scoped packages",
    description: "Installing packages under our internal scope fails with 502 from the registry proxy. Public packages install fine.",
    resolution: "Upstream registry proxy pool was misconfigured after a restart; pool re-registered.",
  },
  {
    title: "Password reset link expires immediately",
    description: "The password reset email arrives, but the link reports it has expired even when opened within a minute.",
    resolution: "Token expiry was compared in local time on the auth server; fixed to UTC.",
  },
  {
    title: "Voicemail transcription missing from phone system",
    description: "Voicemails still arrive as audio files but the text transcription stopped appearing last week.",
    resolution: "Transcription API key rotated without updating the PBX; new key installed.",
  },
  {
    title: "Headset microphone not picked up in Teams",
    description: "Teams shows the headset as an output device but the microphone never appears as an input. Other apps see it.",
    resolution: "Teams privacy setting for the microphone was off after the OS upgrade; re-enabled.",
  },
  {
    title: "East wing wifi drops during morning standups",
    description: "Wifi in the east wing drops for everyone at around 9:30 each morning and comes back within a minute.",
    resolution: "Access point channel overlapped with the building's warehouse scanners; moved to a clean channel.",
    pin: { assignedTeamId: "network", status: "open" },
  },
  {
    title: "Grafana dashboard shows no data for payments service",
    description: "The payments service dashboard shows 'No data' for all panels since yesterday, though the service is serving traffic.",
    resolution: "Metrics relabeling dropped the service label after a config change; rule corrected.",
  },
  {
    title: "Access request: read access to analytics warehouse",
    description: "Need read-only access to the analytics warehouse schema to validate the quarterly numbers.",
    resolution: "Added to the analytics-readers group.",
  },
  {
    title: "Ubuntu workstation kernel panic on resume from sleep",
    description: "The Ubuntu workstation panics about half the time it resumes from sleep. Logs point at the graphics driver.",
    resolution: "Pinned the NVIDIA driver to the previous LTS release; no panics in a week.",
  },
  {
    title: "Time tracking tool logs hours in the wrong time zone",
    description: "Hours logged in the time tracking tool show up shifted by eight hours in the weekly report.",
    resolution: "User profile time zone was set to UTC; changed to the local zone.",
  },
  {
    title: "CI runners out of disk space",
    description: "Several CI runners fail jobs with 'no space left on device'. Docker image layers appear to fill the disk.",
    resolution: "Added a nightly image prune and grew the runner volumes to 200 GB.",
  },
  {
    title: "Prometheus alert flapping for API latency",
    description: "The API latency alert fires and resolves several times an hour without a real change in traffic.",
    resolution: "Alert threshold used p50 instead of p95 and a 1m window; changed to p95 over 10m.",
  },
  {
    title: "New starter laptop not enrolled in MDM",
    description: "A new starter's laptop shows as unmanaged in the MDM console so company apps will not install.",
    resolution: "Device serial was missing from the enrollment program; added and re-enrolled.",
  },
  {
    title: "Certificate for internal wiki expired",
    description: "Browsers show a certificate expired warning for the internal wiki since this morning.",
    resolution: "Renewed the certificate and enabled auto-renewal through the internal CA.",
  },
  {
    title: "Shared drive mount fails on Linux workstations",
    description: "The shared drive fails to mount on Linux workstations with 'permission denied', while macOS machines mount it fine.",
    resolution: "SMB share required signing; added the mount option on the Linux template.",
  },
  {
    title: "VS Code remote session freezes on large repositories",
    description: "Remote SSH sessions in VS Code freeze when opening the monorepo. Smaller repositories work.",
    resolution: "File watcher limit on the remote host was too low; raised inotify max_user_watches.",
  },
  {
    title: "Test environment API keys rotated without notice",
    description: "Integration tests started failing with 401 because the test environment API keys were rotated and nobody was told.",
    resolution: "New keys distributed through the secrets manager and a rotation announcement added to the runbook.",
  },
  {
    title: "Keyboard shortcuts not working in the ticketing web app",
    description: "Keyboard shortcuts in the ticketing web app stopped working after the latest browser release.",
    resolution: "A browser extension captured the key events; disabled the extension for the app's domain.",
  },
  {
    title: "Second floor scanner produces unreadable PDFs",
    description: "Documents scanned on the second floor scanner arrive as PDFs that no viewer can open.",
    resolution: "Scanner compression profile was corrupt; restored factory scan profile.",
  },
  {
    title: "Redis cache evictions logging users out",
    description: "Users are logged out at random during the day. Redis shows heavy evictions on the session keyspace.",
    resolution: "Session store instance was undersized; moved sessions to a dedicated instance with no eviction policy.",
  },
  {
    title: "Database migration fails on staging with lock timeout",
    description: "The latest schema migration times out waiting for a lock on the orders table in staging.",
    resolution: "A long-running analytics query held the lock; migration re-run in a maintenance window.",
  },
  {
    title: "Office 365 calendar invites arriving twice",
    description: "Every calendar invite arrives twice in Outlook, once from the organiser and once from a forwarding rule.",
    resolution: "Removed a duplicate forwarding rule on the mailbox.",
  },
  {
    title: "Vault token renewal fails from CI",
    description: "CI jobs fail to renew their Vault token halfway through long builds and lose access to secrets.",
    resolution: "Token TTL was shorter than the longest build; raised the role's max TTL to two hours.",
  },
  {
    title: "Mobile app crashes on launch on Android 15 test device",
    description: "The mobile app crashes immediately on launch on the Android 15 test device. Android 14 devices are fine.",
    resolution: "Edge-to-edge enforcement broke a legacy view; patched the layout for API 35.",
  },
  {
    title: "Sentry error spike after release 2.14.0",
    description: "Sentry shows a tenfold error spike since release 2.14.0, mostly null reference errors in the checkout flow.",
    resolution: "Rolled back 2.14.0 and shipped 2.14.1 with a null guard.",
  },
  {
    title: "Payroll export job fails with encoding error",
    description: "The monthly payroll export fails with a UTF-8 encoding error on employee names containing accents.",
    resolution: "Export writer was forcing Latin-1; switched to UTF-8 with BOM for the payroll vendor.",
  },
];

// ---------- Generation ----------

const BASE_DATE_MS = Date.parse("2026-09-01T00:00:00Z");
const DAY_MS = 86_400_000;

export function generateSeed(opts: SeedOptions): SeedOutput {
  if (!/^\d{4}$/.test(opts.demoPin)) throw new Error("demoPin must be exactly four digits");
  if (!/^\+[1-9]\d{7,14}$/.test(opts.demoPhone)) throw new Error("demoPhone must be E.164, e.g. +15550100000");
  const rng = makeRng(opts.seed);

  // Users: unique phones, distinct PINs, peppered hashes.
  const phones = new Set<string>([opts.demoPhone]);
  const pinsUsed = new Set<string>([opts.demoPin]);
  const pins: Record<string, string> = {};
  const users: User[] = USER_SPECS.map((spec) => {
    let phone: string;
    let pin: string;
    if (spec.userId === "u-demo") {
      phone = opts.demoPhone;
      pin = opts.demoPin;
    } else {
      do phone = `+1555010${String(rng.int(0, 9999)).padStart(4, "0")}`; while (phones.has(phone));
      phones.add(phone);
      do pin = String(rng.int(0, 9999)).padStart(4, "0"); while (pinsUsed.has(pin));
      pinsUsed.add(pin);
    }
    pins[spec.userId] = pin;
    return { userId: spec.userId, fullName: spec.fullName, phoneE164: phone, pinHash: hashPin(opts.pepper, spec.userId, pin), siteId: spec.siteId };
  });

  // Issue ids: unique 4-digit strings in [1000, 4999], pinned ids reserved first.
  const idsUsed = new Set<string>(ISSUE_SPECS.map((s) => s.pin?.issueId).filter((x): x is string => !!x));
  const userIds = users.map((u) => u.userId);
  const teamIds = TEAMS.map((t) => t.teamId);
  // Guaranteed mix for the unpinned issues: a fixed multiset, shuffled deterministically.
  const unpinnedStatus = ISSUE_SPECS.filter((s) => !s.pin?.status).length;
  const unpinnedPriority = ISSUE_SPECS.filter((s) => !s.pin?.priority).length;
  const statusPool = shuffle(multiset<Issue["status"]>(unpinnedStatus, [["open", 0.4], ["in_progress", 0.25], ["resolved", 0.35]]), rng.next);
  const priorityPool = shuffle(multiset<Issue["priority"]>(unpinnedPriority, [["low", 0.25], ["normal", 0.5], ["high", 0.25]]), rng.next);

  const issues: Issue[] = ISSUE_SPECS.map((spec) => {
    let issueId = spec.pin?.issueId;
    if (!issueId) {
      do issueId = String(rng.int(1000, 4999)); while (idsUsed.has(issueId));
      idsUsed.add(issueId);
    }
    const status = spec.pin?.status ?? statusPool.pop()!;
    const priority = spec.pin?.priority ?? priorityPool.pop()!;
    const reportedByUserId = spec.pin?.reportedByUserId ?? rng.pick(userIds);
    const assignedTeamId = spec.pin?.assignedTeamId ?? rng.pick(teamIds);
    const createdMs = BASE_DATE_MS - rng.int(1, 90) * DAY_MS - rng.int(0, DAY_MS - 1);
    const updatedMs = createdMs + rng.int(0, BASE_DATE_MS - createdMs);
    return {
      issueId,
      title: spec.title,
      description: spec.description,
      status,
      priority,
      resolution: status === "resolved" ? spec.resolution : "",
      reportedByUserId,
      assignedTeamId,
      sourceConversationId: "",
      createdAt: new Date(createdMs).toISOString(),
      updatedAt: new Date(updatedMs).toISOString(),
    };
  });

  const csv = {
    "sites.csv": toCsv(["siteId", "name"], SITES.map((s) => [s.siteId, s.name])),
    "teams.csv": toCsv(["teamId", "name"], TEAMS.map((t) => [t.teamId, t.name])),
    "users.csv": toCsv(
      ["userId", "fullName", "phoneE164", "pinHash", "siteId"],
      users.map((u) => [u.userId, u.fullName, u.phoneE164, u.pinHash, u.siteId]),
    ),
    "issues.csv": toCsv(
      ["issueId", "title", "description", "status", "priority", "resolution", "reportedByUserId", "assignedTeamId", "sourceConversationId", "createdAt", "updatedAt"],
      issues.map((i) => [i.issueId, i.title, i.description, i.status, i.priority, i.resolution, i.reportedByUserId, i.assignedTeamId, i.sourceConversationId, i.createdAt, i.updatedAt]),
    ),
  };

  return { sites: SITES, teams: TEAMS, users, issues, pins, csv };
}

// ---------- CSV ----------

export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(header: string[], rows: string[][]): string {
  const lines = [header, ...rows].map((r) => r.map(csvField).join(","));
  return lines.join("\n") + "\n";
}

// ---------- CLI ----------

function parseArgs(argv: string[]) {
  let out = "ontology/seed";
  let seed = 42;
  let printDemoPin = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out = argv[++i];
    else if (a.startsWith("--out=")) out = a.slice(6);
    else if (a === "--seed") seed = Number(argv[++i]);
    else if (a.startsWith("--seed=")) seed = Number(a.slice(7));
    else if (a === "--print-demo-pin") printDemoPin = true;
    else if (a === "--help" || a === "-h") {
      console.log("usage: PIN_PEPPER=... node ontology/seed/generate-seed.ts --out DIR [--seed N] [--print-demo-pin]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (!out) throw new Error("--out requires a directory");
  if (!Number.isInteger(seed)) throw new Error("--seed must be an integer");
  return { out, seed, printDemoPin };
}

function main() {
  const { out, seed, printDemoPin } = parseArgs(process.argv.slice(2));
  const pepper = process.env.PIN_PEPPER;
  if (!pepper) {
    console.error("PIN_PEPPER is not set. Export the service's pepper (or PIN_PEPPER=example-pepper-do-not-use for the committed CSVs) and re-run.");
    process.exit(2);
  }
  const demoPhone = process.env.DEMO_CALLER_PHONE || "+15550100000";
  const demoPin = process.env.DEMO_CALLER_PIN || "4321";
  const result = generateSeed({ seed, pepper, demoPhone, demoPin });
  mkdirSync(out, { recursive: true });
  for (const [name, text] of Object.entries(result.csv)) writeFileSync(join(out, name), text, "utf8");
  console.error(`wrote ${Object.keys(result.csv).join(", ")} to ${resolve(out)} (seed ${seed}, demo phone ${demoPhone})`);
  if (printDemoPin) console.error(`demo caller PIN: ${demoPin}`);
}

const isMain = (import.meta as { main?: boolean }).main ?? (process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false);
if (isMain) main();
