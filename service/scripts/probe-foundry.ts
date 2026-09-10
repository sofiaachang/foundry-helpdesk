// U1 Foundry access probe (plan U1, KTD3). Proves from an external process that
// a delegated user token from the Developer Console public client can read
// ontology metadata and objects, apply an Action, and refresh unattended.
//
//   FOUNDRY_STACK_URL=… FOUNDRY_CLIENT_ID=… FOUNDRY_ONTOLOGY_RID=… \
//     pnpm --dir service exec tsx scripts/probe-foundry.ts [--object-type T --pk K] \
//     [--action A --params '{…}'] [--refresh-test [--grace-wait-seconds 75]]
//
// Runs through tsx (the same runner as `pnpm dev`): this script imports
// src/foundry/auth.ts, whose internal imports use the `.js` suffix that tsc
// emits, and Node's native type stripping does not rewrite those. Pure parts
// live in probe-foundry-lib.ts; this file is I/O only. Output is one line per step.
// Never printed: token values, full response bodies, the OAuth code. Error text
// is redacted and capped by the lib. Findings go into ontology/README.md.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { FoundryDelegatedAuth } from "../src/foundry/auth.ts";
import { FoundryAuthError } from "../src/lib/foundry-auth-types.ts";
import {
  extractAddedPrimaryKeys,
  extractValidation,
  formatStep,
  parseArgs,
  redirectListener,
  summariseError,
  USAGE,
} from "./probe-foundry-lib.ts";

const out = (line: string) => process.stdout.write(`${line}\n`);

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.ok) {
  process.stderr.write(`${parsed.error}\n${USAGE}\n`);
  process.exit(2);
}
const args = parsed.value;

const stackUrl = process.env.FOUNDRY_STACK_URL?.trim();
const clientId = process.env.FOUNDRY_CLIENT_ID?.trim();
const ontologyRid = process.env.FOUNDRY_ONTOLOGY_RID?.trim();
const redirectUrl = process.env.FOUNDRY_REDIRECT_URL?.trim() || "http://localhost:3000/auth/callback";
if (!stackUrl || !clientId || !ontologyRid) {
  process.stderr.write(`FOUNDRY_STACK_URL, FOUNDRY_CLIENT_ID and FOUNDRY_ONTOLOGY_RID are required\n${USAGE}\n`);
  process.exit(2);
}
const base = stackUrl.replace(/\/+$/, "");
const ontologyPath = `/api/v2/ontologies/${encodeURIComponent(ontologyRid)}`;

// The probe owns the fetch, so it can remember the refresh token it sent on
// each rotation (in memory only, never printed) to prove the old one dies
// after the grace period. Nothing else about the exchange is recorded.
const sentRefreshTokens: string[] = [];
const recordingFetch: typeof fetch = async (input, init) => {
  if (typeof init?.body === "string") {
    const form = new URLSearchParams(init.body);
    const rt = form.get("refresh_token");
    if (form.get("grant_type") === "refresh_token" && rt) sentRefreshTokens.push(rt);
  }
  return fetch(input, init);
};

const auth = new FoundryDelegatedAuth({
  stackUrl: base,
  clientId,
  redirectUrl,
  loginToken: randomBytes(18).toString("base64url"),
  fetch: recordingFetch,
});

type StepStatus = "ok" | "failed" | "skipped" | "info";

async function foundry(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const token = await auth.getToken();
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsedBody: unknown = text;
  try {
    parsedBody = JSON.parse(text);
  } catch {
    // keep text
  }
  return { status: response.status, body: parsedBody };
}

function authErrorDetail(error: unknown): Record<string, unknown> {
  if (error instanceof FoundryAuthError) return { category: error.category, http_status: error.httpStatus ?? null };
  return { name: error instanceof Error ? error.name : "Error" };
}

function pick(body: unknown, keys: string[]): Record<string, unknown> {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const result: Record<string, unknown> = {};
  for (const k of keys) if (k in record) result[k] = record[k];
  return result;
}

async function step(name: string, run: () => Promise<{ status: StepStatus; detail?: unknown }>): Promise<void> {
  try {
    const r = await run();
    out(formatStep(name, r.status, r.detail ?? null));
  } catch (error) {
    out(formatStep(name, "failed", authErrorDetail(error)));
  }
}

async function waitForLogin(): Promise<void> {
  const { port, path } = redirectListener(redirectUrl);
  const authorizeUrl = auth.beginLogin();
  await new Promise<void>((resolve, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (url.pathname !== path) {
        res.writeHead(404).end();
        return;
      }
      const finish = (status: number, text: string) => {
        res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end(`${text}\n`);
      };
      if (url.searchParams.get("error")) {
        finish(400, "Foundry login was not completed.");
        server.close();
        reject(new Error("login denied"));
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        finish(400, "Missing code or state.");
        return;
      }
      try {
        await auth.completeLogin(code, state);
        finish(200, "Foundry login complete, you can close this tab.");
        server.close();
        resolve();
      } catch (error) {
        finish(502, "Foundry login failed.");
        server.close();
        reject(error);
      }
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      out(formatStep("callback listener", "info", { port, path }));
      out(`open this URL in a browser and log in:\n${authorizeUrl}`);
    });
  });
}

