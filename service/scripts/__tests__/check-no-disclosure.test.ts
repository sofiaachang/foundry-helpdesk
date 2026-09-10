// The guard script is only trustworthy if it fails on a planted violation.
// Each fixture tree mirrors service/src: server.ts, routes/, foundry/, lib/.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, "../../../scripts/check-no-disclosure.sh");
const fixture = (name: string) => resolve(here, "fixtures", name);

function run(root: string): { status: number | null; output: string } {
  const r = spawnSync("bash", [script, root], { encoding: "utf8" });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}

describe("check-no-disclosure.sh", () => {
  it("passes on the clean fixture", () => {
    const r = run(fixture("clean"));
    expect(r.output).toContain("PASS");
    expect(r.status).toBe(0);
  });

  it("fails when a route imports from foundry/ and names the offending file and line", () => {
    const r = run(fixture("planted-import"));
    expect(r.status).not.toBe(0);
    expect(r.output).toContain("routes/tools.ts");
    expect(r.output).toMatch(/routes\/tools\.ts:\d+/);
    expect(r.output).toContain("foundry/adapter.js");
  });

  it("fails when an adapter method other than findUserByPhone lacks session: VerifiedSession first", () => {
    const r = run(fixture("planted-signature"));
    expect(r.status).not.toBe(0);
    expect(r.output).toContain("foundry/adapter.ts");
    expect(r.output).toMatch(/foundry\/adapter\.ts:\d+/);
    expect(r.output).toContain("countOpenIssuesAtSite");
  });

  it("passes on the real service tree", () => {
    const r = run(resolve(here, "../../src"));
    expect(r.output).toContain("PASS");
    expect(r.status).toBe(0);
  });

  it("fails on a root that does not exist", () => {
    const r = run(resolve(here, "fixtures", "does-not-exist"));
    expect(r.status).not.toBe(0);
  });
});
