// Latency report from an ndjson export of the service log (plan U15, KTD13).
//
//   node service/scripts/latency-report.ts <export.ndjson>
//
// Node 26 runs TypeScript directly, so there is no build step. All logic lives
// in latency-report-lib.ts so it can be unit tested; this file is only I/O.

import { readFileSync } from "node:fs";
import { buildReport, parseLogLines } from "./latency-report-lib.ts";

const file = process.argv[2];
if (!file) {
  process.stderr.write("usage: node service/scripts/latency-report.ts <export.ndjson>\n");
  process.exit(2);
}

let text: string;
try {
  text = readFileSync(file, "utf8");
} catch (error) {
  process.stderr.write(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

process.stdout.write(buildReport(parseLogLines(text)));