async function main(): Promise<void> {
  out(formatStep("config", "info", { stack: base, ontology: ontologyRid, redirect: redirectUrl }));

  try {
    await waitForLogin();
    out(formatStep("login", "ok", { auth_status: auth.status().status, expires_at: auth.status().expiresAt }));
  } catch (error) {
    out(formatStep("login", "failed", authErrorDetail(error)));
    process.exit(1);
  }

  await step("ontology metadata", async () => {
    const r = await foundry("GET", ontologyPath);
    if (r.status !== 200) return { status: "failed", detail: summariseError(r.status, r.body) };
    return { status: "ok", detail: { status: r.status, ...pick(r.body, ["apiName", "displayName", "rid"]) } };
  });

  await step("object types (pageSize=5)", async () => {
    const r = await foundry("GET", `${ontologyPath}/objectTypes?pageSize=5`);
    if (r.status !== 200) return { status: "failed", detail: summariseError(r.status, r.body) };
    const data = (r.body as { data?: unknown }).data;
    const names = Array.isArray(data) ? data.map((t) => (t as { apiName?: unknown }).apiName) : [];
    return { status: "ok", detail: { status: r.status, apiNames: names } };
  });

  await step("object read", async () => {
    if (!args.objectType || !args.pk) return { status: "skipped", detail: { reason: "pass --object-type and --pk" } };
    const r = await foundry("GET", `${ontologyPath}/objects/${encodeURIComponent(args.objectType)}/${encodeURIComponent(args.pk)}`);
    if (r.status !== 200) return { status: "failed", detail: summariseError(r.status, r.body) };
    return { status: "ok", detail: { status: r.status, ...pick(r.body, ["__apiName", "__primaryKey"]) } };
  });

  await step("action apply", async () => {
    if (!args.action || !args.params) return { status: "skipped", detail: { reason: "pass --action and --params" } };
    const r = await foundry("POST", `${ontologyPath}/actions/${encodeURIComponent(args.action)}/apply`, {
      parameters: args.params,
      options: { returnEdits: "ALL" },
    });
    const validation = extractValidation(r.body);
    if (r.status !== 200) {
      // 400 with a validation block is the U1 evidence: parameter ids and
      // submission-criteria categories, nothing else from the body.
      return { status: "failed", detail: { ...summariseError(r.status, r.body), validation } };
    }
    return { status: "ok", detail: { status: r.status, validation, added: extractAddedPrimaryKeys(r.body) } };
  });

  await step("refresh rotation", async () => {
    if (!args.refreshTest) return { status: "skipped", detail: { reason: "pass --refresh-test" } };
    const before = auth.status().expiresAt;
    await auth.forceRefresh();
    const afterFirst = auth.status().expiresAt;
    // Second refresh proves the rotated token was accepted.
    await auth.forceRefresh();
    const rotated = sentRefreshTokens.length >= 2 && sentRefreshTokens[0] !== sentRefreshTokens[1];
    return {
      status: rotated ? "ok" : "failed",
      detail: { refreshes: sentRefreshTokens.length, rotated, expires_before: before, expires_after_first: afterFirst, expires_after_second: auth.status().expiresAt },
    };
  });

  await step("old refresh token rejected after grace", async () => {
    if (!args.refreshTest) return { status: "skipped", detail: { reason: "pass --refresh-test" } };
    const old = sentRefreshTokens[0];
    if (!old) return { status: "skipped", detail: { reason: "no refresh happened" } };
    out(formatStep("grace wait", "info", { seconds: args.graceWaitSeconds }));
    await delay(args.graceWaitSeconds * 1000);
    const response = await fetch(`${base}/multipass/api/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: old, client_id: clientId }).toString(),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // body irrelevant
    }
    const error = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : null;
    const rejected = response.status >= 400 && response.status < 500;
    return { status: rejected ? "ok" : "failed", detail: { status: response.status, error: typeof error === "string" ? error : null } };
  });

  await step("current token still valid after rotation", async () => {
    if (!args.refreshTest) return { status: "skipped" };
    const r = await foundry("GET", ontologyPath);
    return r.status === 200 ? { status: "ok", detail: { status: r.status } } : { status: "failed", detail: summariseError(r.status, r.body) };
  });
}

main().catch((error: unknown) => {
  out(formatStep("probe", "failed", authErrorDetail(error)));
  process.exit(1);
});
