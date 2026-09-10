# Ontology: voice help desk (plan U3, U4)

Four object types (`User`, `Issue`, `Site`, `Team`), three links, two value types, one Action (`create-helpdesk-issue`), all living in a dedicated `voice-helpdesk` project in the **Raava** space on the **zap** stack (`zap.usw-18.palantirfoundry.com`).

**Every `pltr` command in this folder must use `--profile zap` after the subcommand (for example `pltr admin user current --profile zap`).** The CLI's default profile points at an unrelated tenant and returns 404 / UNAUTHORIZED against the Raava stacks.

Plan references: `docs/plans/2026-09-09-001-feat-voice-helpdesk-foundry-plan.md` (Goal Capsule, U3, U4, KTD3, KTD7, KTD9, KTD16, ERD under High-Level Technical Design, D6 to D8). Action spec: `ontology/action-create-helpdesk-issue.md`.

---

## 1. Synthetic seed data

### Run the generator

Dependency-free TypeScript, run with Node 26's native TypeScript support (no `tsx`, no build step):

```sh
# committed CSVs (placeholder phone, example pepper)
PIN_PEPPER=example-pepper-do-not-use node ontology/seed/generate-seed.ts --out ontology/seed --seed 42

# real output for upload (gitignored)
PIN_PEPPER="$PIN_PEPPER" DEMO_CALLER_PHONE=+1XXXXXXXXXX DEMO_CALLER_PIN=NNNN \
  node ontology/seed/generate-seed.ts --out ontology/seed/local --seed 42 --print-demo-pin

# tests
node --test ontology/seed/generate-seed.test.ts
```

| Input | Meaning |
|---|---|
| `--out DIR` | Output directory (created if missing). Default `ontology/seed`. |
| `--seed N` | PRNG seed (mulberry32). Same seed and env give byte-identical CSVs. Default `42`. |
| `--print-demo-pin` | Print the demo caller's PIN to stderr. PINs are never written to any CSV. |
| `PIN_PEPPER` (env, required) | HMAC key. The script exits 2 with a clear message when unset. |
| `DEMO_CALLER_PHONE` (env) | E.164 phone of the demo caller `u-demo`. Default placeholder `+15550100000`. |
| `DEMO_CALLER_PIN` (env) | Four-digit PIN of the demo caller. Default `4321`. |

### What is generated

| File | Rows | Columns (ERD) |
|---|---|---|
| `sites.csv` | 3 | `siteId, name` |
| `teams.csv` | 4 (one is `triage` / "Triage") | `teamId, name` |
| `users.csv` | 12, unique E.164 phones, `u-demo` is the demo caller | `userId, fullName, phoneE164, pinHash, siteId` |
| `issues.csv` | 40, ids 4-digit in 1000 to 4999 | `issueId, title, description, status, priority, resolution, reportedByUserId, assignedTeamId, sourceConversationId, createdAt, updatedAt` |

- `status` is one of `open`, `in_progress`, `resolved` (seed 42: 17 / 10 / 13). `priority` is one of `low`, `normal`, `high`.
- `resolution` is filled only on resolved issues. `sourceConversationId` is empty in seed rows (the Action fills it for agent-created issues).
- `createdAt` / `updatedAt` are ISO-8601 UTC, derived from the seed (no wall clock), all before 2026-09-01.
- Seed ids stay below 5000; the service draws new ids from 5000 to 9999 (KTD16).

### PIN hashing (KTD7)

`pinHash = hex(HMAC-SHA256(key = PIN_PEPPER, message = "${userId}:${pin}"))`. The service's verify function must use the same formula (`hashPin` in `generate-seed.ts` is the reference). Every user gets a distinct four-digit PIN; only the demo PIN is knowable (env or default `4321`), and only when `--print-demo-pin` is passed.

