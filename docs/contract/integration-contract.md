# Integration contract: ElevenLabs agent to integration service

Status: draft for G2 sign-off. Sections marked "after U1/U14" are filled from spike findings.

Plan reference: `docs/plans/2026-09-09-001-feat-voice-helpdesk-foundry-plan.md` (U2). Tiering per KTD5, identity per KTD8, envelope per KTD11, at-most-once per KTD15, identifiers per KTD16.

## Transport

- All tools are `POST` to `https://<service-host>/tools/<tool_name>` with `Content-Type: application/json`.
- Header `X-Helpdesk-Secret: <shared secret>` on every tool request. The value comes from an ElevenLabs workspace secret. A request without it, or with a wrong value, gets `401` before the body is parsed.
- Tool bodies are capped at 16 KB. Tool timeout on the agent side is 10 seconds.
- Health: `GET /health` returns `200 {"ok":true}` without a secret.
- Post-call webhook: `POST /postcall`, signed with the `ElevenLabs-Signature` header (HMAC-SHA256 over the raw body), 2 MB raw-body limit, 5-minute timestamp window.

## Common request fields

Every tool body carries these two fields, filled from ElevenLabs system dynamic variables, never by the model:

| Field | Source | Notes |
|---|---|---|
| `conversation_id` | `system__conversation_id` | Required. Format `^[A-Za-z0-9_-]{8,128}$`. Missing or malformed: the call is refused with `not_verified` and no session is created. |
| `caller_id` | `system__caller_id` | Optional (absent in browser tests). Normalised to E.164 server-side. Never trusted after verification. |

## Common response envelope

```json
{ "status": "ok", "speech": "…", "escalate": false, "data": { } }
```

| Field | Meaning |
|---|---|
| `status` | One of `ok`, `not_verified`, `locked`, `not_found`, `refused_tier`, `failed`, `escalate`. |
| `speech` | The sentence(s) the agent reads aloud. Always present. Under 600 characters. |
| `escalate` | `true` when the agent should offer a callback and, on acceptance, call `escalate`. |
| `data` | Small structured fields listed per tool. Never contains hashes, raw Foundry errors, or other callers' names. |

Fixed speech for verification outcomes (the same wording for known and unknown numbers):

- `not_verified`: "I need to verify you first. Please enter your four-digit PIN on the keypad, then press the pound key."
- retry after one failure: "That PIN didn't match. Please try once more, then press pound."
- `locked`: "I couldn't verify you. I can have a person call you back instead. Would you like that?"

Response bodies stay under 2 KB.

## Tools

| Tool | Tier | Body fields beyond the common two | Ownership check | `data` on `ok` | Speech shape |
|---|---|---|---|---|---|
| `verify_caller` | 0 | `digits` (string, 0 to 8 chars; empty means keypad timeout) | none | `{ "verified": true }` | "Thanks, you're verified." or the fixed retry/locked sentence |
| `get_issue_status` | 1 | `issue_id` (string, spoken form accepted) | issue reported by session user, else `not_found` | `{ "issue_id", "status", "team" }` | status, team, last update; digits read one by one |
| `list_my_open_issues` | 1 | none | session user | `{ "count", "issues": [ {issue_id,title,status} ] }` (max 3) | count as a word, top three, offer for more |
| `get_team_queue_for_issue` | 1 | `issue_id` | issue reported by session user, else `not_found` | `{ "team", "open_count", "issues": [ {issue_id,title,status} ] }` (max 3) | team name, count, top three; never another reporter's name or description |
| `count_site_open_issues` | 1 | none | session user's site | `{ "site", "open_count" }` | one number with the site name, "zero" allowed |
| `find_similar_issues` | 1 | `description` (string, 10 to 1000 chars) | none on input; output is identifier and resolution only | `{ "match": { "issue_id", "resolution" } }` or `{ "match": null }` | resolution read back plus "does that fix it?", or "I couldn't find a similar issue" |
| `create_issue` | 1 | `title` (5 to 120 chars), `description` (10 to 2000 chars), `priority` (`low`, `normal`, `high`) | n/a; reporter, team, and conversation id are set by the service | `{ "issue_id" }` | identifier read digit by digit |
| `escalate` | 0 | `reason` (string, 0 to 300 chars) | none | `{ "recorded": true }` | "A person will call you back on this number. Goodbye." |

Tier 0 tools work before verification. Tier 1 tools require a verified session. Any tool name not listed returns `refused_tier` with `escalate: true`. There are no tier 2 tools.

Rejected create bodies: any field beyond the listed ones (for example `reported_by`, `team`) is a validation error, `status: failed`.

## Sessions and attempts (KTD7, KTD8, KTD17)

- A session is keyed by `conversation_id`. States: unverified, verified (bound to one user id), locked, escalated. Sessions expire 600 seconds after creation (the agent's maximum conversation duration).
- `verify_caller` increments the session attempt count on any failure, including empty digits. Two failures lock the session.
- A second counter keyed by normalised `caller_id` locks that number after 6 failures in 15 minutes. Locked wording is identical to the second-failure wording. Unknown numbers are counted too.
- After verification the service ignores `caller_id`; the session user is the only identity used.
- Verification never survives a call. A callback is a new conversation.

## At-most-once creation (KTD15)

- Before applying the Action the service records `pending` for the conversation with the request fields.
- A second `create_issue` with the same fields while pending awaits the same result. A second call after completion returns the recorded identifier.
- A second call with different fields in the same conversation returns `failed` with `escalate: true`.
- The identifier is a four-digit number drawn by the service (5000 to 9999) and passed to the Action; a duplicate-key validation failure is redrawn once.

## Escalation packet (KTD12)

Logged by the service as one structured line with `event: "escalation"`. Fields: `conversation_id`, `verification_state`, `caller_name` (only when verified), `last_tool`, `summary` (last confirmed issue summary or the caller's reason), `timestamp`. Never digits, never `caller_id`. The agent then promises a callback and ends the call. There is no live transfer.

## Error envelope

Any unexpected error becomes `{ "status": "failed", "speech": "I couldn't complete that. I can have a person call you back.", "escalate": true }`. No Foundry error text, response body, or stack reaches the agent.

## After U1 (Foundry spike)

- Observed validation and permission error shapes and their mapping to `failed` categories.
- Confirmed identifier parameter shape on the Action.

## After U14 (keypad spike)

- Keypad timeout value and whether the agent yields a turn on silence (drives the empty-digits path).
- Whether stored tool-call parameters show the digits (drives the retention window at G4b).
- Per-turn metric field names in the post-call payload.
