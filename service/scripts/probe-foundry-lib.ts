// Pure helpers behind scripts/probe-foundry.ts (plan U1). No I/O here so the
// redaction and extraction rules can be unit tested before the probe touches
// Foundry. Imports use explicit .ts extensions because Node 26 runs the
// scripts directly and scripts/ sits outside the tsc rootDir.

import { asRecord } from "../src/lib/types.ts";

export interface ProbeArgs {
  objectType: string | null;
  pk: string | null;
  action: string | null;
  params: Record<string, unknown> | null;
  refreshTest: boolean;
  /** Seconds to wait before proving the pre-rotation refresh token is rejected (Foundry's grace is one minute). */
  graceWaitSeconds: number;
}

export type ParseResult = { ok: true; value: ProbeArgs } | { ok: false; error: string };

export const USAGE = [
  "usage: FOUNDRY_STACK_URL=… FOUNDRY_CLIENT_ID=… FOUNDRY_ONTOLOGY_RID=… pnpm --dir service exec tsx scripts/probe-foundry.ts",
  "         [--object-type <apiName> --pk <primaryKey>]",
  "         [--action <apiName> --params '<json object>']",
  "         [--refresh-test [--grace-wait-seconds <n>]]",
  "optional: FOUNDRY_REDIRECT_URL (default http://localhost:3000/auth/callback)",
].join("\n");

export function parseArgs(argv: string[]): ParseResult {
  const value: ProbeArgs = { objectType: null, pk: null, action: null, params: null, refreshTest: false, graceWaitSeconds: 75 };
  let paramsRaw: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) return null;
      i += 1;
      return v;
    };
    switch (flag) {
      case "--object-type": {
        const v = next();
        if (v === null) return { ok: false, error: "--object-type needs a value" };
        value.objectType = v;
        break;
      }
      case "--pk": {
        const v = next();
        if (v === null) return { ok: false, error: "--pk needs a value" };
        value.pk = v;
        break;
      }
      case "--action": {
        const v = next();
        if (v === null) return { ok: false, error: "--action needs a value" };
        value.action = v;
        break;
      }
      case "--params": {
        const v = next();
        if (v === null) return { ok: false, error: "--params needs a value" };
        paramsRaw = v;
        break;
      }
      case "--refresh-test":
        value.refreshTest = true;
        break;
      case "--grace-wait-seconds": {
        const v = next();
        const n = v === null ? Number.NaN : Number(v);
        if (!Number.isInteger(n) || n < 0) return { ok: false, error: "--grace-wait-seconds needs a non-negative integer" };
        value.graceWaitSeconds = n;
        break;
      }
      default:
        return { ok: false, error: `unknown argument ${flag}` };
    }
  }
  if ((value.objectType === null) !== (value.pk === null)) return { ok: false, error: "--object-type and --pk go together" };
  if ((value.action === null) !== (paramsRaw === null)) return { ok: false, error: "--action and --params go together" };
  if (paramsRaw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(paramsRaw);
    } catch {
      return { ok: false, error: "--params must be valid JSON" };
    }
    const record = asRecord(parsed);
    if (!record) return { ok: false, error: "--params must be a JSON object" };
    value.params = record;
  }
  return { ok: true, value };
}

export const MAX_ERROR_TEXT = 300;

const BEARER = /bearer\s+[A-Za-z0-9._~+/=-]+/gi;
// JWT-looking: header segment starts with eyJ; opaque: any long run of token alphabet.
const JWT = /eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){0,2}/g;
const OPAQUE = /[A-Za-z0-9_-]{40,}/g;

/** Removes anything that looks like a token and caps the text. Safe for stdout and findings. */
export function redact(text: string): string {
  const cleaned = text.replace(BEARER, "Bearer [redacted]").replace(JWT, "[redacted]").replace(OPAQUE, "[redacted]");
  return cleaned.length > MAX_ERROR_TEXT ? cleaned.slice(0, MAX_ERROR_TEXT) : cleaned;
}

export interface ErrorSummary {
  status: number;
  errorCode: string | null;
  errorName: string | null;
  errorInstanceId: string | null;
  /** Redacted, capped; from `parameters` (function-backed actions put their text there) or `message`. */
  message: string;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** The redacted shape of a failed response. Never returns the body itself. */
export function summariseError(status: number, body: unknown): ErrorSummary {
  const record = asRecord(body);
  if (!record) {
    return { status, errorCode: null, errorName: null, errorInstanceId: null, message: redact(typeof body === "string" ? body : "") };
  }
  const params = asRecord(record.parameters) ?? {};
  const detail = Object.entries(params)
    .filter(([key, v]) => typeof v === "string" && v.length > 0 && key !== "actionType")
    .map(([key, v]) => (key === "message" ? String(v) : `${key}: ${String(v)}`))
    .join("; ");
  const headline = stringOrNull(record.message) ?? "";
  const message = [headline, detail].filter((s) => s.length > 0).join(" - ");
  return {
    status,
    errorCode: stringOrNull(record.errorCode),
    errorName: stringOrNull(record.errorName),
    errorInstanceId: stringOrNull(record.errorInstanceId),
    message: redact(message),
  };
}

export interface AddedObject {
  objectType: string;
  primaryKey: string;
}

/** Primary keys of objects an action created, read off the `returnEdits: "ALL"` edit list. */
export function extractAddedPrimaryKeys(body: unknown): AddedObject[] {
  const edits = asRecord(asRecord(body)?.edits)?.edits;
  if (!Array.isArray(edits)) return [];
  const out: AddedObject[] = [];
  for (const edit of edits) {
    const e = asRecord(edit);
    if (e?.type !== "addObject") continue;
    out.push({ objectType: String(e.objectType ?? ""), primaryKey: String(e.primaryKey ?? "") });
  }
  return out;
}

export interface ValidationSummary {
  result: string;
  invalidParameters: string[];
  submissionCriteria: Array<{ result: string; message: string }>;
}

/**
 * Finds the validation block in a success body (`validation`) or an
 * ActionValidationFailed error body (`parameters.validation` /
 * `parameters.validationResult`) and reduces it to categories and parameter ids.
 */
export function extractValidation(body: unknown): ValidationSummary | null {
  const record = asRecord(body);
  if (!record) return null;
  const params = asRecord(record.parameters);
  const validation = asRecord(record.validation) ?? asRecord(params?.validation) ?? asRecord(params?.validationResult);
  if (!validation) return null;

  const invalidParameters: string[] = [];
  for (const [id, v] of Object.entries(asRecord(validation.parameters) ?? {})) {
    if (asRecord(v)?.result !== "VALID") invalidParameters.push(id);
  }
  const submissionCriteria: Array<{ result: string; message: string }> = [];
  for (const c of Array.isArray(validation.submissionCriteria) ? validation.submissionCriteria : []) {
    const r = asRecord(c);
    if (!r) continue;
    submissionCriteria.push({ result: String(r.result ?? ""), message: redact(String(r.configuredFailureMessage ?? "")) });
  }
  return { result: String(validation.result ?? ""), invalidParameters, submissionCriteria };
}

/** One printed line per probe step. The detail is JSON, redacted as a whole. */
export function formatStep(step: string, status: "ok" | "failed" | "skipped" | "info", detail: unknown = null): string {
  const suffix = detail === null ? "" : ` ${redact(JSON.stringify(detail))}`;
  return `${step}: ${status}${suffix}`;
}

/** Port and path the local callback listener must bind, from the registered redirect URL. */
export function redirectListener(redirectUrl: string): { port: number; path: string } {
  const url = new URL(redirectUrl);
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return { port, path: url.pathname };
}
