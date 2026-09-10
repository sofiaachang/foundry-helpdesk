# Ontology: voice help desk (plan U3, U4)

Four object types (`User`, `Issue`, `Site`, `Team`), three links, two value types, one Action (`create-helpdesk-issue`), all living in a dedicated `voice-helpdesk` project in the **Raava** space on the **zap** stack (`zap.usw-18.palantirfoundry.com`).

**Every `pltr` command in this folder must use `pltr -p zap`.** The CLI's default profile points at an unrelated tenant and returns 404 / UNAUTHORIZED against the Raava stacks.

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
pltr -p zap dataset get <helpdesk_issues rid>
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

### 2.4 Verification (pltr smoke reads, after U1 gives the service user access)

```sh
ONT=ri.ontology.main.ontology.1a944941-d587-4363-8314-d6274b7b0381
pltr -p zap ontology object-type-list $ONT                                   # four new types present
pltr -p zap ontology object-get $ONT HelpdeskIssue 4127                      # AE3: status + assignedTeamId
pltr -p zap ontology object-linked $ONT HelpdeskIssue 4127 assignedTeam     # link resolves to team platform
pltr -p zap ontology object-get $ONT HelpdeskIssue 2210                      # AE5 resolved issue
pltr -p zap ontology object-count $ONT HelpdeskUser                          # 12
```

Substitute the recorded api names if the console assigned different ones.

---

## 3. Placeholders the service needs

Fill these in at U1/U3/U4 and keep them here as the single source. The service reads api names from the generated SDK and RIDs from env.

| Item | Api name | RID | Filled at |
|---|---|---|---|
| Ontology | `ontology-a75cc311-593f-4913-bb24-f4a2d923a7f9` | `ri.ontology.main.ontology.1a944941-d587-4363-8314-d6274b7b0381` | confirm U1 |
| Project `voice-helpdesk` | n/a | `ri.compass.main.folder.<TBD>` | U1 |
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

Service env keys expected (owned by `service/`): `FOUNDRY_HOST=https://zap.usw-18.palantirfoundry.com`, `FOUNDRY_ONTOLOGY_RID`, `FOUNDRY_CLIENT_ID`, `FOUNDRY_CLIENT_SECRET`, `FOUNDRY_RESTRICTED_CLIENT_ID`, `FOUNDRY_RESTRICTED_CLIENT_SECRET`, `PIN_PEPPER`, `TRIAGE_TEAM_ID=triage`.

---

## 4. Findings

### U1 (Foundry access spike)

_To be filled at U1: scope strings the console shows, roles granted to the service user, SDK install command and registry token location, observed validation and permission error shapes, whether `applyAction` from Node with client credentials succeeds on zap._

### U14 (keypad spike)

_To be filled at U14: keypad timeout value, whether the agent yields a turn on silence, whether stored tool-call parameters show the digits, per-turn metric field names in the post-call payload._