**The committed CSVs in `ontology/seed/` contain only the placeholder phone `+15550100000` and were generated with `PIN_PEPPER=example-pepper-do-not-use`.** They are useless against the real service. Real output (real demo phone, real pepper) goes to `ontology/seed/local/`, which is gitignored. Never commit anything generated with the real pepper.

### Demo rows (seed 42)

| Purpose | Row |
|---|---|
| Demo caller | `u-demo`, Dana Whitfield, site `site-hq` (Harbor Point HQ) |
| AE3 status by identifier, AE4 two-hop (Issue to Team to Issues) | Issue `4127`, "Build server SSO login loops back to the sign-in page", `open`, `high`, reporter `u-demo`, team `platform` |
| AE5 known resolution | Issue `2210`, "VPN client disconnects every few minutes on office wifi", `resolved`, team `network`. Shares `vpn`, `client`, `disconnects`, `minutes`, `office`, `wifi`, `reconnect` with the AE5 script. |
| AE6 new issue | No seed issue shares more than one salient term with "the label printer on the loading dock prints blank pages after the firmware update". |

Salient terms are lower-cased alphanumeric tokens minus the stop words `the, on, and, i, to, a, after, every, few, my, have, it, is, of, in` (same shape the service's KTD9 search uses; `salientTerms` and `termOverlap` are exported for reuse).

### Upload the datasets

1. In Foundry on zap, open the **Raava** space and the `voice-helpdesk` project created at U1 (KTD3). Create a folder `Data/Backing Datasets` inside it (mirrors the `Internal Tooling/Data/Ontology/Backing Datasets` convention in `../../foundry-stack-state.md`).
2. **New > Dataset > Upload files**, one dataset per CSV: `helpdesk_sites`, `helpdesk_teams`, `helpdesk_users`, `helpdesk_issues`. Use the files from `ontology/seed/local/` (real pepper), not the committed ones.
3. In each dataset's **Schema** tab apply the inferred schema; set every column to `string` except `createdAt` and `updatedAt` on `helpdesk_issues` (`timestamp`). Confirm `issueId`, `userId`, `siteId`, `teamId` are strings so leading zeros and the 4-digit shape survive.
4. Re-uploading a CSV to the same dataset creates a new transaction; the object types re-index automatically under Object Storage v2.

Smoke check after upload:

```sh
pltr dataset get <helpdesk_issues rid> --profile zap
```

---

## 2. Ontology Manager click path

Reference pages (docs mirror under `../../Raava Training Program/knowledge-base/foundry/`): `object-link-types/create-object-type.md`, `object-link-types/create-link-type.md`, `object-link-types/create-value-type.md`, `object-link-types/allow-editing.md`, `ontology-manager/navigation.md`, `ontology-manager/save-changes.md`.

Ontology: **Raava Ontology**, api name `ontology-a75cc311-593f-4913-bb24-f4a2d923a7f9`, RID `ri.ontology.main.ontology.1a944941-d587-4363-8314-d6274b7b0381` (from `foundry-stack-state.md`; confirm at U1).

### 2.1 Value types (do these first)

Ontology Manager > **New > Value type**, save location `voice-helpdesk/Ontology/Value Types`:

| Value type | Base type | Constraint (enum) | Used by |
|---|---|---|---|
| `helpdeskIssueStatus` | String | `open`, `in_progress`, `resolved` | `Issue.status` |
| `helpdeskIssuePriority` | String | `low`, `normal`, `high` | `Issue.priority`; the Action's `priority` parameter options |

### 2.2 Object types

For each of the four, Ontology Manager > **New > Create object type**:

1. **Datasource**: choose the uploaded dataset in `voice-helpdesk`. All columns map to properties automatically.
2. **Metadata**: name, plural, description, icon. Add all four to a new type group `Voice help desk`.
3. **Properties / keys**: set the primary key and title key per the table below. On `Issue`, set `status` and `priority` to the value types from 2.1 (**Use value type** on the property).
4. **Generate actions**: skip for `User`, `Site`, `Team`. For `Issue`, skip too; the Action is created by hand in U4 (spec in `action-create-helpdesk-issue.md`).
5. **Save location**: `voice-helpdesk/Ontology/Object Types`. Save the ontology change.
6. **Datasources tab** on `Issue` after creation: confirm the backing is **Object Storage v2** (Workshop auto-refresh, plan U3 step 3), toggle **Enable edits**, and leave **Only allow edits via actions** on (default; the service user then needs only view on the objects, not dataset edit, per `action-types/permissions.md`).
7. Set the object type **status** to `active` for all four once saved (default `experimental`; matches the stack convention noted in `foundry-stack-state.md`).

| Object type | Display / plural | Primary key | Title key | Notes |
|---|---|---|---|---|
| `User` | Help Desk User / Help Desk Users | `userId` | `fullName` | `pinHash` is a secret-derived value; do not surface it in Workshop. |
| `Issue` | Help Desk Issue / Help Desk Issues | `issueId` | `title` | `status`, `priority` use the value types; `createdAt`, `updatedAt` are timestamps. |
| `Site` | Site / Sites | `siteId` | `name` | |
| `Team` | Team / Teams | `teamId` | `name` | |

Api names: use the object type api name the console proposes (`HelpdeskUser`, `HelpdeskIssue`, `Site`, `Team`), then record the final ones in the placeholder table below. Avoid the bare `User` api name if the console reports a clash with the existing CRM `Person`/`Contact` area; the service only cares about the recorded api name.

### 2.3 Link types

Ontology Manager > **New > Create link type**, relationship **Object type foreign keys**, cardinality **many-to-one**, save location `voice-helpdesk/Ontology/Link Types`:

| Link | Foreign key (many side) | Primary key (one side) | Api names (many side / one side) |
|---|---|---|---|
| Issue.reportedByUserId → User | `Issue.reportedByUserId` | `User.userId` | `reportedBy` / `reportedIssues` |
| Issue.assignedTeamId → Team | `Issue.assignedTeamId` | `Team.teamId` | `assignedTeam` / `assignedIssues` |
| User.siteId → Site | `User.siteId` | `Site.siteId` | `site` / `users` |

The two-hop reads the service needs (Issue → Team → Issues for AE4; Site → Users → Issues for the site count) are all pivots over these three links.

### 2.4 Verification (pltr smoke reads, after U1 confirms the delegated user token works)

```sh
ONT=ri.ontology.main.ontology.1a944941-d587-4363-8314-d6274b7b0381
pltr ontology object-type-list $ONT --profile zap   # four new types present
pltr ontology object-get $ONT HelpdeskIssue 4127 --profile zap   # AE3: status + assignedTeamId
pltr ontology object-linked $ONT HelpdeskIssue 4127 assignedTeam --profile zap   # link resolves to team platform
pltr ontology object-get $ONT HelpdeskIssue 2210 --profile zap   # AE5 resolved issue
pltr ontology object-count $ONT HelpdeskUser --profile zap   # 12
```

Substitute the recorded api names if the console assigned different ones.

### 2.5 Scripted alternative

`ontology/scripts/author-ontology.sh` drives most of sections 1 to 2.4 through
`pltr` instead of clicking through Ontology Manager. It is a convenience, not
a replacement for this document: read it alongside the click path above, not
instead of it.

**Network precondition.** Every subcommand except `--help` talks to Foundry.
Before running anything, confirm the CLI can reach zap:

```sh
~/.local/bin/pltr admin user current --profile zap
```

If that fails (404, UNAUTHORIZED, or a network/allowlist error), fix that
first; the script will fail the same way and there is nothing it can do about
it.

**Dry run first.** The script defaults to a dry run and only writes with an
explicit `--apply`:

```sh
# plan only, writes nothing
ontology/scripts/author-ontology.sh datasets
ontology/scripts/author-ontology.sh object-types
ontology/scripts/author-ontology.sh links
ontology/scripts/author-ontology.sh action

# after reading each plan, write for real, in order
ontology/scripts/author-ontology.sh datasets --apply
ontology/scripts/author-ontology.sh object-types --apply
ontology/scripts/author-ontology.sh links --apply
ontology/scripts/author-ontology.sh action --apply
ontology/scripts/author-ontology.sh verify

# or the whole sequence at once, still dry-run unless --apply is given
ontology/scripts/author-ontology.sh --apply all
```

`object-type-upsert`, `link-type-upsert`, and `action-type-upsert` have their
own dry-run mode, so the plan for those three steps still calls Foundry (it
just does not write). `dataset create`, `folder create`, `dataset files
upload`, and `dataset schema set` have no such mode, so without `--apply` the
script only prints the command it would run and never calls `pltr` for them.
Every RID and object/link/action-type id the script creates is recorded in
`ontology/scripts/state.env` (gitignored) and read back on the next run, so
re-running any subcommand, or the whole `all` sequence, is safe and picks up
where it left off.

`SEED_DIR` selects which CSVs get uploaded: it defaults to
`ontology/seed/local` (the real pepper and phone, gitignored) and falls back
to the committed `ontology/seed` placeholder CSVs with a loud warning if
`ontology/seed/local` does not exist. Do not let the placeholder fallback
upload silently; generate `ontology/seed/local` first (section 1) for
anything but a throwaway smoke test.

`ontology/scripts/action-create-helpdesk-issue.definition.json` is a
best-effort `ActionTypeCreate` document for the `action` subcommand. The
exact internal shape of that contract (parameter type unions, the
`addObjectRule` property-value mapping, validation constraint shapes) is not
documented anywhere in this repo or the `pltr-cli` reference, so this file is
a guess built from the Action spec (`ontology/action-create-helpdesk-issue.md`)
and the one worked example in the `pltr-cli` docs. **Validate it with the dry
run before trusting it**: `ontology/scripts/author-ontology.sh action` (no
`--apply`) calls `action-type-upsert` without writing, and pltr's own
validation error will name the first rejected key. If the dry run rejects the
parameter or rule shapes and a quick fix is not obvious, stop guessing against
the live stack and create the Action by hand in Ontology Manager per
`ontology/action-create-helpdesk-issue.md` instead — about 15 minutes,
sections 1 to 5 of that spec.

**What the script does not do, on purpose, and the UI must still do:**

- **Title keys.** `object-type-upsert` only sets the primary key; there is no
  `--title-key` flag anywhere in `pltr ontology`. Set `userId` -> `fullName`,
  `issueId` -> `title`, `siteId` -> `name`, `teamId` -> `name` as title keys
  in Ontology Manager (section 2.2 step 3) after running `object-types`.
- **Value types.** `object-type-add-property --type` only accepts primitive
  types (`STRING`, `TIMESTAMP`, ...), not the custom value types from section
  2.1. The script adds `Issue.status` and `Issue.priority` as plain `STRING`;
  attach `helpdeskIssueStatus` and `helpdeskIssuePriority` to them by hand
  (section 2.2 step 3).
- **The Action's submission criterion.** Deliberately left out of
  `action-create-helpdesk-issue.definition.json` — the internal condition
  shape for a current-user-group check is not documented anywhere available
  here, and guessing at it risked shipping a criterion that looks right but
  does not actually gate on `voice-helpdesk-writers`. Add it by hand in the
  Action's **Security & Submission Criteria** tab per
  `ontology/action-create-helpdesk-issue.md` section 3 (current user > group
  IDs includes `voice-helpdesk-writers`, failure message as specified there).
- **The Action log object type and the notification rule.** Sections 4 and 5
  of `ontology/action-create-helpdesk-issue.md`; both are configured on the
  Action's Overview/Rules tabs and have no equivalent in
  `action-type-upsert`'s documented definition surface.
- **The Developer Console application and its SDK scope** (section 6 of the
  Action spec) — outside `pltr ontology` entirely.

**Filling in the placeholder table (section 3) from `state.env`.** After
`datasets`, `object-types`, `links`, and `action` have all run with `--apply`,
`ontology/scripts/state.env` holds every RID and internal id the table below
needs:

| Placeholder table row | `state.env` key |
|---|---|
| Object type User / Issue / Site / Team RID | `OBJECT_TYPE_ID_HELPDESKUSER`, `OBJECT_TYPE_ID_HELPDESKISSUE`, `OBJECT_TYPE_ID_SITE`, `OBJECT_TYPE_ID_TEAM` |
| Link Issue -> User / Issue -> Team / User -> Site RID | `LINK_TYPE_ID_REPORTEDBY`, `LINK_TYPE_ID_ASSIGNEDTEAM`, `LINK_TYPE_ID_SITE` |
| Action create-helpdesk-issue RID | `ACTION_TYPE_ID_CREATEHELPDESKISSUE` |
| Dataset helpdesk_sites / helpdesk_teams / helpdesk_users / helpdesk_issues RID | `HELPDESK_SITES_DATASET_RID`, `HELPDESK_TEAMS_DATASET_RID`, `HELPDESK_USERS_DATASET_RID`, `HELPDESK_ISSUES_DATASET_RID` |

Copy each value into the matching RID column in section 3. The api names in
that table (`HelpdeskUser`, `HelpdeskIssue`, `Site`, `Team`, `reportedBy` /
`reportedIssues`, etc.) are the ones the script passes on the command line, so
they are already final; only the RID/id columns are filled from `state.env`.
Value types, the Action log object type, and everything else the UI still has
to do (title keys, submission criterion, notification rule, Developer
Console) are recorded in the table exactly as before, by hand, once created.

---

## 3. Placeholders the service needs

Fill these in at U1/U3/U4 and keep them here as the single source. The service reads api names from the generated SDK and RIDs from env.

| Item | Api name | RID | Filled at |
|---|---|---|---|
| Ontology | `ontology-a75cc311-593f-4913-bb24-f4a2d923a7f9` | `ri.ontology.main.ontology.1a944941-d587-4363-8314-d6274b7b0381` | confirm U1 |
| Project `voice-helpdesk` | n/a | `ri.compass.main.folder.9272e104-dd62-4897-9884-ef6a225252da` | U1 (recorded 2026-09-09) |
| Developer Console app `voice-helpdesk-service` (client-facing, user permissions, public client) | client id: `34afe235bf7f22065704d3d9dc9a46c9` (public), redirect `http://localhost:3000/auth/callback` registered, SDK generated | `ri.third-party-applications.main.application.48122a96-e9b1-44e9-8df8-e1665a11fade` | U1 (RID recorded 2026-09-09) |
| Group `voice-helpdesk-writers` (AE7 lever) | n/a | created 2026-09-09, demo user is a member | U4 |
| Object type User | `<TBD, e.g. HelpdeskUser>` | `ri.ontology.main.object-type.<TBD>` | U3 |
| Object type Issue | `<TBD, e.g. HelpdeskIssue>` | `ri.ontology.main.object-type.<TBD>` | U3 |
| Object type Site | `<TBD>` | `ri.ontology.main.object-type.<TBD>` | U3 |
| Object type Team | `<TBD>` | `ri.ontology.main.object-type.<TBD>` | U3 |
| Link Issue → User | `reportedBy` / `reportedIssues` | `ri.ontology.main.link-type.<TBD>` | U3 |
| Link Issue → Team | `assignedTeam` / `assignedIssues` | `ri.ontology.main.link-type.<TBD>` | U3 |
| Link User → Site | `site` / `users` | `ri.ontology.main.link-type.<TBD>` | U3 |
| Value type status | `helpdeskIssueStatus` | `ri.value-types.<TBD>` | U3 |
| Value type priority | `helpdeskIssuePriority` | `ri.value-types.<TBD>` | U3 |
| Action create-helpdesk-issue | `createHelpdeskIssue` | `ri.actions.main.action-type.<TBD>` | U4 |
| Action log object type | `<TBD, [LOG] Create helpdesk issue>` | `ri.ontology.main.object-type.<TBD>` | U4 |
| Dataset helpdesk_users | n/a | `ri.foundry.main.dataset.<TBD>` | U3 |
| Dataset helpdesk_issues | n/a | `ri.foundry.main.dataset.<TBD>` | U3 |
| Dataset helpdesk_sites | n/a | `ri.foundry.main.dataset.<TBD>` | U3 |
| Dataset helpdesk_teams | n/a | `ri.foundry.main.dataset.<TBD>` | U3 |
| Dev Console app (main) client id | n/a | `<TBD>` | U1 |
| Dev Console app (restricted, AE7) client id | n/a | `<TBD>` | U4 |
| Main app service user id | n/a | `<TBD>` | U1 |
| Restricted app service user id | n/a | `<TBD>` | U4 |
| SDK package name + install command + registry token location | `<TBD from Developer Console>` | n/a | U1 |
| Administrator Foundry user (notification recipient) | n/a | `<TBD>` | U4 |

Service env keys expected (owned by `service/`, see `service/.env.example`): `FOUNDRY_STACK_URL=https://zap.usw-18.palantirfoundry.com`, `FOUNDRY_ONTOLOGY_RID`, `FOUNDRY_CLIENT_ID`, `FOUNDRY_CLIENT_SECRET`, `PIN_PEPPER`. The restricted application's client id and secret are not service configuration: for AE7 the human swaps them into `FOUNDRY_CLIENT_ID` and `FOUNDRY_CLIENT_SECRET` in the Railway dashboard for one call (run sheet). The triage team id is fixed to `triage` in the service.

---

## 4. Findings

### U1 (Foundry access spike)

The probe is `service/scripts/probe-foundry.ts`, run through `tsx` (as `pnpm dev` is) because it imports the service's own auth module, whose `.js`-suffixed imports Node's native type stripping does not rewrite. It logs the delegated user in through the
Developer Console public client (PKCE + `offline_access`, plan KTD3) using a local callback listener, then runs one step per
line. It never prints a token, an OAuth code, or a full response body; error text is redacted and capped at 300 characters.
Its pure helpers (argument parsing, redaction, edit-list and validation extraction) are unit tested in
`service/scripts/__tests__/probe-foundry.test.ts`.

#### Commands

Run from the repo root. The redirect URL must be registered on the app exactly as given (default `http://localhost:3000/auth/callback`,
so port 3000 must be free; stop any local `pnpm dev` first, or set `FOUNDRY_REDIRECT_URL` to another registered URL).

```bash
# 1. Metadata + object types only (proves the token and the ontology scope)
FOUNDRY_STACK_URL=https://zap.usw-18.palantirfoundry.com FOUNDRY_CLIENT_ID=<client id> FOUNDRY_ONTOLOGY_RID=<ri.ontology.main.ontology.…> \
  pnpm --dir service exec tsx scripts/probe-foundry.ts

# 2. Object read (one seeded object of the throwaway type; also try a type outside the app's resource restrictions)
FOUNDRY_STACK_URL=… FOUNDRY_CLIENT_ID=… FOUNDRY_ONTOLOGY_RID=… \
  pnpm --dir service exec tsx scripts/probe-foundry.ts --object-type <objectTypeApiName> --pk <primaryKey>

# 3. Action apply, valid parameters (prints the added primary keys from returnEdits: ALL)
FOUNDRY_STACK_URL=… FOUNDRY_CLIENT_ID=… FOUNDRY_ONTOLOGY_RID=… \
  pnpm --dir service exec tsx scripts/probe-foundry.ts --action <actionApiName> --params '{"title":"probe","priority":"normal"}'

# 4. Action apply, deliberately invalid (omit a required parameter, or send a wrong type)
FOUNDRY_STACK_URL=… FOUNDRY_CLIENT_ID=… FOUNDRY_ONTOLOGY_RID=… \
  pnpm --dir service exec tsx scripts/probe-foundry.ts --action <actionApiName> --params '{"priority":"normal"}'

# 5. Action apply while NOT in the throwaway Action's writers group (AE7 evidence; log in as that user)
FOUNDRY_STACK_URL=… FOUNDRY_CLIENT_ID=… FOUNDRY_ONTOLOGY_RID=… \
  pnpm --dir service exec tsx scripts/probe-foundry.ts --action <actionApiName> --params '{"title":"probe","priority":"normal"}'

# 6. Refresh rotation: two forced refreshes, then a 75 s wait and a replay of the first refresh token (expect 4xx)
FOUNDRY_STACK_URL=… FOUNDRY_CLIENT_ID=… FOUNDRY_ONTOLOGY_RID=… \
  pnpm --dir service exec tsx scripts/probe-foundry.ts --refresh-test --grace-wait-seconds 75
```

Each run prints an authorize URL; open it in a browser, log in, and the probe continues when the callback lands. A single
run may combine `--object-type/--pk`, `--action/--params`, and `--refresh-test`.

#### Checklist: paste the observed output under each heading

- [ ] **Developer Console record.** Application RID, client id (public, no secret), every scope string the console shows on the
      application (expected `api:use-ontologies-read`, `api:use-ontologies-write`, `offline_access`, plus any `api:use-*` the
      console adds), the redirect URLs registered, the resource restrictions (four object types + the Action), and the SDK
      install command with the registry token location (the token itself stays in the console).
- [ ] **Login.** The `login: ok {...}` line (auth status and expiry only).
- [ ] **Ontology metadata.** The `ontology metadata:` line with `apiName`, `displayName`, `rid`.
- [ ] **Object types.** The `object types (pageSize=5):` line with the `apiNames` list; note whether types outside the
      app's restrictions appear.
- [ ] **Object read, in scope.** The `object read: ok` line showing `__apiName` and `__primaryKey`.
- [ ] **Object read, out of scope.** The `object read: failed` line for a type outside the app's restrictions
      (`errorName`, `errorCode`, `status`).
- [ ] **Action apply, success.** The `action apply: ok` line with `validation.result` and the `added` primary keys, and a note
      that the Action log in Ontology Manager names the delegated user and the application.
- [ ] **Action apply, invalid parameter.** The `action apply: failed` line: HTTP status, `errorName`, `errorCode`,
      `validation.invalidParameters` (must name the missing parameter), redacted `message`.
- [ ] **Action apply, submission criteria not met (AE7).** The `action apply: failed` line with `validation.submissionCriteria`
      (result and configured failure message) and confirmation that nothing was created.
- [ ] **Refresh.** The `refresh rotation:` line (`rotated: true`, refresh count, expiry before/after) and the
      `old refresh token rejected after grace:` line (expected 4xx with `error: invalid_grant`), then
      `current token still valid after rotation: ok`.
- [ ] **Stored literals.** Read one open and one resolved issue and confirm status values are exactly `open`, `in_progress`, `resolved` and priority values `low`, `normal`, `high`; the service filters on these literals (override via `FOUNDRY_ONTOLOGY_NAMES.statusValues` if the ontology differs).
- [ ] **REST filter shapes.** Note which of these the stack accepted: `and`/`or` filters with `value: [...]`, the `in` filter, the `count` aggregate body, and `returnEdits: "ALL"` on the Action apply (the adapter has a fallback for the aggregate only).
- [ ] **Stop conditions.** State whether any Goal Capsule stop condition triggered (no delegated login possible, Action cannot
      be applied from an external process, or submission criteria not enforced server-side).

### U14 (keypad spike)

_To be filled at U14: keypad timeout value, whether the agent yields a turn on silence, whether stored tool-call parameters show the digits, per-turn metric field names in the post-call payload._
