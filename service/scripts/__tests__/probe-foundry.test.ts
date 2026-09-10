// The U1 probe is I/O plus pure helpers; the helpers are tested here so the
// redaction and extraction rules hold before the script ever touches Foundry.

import { describe, expect, it } from "vitest";
import {
  extractAddedPrimaryKeys,
  extractValidation,
  formatStep,
  parseArgs,
  redact,
  redirectListener,
  summariseError,
} from "../probe-foundry-lib.ts";

const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

const successEdits = {
  validation: { result: "VALID", submissionCriteria: [], parameters: { title: { result: "VALID", evaluatedConstraints: [], required: true } } },
  edits: {
    type: "edits",
    edits: [
      { type: "addObject", objectType: "VoiceHelpdeskIssue", primaryKey: "5432" },
      { type: "modifyObject", objectType: "VoiceHelpdeskTeam", primaryKey: "t1" },
      { type: "addObject", objectType: "VoiceHelpdeskLog", primaryKey: "log-9" },
    ],
    addedObjectCount: 2,
    modifiedObjectsCount: 1,
    deletedObjectsCount: 0,
    addedLinksCount: 0,
    deletedLinksCount: 0,
  },
};

const validationFailure = {
  errorCode: "INVALID_ARGUMENT",
  errorName: "ActionValidationFailed",
  errorInstanceId: "1f2e3d4c-0000-0000-0000-000000000000",
  parameters: {
    actionType: "create-voice-helpdesk-issue",
    validation: {
      result: "INVALID",
      submissionCriteria: [],
      parameters: {
        title: { result: "INVALID", evaluatedConstraints: [], required: true },
        priority: { result: "VALID", evaluatedConstraints: [{ type: "oneOf" }], required: true },
      },
    },
  },
};

const submissionCriteriaFailure = {
  errorCode: "INVALID_ARGUMENT",
  errorName: "ActionValidationFailed",
  errorInstanceId: "9a8b7c6d-0000-0000-0000-000000000000",
  parameters: {
    actionType: "create-voice-helpdesk-issue",
    validation: {
      result: "INVALID",
      submissionCriteria: [{ result: "INVALID", configuredFailureMessage: "You must be in the voice-helpdesk-writers group." }],
      parameters: { title: { result: "VALID", evaluatedConstraints: [], required: true } },
    },
  },
};

const tokenLeakBody = {
  errorCode: "UNAUTHORIZED",
  errorName: "Default:Unauthorized",
  errorInstanceId: "abc",
  parameters: { message: `Token Bearer ${JWT} was rejected; also raw ${JWT} and secret refresh-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijkl` },
};

describe("parseArgs", () => {
  it("returns defaults with no flags", () => {
    const args = parseArgs([]);
    expect(args).toEqual({ ok: true, value: { objectType: null, pk: null, action: null, params: null, refreshTest: false, graceWaitSeconds: 75 } });
  });

  it("parses object read, action apply, and refresh flags", () => {
    const args = parseArgs(["--object-type", "VoiceHelpdeskIssue", "--pk", "4127", "--action", "create-issue", "--params", '{"title":"x"}', "--refresh-test", "--grace-wait-seconds", "5"]);
    expect(args).toEqual({
      ok: true,
      value: { objectType: "VoiceHelpdeskIssue", pk: "4127", action: "create-issue", params: { title: "x" }, refreshTest: true, graceWaitSeconds: 5 },
    });
  });

  it("rejects an object type without a primary key, an action without params, and bad JSON", () => {
    expect(parseArgs(["--object-type", "X"])).toMatchObject({ ok: false });
    expect(parseArgs(["--action", "a"])).toMatchObject({ ok: false });
    expect(parseArgs(["--action", "a", "--params", "{nope"])).toMatchObject({ ok: false });
    expect(parseArgs(["--action", "a", "--params", "[1]"])).toMatchObject({ ok: false });
    expect(parseArgs(["--bogus"])).toMatchObject({ ok: false });
    expect(parseArgs(["--grace-wait-seconds", "x"])).toMatchObject({ ok: false });
  });
});

describe("redact", () => {
  it("strips bearer tokens, JWTs, and long opaque strings, and caps at 300 chars", () => {
    const out = redact(JSON.stringify(tokenLeakBody));
    expect(out).not.toContain(JWT);
    expect(out).not.toContain("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c");
    expect(out).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijkl");
    expect(out).toContain("[redacted]");
    expect(out.length).toBeLessThanOrEqual(300);
    expect(redact("word ".repeat(200)).length).toBe(300);
    expect(redact("plain message")).toBe("plain message");
  });
});

describe("summariseError", () => {
  it("keeps only the error name, code, instance id, and a redacted message", () => {
    const s = summariseError(401, tokenLeakBody);
    expect(s.status).toBe(401);
    expect(s.errorCode).toBe("UNAUTHORIZED");
    expect(s.errorName).toBe("Default:Unauthorized");
    expect(s.errorInstanceId).toBe("abc");
    expect(s.message).not.toContain(JWT);
    expect(JSON.stringify(s)).not.toContain(JWT);
    expect(Object.keys(s).sort()).toEqual(["errorCode", "errorInstanceId", "errorName", "message", "status"]);
  });

  it("tolerates a non-JSON body", () => {
    const s = summariseError(502, "<html>Bad gateway</html>");
    expect(s).toMatchObject({ status: 502, errorCode: null, errorName: null, errorInstanceId: null });
    expect(s.message).toContain("Bad gateway");
  });
});

describe("extractAddedPrimaryKeys", () => {
  it("lists only addObject edits", () => {
    expect(extractAddedPrimaryKeys(successEdits)).toEqual([
      { objectType: "VoiceHelpdeskIssue", primaryKey: "5432" },
      { objectType: "VoiceHelpdeskLog", primaryKey: "log-9" },
    ]);
  });

  it("returns an empty list when there are no edits", () => {
    expect(extractAddedPrimaryKeys({ validation: { result: "VALID" } })).toEqual([]);
    expect(extractAddedPrimaryKeys("nope")).toEqual([]);
  });
});

describe("extractValidation", () => {
  it("reads a success body", () => {
    expect(extractValidation(successEdits)).toEqual({ result: "VALID", invalidParameters: [], submissionCriteria: [] });
  });

  it("names the invalid parameter on a validation failure", () => {
    expect(extractValidation(validationFailure)).toEqual({ result: "INVALID", invalidParameters: ["title"], submissionCriteria: [] });
  });

  it("surfaces submission-criteria failures with their configured message", () => {
    expect(extractValidation(submissionCriteriaFailure)).toEqual({
      result: "INVALID",
      invalidParameters: [],
      submissionCriteria: [{ result: "INVALID", message: "You must be in the voice-helpdesk-writers group." }],
    });
  });

  it("returns null when no validation block is present", () => {
    expect(extractValidation({ errorName: "PermissionDenied" })).toBeNull();
  });
});

describe("formatStep and redirectListener", () => {
  it("formats one line per step with the redacted detail", () => {
    expect(formatStep("ontology metadata", "ok", { status: 200, apiName: "voice-helpdesk" })).toBe(
      'ontology metadata: ok {"status":200,"apiName":"voice-helpdesk"}',
    );
    expect(formatStep("object read", "failed", { message: `Bearer ${JWT}` })).not.toContain(JWT);
  });

  it("derives the listener port and path from the redirect URL", () => {
    expect(redirectListener("http://localhost:3000/auth/callback")).toEqual({ port: 3000, path: "/auth/callback" });
    expect(redirectListener("http://127.0.0.1/cb")).toEqual({ port: 80, path: "/cb" });
  });
});
