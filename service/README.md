# service

Integration service between the ElevenLabs voice agent and Palantir Foundry. It holds the only Foundry credential; the agent reaches Foundry through the eight tool routes and nothing else. The wider design is in `../docs/plans/2026-09-09-001-feat-voice-helpdesk-foundry-plan.md`.

## Commands

```sh
pnpm install
pnpm dev                      # tsx watch src/server.ts
pnpm test                     # vitest
pnpm check                    # lint, typecheck, test, and the disclosure guard
FOUNDRY_ADAPTER=fake SEED_DIR=../ontology/seed pnpm dev
```

Environment variables are listed in `.env.example`.

## Foundry adapter modes (`FOUNDRY_ADAPTER`)

| Value | What runs | When |
| --- | --- | --- |
| `foundry` (default; `osdk` accepted as an alias) | `RestFoundryAdapter` in `src/foundry/rest.ts` | Production and any run against the zap stack |
| `not-ready` | `NotReadyFoundryAdapter` in `src/foundry/osdk.ts`: `/health` and `/auth/*` work, every tool call fails closed with the contract's `failed` envelope | The pre-U3 deploy (login can be rehearsed before the ontology exists) and route tests. Refused when `NODE_ENV=production` unless `FOUNDRY_ALLOW_NOT_READY=1`, so it cannot boot silently as the real deploy |
| `fake` | `FakeFoundryAdapter` in `src/foundry/fake.ts` over the seed CSVs | Local runs only; refused when `NODE_ENV=production` |

`foundry` and `not-ready` both need `FOUNDRY_STACK_URL`, `FOUNDRY_CLIENT_ID`, `FOUNDRY_ONTOLOGY_RID`, `FOUNDRY_REDIRECT_URL`, and `FOUNDRY_LOGIN_TOKEN`; the human logs in once through `GET /auth/start?t=<login token>` and the service refreshes the delegated user token unattended (plan KTD3). The login token gates `/auth/start` only; the OAuth `state` is random and carries no token material.

`GET /health` answers `{"ok":true,"adapter":"<mode>","auth":"<logged_out|ok|expired|n/a>"}`: `auth` is the delegated login status for `foundry` and `not-ready`, and `n/a` for `fake`. It never carries a token or an expiry (`/auth/status` has the expiry).

### Pre-U3 deploy

Deploy with `FOUNDRY_ADAPTER=not-ready` and `FOUNDRY_ALLOW_NOT_READY=1`, complete the login through `/auth/start?t=<login token>`, and confirm `/health` shows `"auth":"ok"`. Every tool call fails closed until the adapter is switched to `foundry`; drop `FOUNDRY_ALLOW_NOT_READY` at that point.

### The REST adapter

`src/foundry/rest.ts` talks to the Foundry Ontology REST API v2 directly with the delegated user token rather than a generated OSDK package: the SDK install token only appears in the Developer Console, and the REST surface is equivalent for the seven calls the service makes. The generated SDK can replace the class later without changing the `FoundryAdapter` interface in `src/foundry/adapter.ts`.

Calls per tool:

- `findUserByPhone`: search `HelpdeskUser` where `phoneE164` eq the number (page size 1).
- `getIssue`: get `HelpdeskIssue` by primary key (404 becomes `null`), then the `assignedTeam` link for the team name, falling back to `Team` by key.
- `listOpenIssuesForUser`: search open issues for the reporter, newest `updatedAt` first, page size 3, plus an aggregate `count` with the same filter (falls back to counting a page-size-100 search if the aggregate is refused).
- `getTeamQueueForIssue`: issue, then its team, then the team's open issues (page size 4 with the input issue removed in the service, so no `not` filter), plus the count minus the input when it is open.
- `countOpenIssuesAtSite`: users at the session's site, then a count of open issues whose reporter is in that list (`in` filter), plus `Site` by key for the name.
- `findResolvedIssuesMatching`: resolved issues whose title or description `containsAnyTerm` the caller's terms, page size 20; ranking happens in `src/lib/similarity.ts`.
- `createIssue`: apply `createHelpdeskIssue` with `returnEdits: "ALL"` and read the new key from the `addObject` edit; failures map to `validation` (with the parameter), `duplicate_key` (`ObjectAlreadyExists` or an invalid `issueId`), `permission` (403 or a failed submission criterion), or `unknown`.

Every request carries the bearer token, `Accept: application/json`, and an 8-second timeout; a 401 forces a token refresh and is retried once with the new token (a refresh that fails is `unauthorized`, with no retry). The token exchange itself is bounded by a 10-second timeout so a stalled Multipass call cannot hold every tool. Response bodies never appear in errors, return values, or logs; the adapter logs only an event name, the HTTP status, and a category.

### U1 probe (`scripts/probe-foundry.ts`)

`pnpm exec tsx scripts/probe-foundry.ts --refresh-test` runs, after the login and the read steps: `refresh rotation` (two forced refreshes, expecting a rotated refresh token), `current token still valid after rotation` (a read with the rotated grant), `old refresh token rejected after grace` (replays the first refresh token after `--grace-wait-seconds`, expecting 4xx), and finally `grant invalidated after reuse` (a read with the current token, expecting 401, since a reuse after the grace minute invalidates every access token from the grant; a 200 there is recorded as a finding).

### Ontology names override (`FOUNDRY_ONTOLOGY_NAMES`)

The object type, property, link, and action api names default to the ERD in the plan (`src/lib/ontology-names.ts`). After U3 the real names go into the optional `FOUNDRY_ONTOLOGY_NAMES` JSON env var, which is deep-merged over the defaults, so one renamed property needs one key:

```sh
FOUNDRY_ONTOLOGY_NAMES='{"issue":{"objectType":"helpdesk-issue","properties":{"title":"issueTitle"}},"action":{"createIssue":"create-helpdesk-issue"}}'
```

Keys: `user`, `issue`, `site`, `team` (each with `objectType`, `properties`, `links`), `action` (`createIssue`, `parameters`), `statusValues` (`open`, `in_progress`, `resolved`), and `triageTeamId`. Unknown keys, non-object JSON, and non-string values fail at boot naming the path.

## Guard

`../scripts/check-no-disclosure.sh` (run by `pnpm check`) proves that `src/foundry/*` is imported only from `src/server.ts` and from `src/foundry/` itself, and that every adapter method except `findUserByPhone` takes `session: VerifiedSession` first, which only the tier gate in `src/lib/tiers.ts` can mint.
