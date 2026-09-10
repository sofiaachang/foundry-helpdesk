// Configuration is read once at startup from named environment variables and
// fails fast, naming the missing variable, so a bad Railway deploy dies at boot
// instead of at the first tool call mid-demo.

import { DEFAULT_ONTOLOGY_NAMES, mergeOntologyNames, OntologyNamesError, type OntologyNames } from "./lib/ontology-names.js";

/**
 * "foundry": the REST adapter over the delegated user token (plan U8; "osdk"
 * is accepted as an alias from the pre-U8 deploys). "not-ready": the login
 * routes work and every tool call fails closed; for the pre-U3 deploy and
 * tests only. "fake": in-memory seed rows; local only, refused in production.
 */
export type AdapterKind = "foundry" | "not-ready" | "fake";

export interface Config {
  port: number;
  logLevel: string;
  adapter: AdapterKind;
  /**
   * Public OAuth client (Developer Console client-facing app, PKCE, no client
   * secret; plan KTD3). The service holds a delegated user token obtained via
   * /auth/start, so there is deliberately no clientSecret field.
   */
  foundry: {
    stackUrl: string;
    clientId: string;
    ontologyRid: string;
    /** Must match a redirect URL registered on the app. */
    redirectUrl: string;
    /** Per-deploy random value that guards /auth/start. The OAuth state is random and opaque; nothing derives from this token. */
    loginToken: string;
  };
  /** Object, property, link, and action api names; FOUNDRY_ONTOLOGY_NAMES overrides the ERD defaults. */
  ontologyNames: OntologyNames;
  /** Current secret first, previous second during a rotation. */
  sharedSecrets: string[];
  elevenLabsWebhookSecret: string;
  pinPepper: string;
  lockoutMaxFailures: number;
  lockoutWindowMs: number;
  sessionTtlMs: number;
  slowToolsMs: number;
}

export class ConfigError extends Error {}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`Missing required environment variable ${name}`);
  return value;
}

function requiredHttpUrl(env: Record<string, string | undefined>, name: string): string {
  const value = required(env, name);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be a valid http(s) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(`${name} must be a valid http(s) URL`);
  }
  return value;
}

function requiredMinLength(env: Record<string, string | undefined>, name: string, min: number): string {
  const value = required(env, name);
  if (value.length < min) throw new ConfigError(`${name} must be at least ${min} characters`);
  return value;
}

function optionalInt(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

function ontologyNames(env: Record<string, string | undefined>): OntologyNames {
  const raw = env.FOUNDRY_ONTOLOGY_NAMES?.trim();
  if (!raw) return DEFAULT_ONTOLOGY_NAMES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError("FOUNDRY_ONTOLOGY_NAMES must be valid JSON");
  }
  try {
    return mergeOntologyNames(DEFAULT_ONTOLOGY_NAMES, parsed);
  } catch (error) {
    const detail = error instanceof OntologyNamesError ? error.message : "invalid override";
    throw new ConfigError(`FOUNDRY_ONTOLOGY_NAMES: ${detail}`);
  }
}

function adapterKind(env: Record<string, string | undefined>): AdapterKind {
  const raw = env.FOUNDRY_ADAPTER?.trim() || "foundry";
  if (raw === "foundry" || raw === "osdk") return "foundry";
  if (raw === "not-ready" || raw === "fake") return raw;
  throw new ConfigError(`FOUNDRY_ADAPTER must be "foundry", "not-ready", or "fake", got "${raw}"`);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const adapter = adapterKind(env);

  // The fake adapter exists so the service can be exercised locally before G3
  // clears. It must never be selected on Railway; server.ts refuses it in production.
  const foundry =
    adapter !== "fake"
      ? {
          stackUrl: requiredHttpUrl(env, "FOUNDRY_STACK_URL"),
          clientId: required(env, "FOUNDRY_CLIENT_ID"),
          ontologyRid: required(env, "FOUNDRY_ONTOLOGY_RID"),
          redirectUrl: requiredHttpUrl(env, "FOUNDRY_REDIRECT_URL"),
          loginToken: requiredMinLength(env, "FOUNDRY_LOGIN_TOKEN", 24),
        }
      : {
          stackUrl: env.FOUNDRY_STACK_URL?.trim() ?? "",
          clientId: "",
          ontologyRid: env.FOUNDRY_ONTOLOGY_RID?.trim() ?? "",
          redirectUrl: "",
          loginToken: "",
        };

  const sharedSecrets = required(env, "HELPDESK_SHARED_SECRET")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sharedSecrets.length === 0 || sharedSecrets.length > 2) {
    throw new ConfigError("HELPDESK_SHARED_SECRET must hold one value, or two comma-separated values during rotation");
  }
  for (const s of sharedSecrets) {
    if (s.length < 24) throw new ConfigError("HELPDESK_SHARED_SECRET values must be at least 24 characters");
  }

  return {
    port: optionalInt(env, "PORT", 3000),
    logLevel: env.LOG_LEVEL?.trim() || "info",
    adapter,
    foundry,
    ontologyNames: ontologyNames(env),
    sharedSecrets,
    elevenLabsWebhookSecret: required(env, "ELEVENLABS_WEBHOOK_SECRET"),
    pinPepper: required(env, "PIN_PEPPER"),
    lockoutMaxFailures: optionalInt(env, "LOCKOUT_MAX_FAILURES", 6),
    lockoutWindowMs: optionalInt(env, "LOCKOUT_WINDOW_MS", 900_000),
    sessionTtlMs: optionalInt(env, "SESSION_TTL_MS", 600_000),
    slowToolsMs: optionalInt(env, "SLOW_TOOLS_MS", 0),
  };
}
