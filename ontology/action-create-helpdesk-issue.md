# Action spec: `create-helpdesk-issue` (plan U4)

The only write path from the voice agent into Foundry. The integration service applies this Action with client credentials (KTD3); the agent never holds a Foundry token. Status defaults to `open`, identifiers are service-supplied four-digit strings (KTD16), and every submission produces an Action log object and an administrator notification (KTD4).

Plan references: U4, KTD3, KTD4, KTD10, KTD16; R11, R12, R14. Contract: `docs/contract/integration-contract.md` (`create_issue` tool, at-most-once section).

Placeholders (api name, RID, client ids, user ids) are recorded in `ontology/README.md` section 3 once created.

---

## 1. Identity

| Field | Value |
|---|---|
| Display name | Create helpdesk issue |
| Api name | `createHelpdeskIssue` (console proposes from the display name; record the final value) |
| Save location | `voice-helpdesk/Ontology/Actions` in the Raava space on zap |
| Rule | **Create object** of type `Issue` (`HelpdeskIssue`) |
| Description | Creates a help desk Issue from a verified voice call. Applied only by the integration service. |

Click path: Ontology Manager > **Action type** (left sidebar) > **New Action type** > Display name as above > **Change object(s)** = **Create** > object type `Issue` > **Create**. Then use the **Rules**, **Forms**, **Security & Submission Criteria**, and **Side effects** tabs as described below (`action-types/getting-started.md`).

## 2. Parameters (Forms tab)

Order and api names matter: the generated SDK exposes them by api name.

| Parameter (api name) | Type | Required | Constraint | Maps to |
|---|---|---|---|---|
| `issueId` | String | yes | Regex `^\d{4}$`. Supplied by the service (drawn from 5000 to 9999, KTD16). Becomes the primary key of the created object. A duplicate primary key fails validation; the service redraws once. | `Issue.issueId` |
| `title` | String | yes | Length 5 to 120 | `Issue.title` |
| `description` | String | yes | Length 10 to 2000 | `Issue.description` |
| `priority` | String | yes | **Multiple choice**, options from value type `helpdeskIssuePriority`: `low`, `normal`, `high` | `Issue.priority` |
| `reportedBy` | Object reference: `User` | yes | Must resolve to an existing `User` (object reference parameters reject unknown primary keys) | `Issue.reportedByUserId` = `reportedBy.userId` |
| `assignedTeam` | Object reference: `Team` | yes | Must resolve to an existing `Team`. The service always passes `triage` (F3). | `Issue.assignedTeamId` = `assignedTeam.teamId` |
| `sourceConversationId` | String | no | Regex `^[A-Za-z0-9_-]{8,128}$` when present (contract format) | `Issue.sourceConversationId` |

Properties set by the rule, not by parameters:

| Property | Value |
|---|---|
| `status` | Static value `open` (value type `helpdeskIssueStatus`) |
| `resolution` | Empty / null |
| `createdAt` | **Current time** at submission |
| `updatedAt` | **Current time** at submission |

Form UX is irrelevant for the service (it calls the API), but keep the parameter labels readable so the Action can also be applied by hand from the Object View during U4 testing.

Why `issueId` is a parameter: a form-based Action can only mint UUID prefills, and a UUID cannot be read digit by digit over the phone (KTD16). Seed ids stay below 5000 so a redraw never collides with seed data.

## 3. Submission criteria (Security & Submission Criteria tab)

One root condition using the **Current user** template:

- **Current user > group IDs** `includes` a static group `voice-helpdesk-writers` (create the group at U1; the main app's service user is its only member).
- Failure message: `Only the voice help desk service may create issues.`

Parameter-level bounds (length, regex, multiple choice) live on the parameters themselves (section 2) and produce per-parameter validation messages; submission criteria do not support object set or attachment parameters, and the group check is the only criterion needed (`action-types/submission-criteria.md`).

## 4. Action log

On the Action's **Overview / Settings**: enable **Create action log objects** and generate the log object type (`[LOG] Create helpdesk issue`). Store:

- Default fields: action RID, action type RID and version, timestamp, submitting user id, edited object primary keys.
- **Parameter values**: all seven parameters (the object references store `reportedBy.userId` and `assignedTeam.teamId`; property capture of object reference parameters is supported because neither allows multiple values).
- **Summary** template: `Voice issue {issueId} "{title}" for {reportedBy > fullName}`.

Save location: `voice-helpdesk/Ontology/Object Types`. The log object type is a Foundry system artifact, so D6 (four domain types) still holds. Record its api name and RID in the README table. The service user needs view on the log object type to apply the Action (`action-types/action-log.md`: "users need the appropriate permissions for the action log object type, just as they do for any other object types that the action type might create").

## 5. Notification rule (Rules tab > Add new rule > Notification)

Recipients must be Foundry principals; the synthetic `User` objects are not Foundry users, so the recipient is static (KTD4).

| Setting | Value |
|---|---|
| Recipients | **Static recipient(s)**: the administrator's Foundry user (record the user id in the README table) |
| Content | **Template** |
| Subject | `New help desk issue /issueId: /title` |
| Body | `A caller created issue /issueId ("/title", priority /priority) reported by /reportedBy > fullName and assigned to /assignedTeam > name. Submitted by /Current User. Conversation /sourceConversationId.` |
| Link | **Object View** of the created `Issue`, label `Open issue` |

Notes from `action-types/set-up-notification.md` and `action-types/permissions.md`: the recipient must have view access to every object referenced in the content or the notification is silently not sent, the submitting user (the service user) must be able to view the recipient principal, and a failed notification does not roll back the edit. Test with the administrator as recipient by applying the Action from the Object View before wiring the service.

## 6. Developer Console applications (KTD3)

Both are **backend service** applications with **Application permissions** (generated service user, client credentials grant, no authorization-code grant, no redirect URL). Both generate an Ontology SDK over the Raava Ontology (`developer-console/create-application.md`, `developer-console/permissions.md`).

| | Main app (`voice-helpdesk-service`) | Restricted app (`voice-helpdesk-restricted`, AE7 only) |
|---|---|---|
| SDK scope | Object types `User`, `Issue`, `Site`, `Team`; Action `createHelpdeskIssue` | Identical scope (the Action is in scope so AE7 fails at apply time, never as an OAuth scope error) |
| Project role on `voice-helpdesk` | **Viewer** (covers the four backing datasets, the value types, and the log object type's dataset) | **Viewer** |
| Issue dataset edit role | The minimum edit role the Action needs. With **Only allow edits via actions** on (OSv2, `object-link-types/allow-editing.md`), no dataset edit role is required; if the console still demands one at U1, grant **Editor** on `helpdesk_issues` only and record it. | None |
| Apply role on the Action | Member of `voice-helpdesk-writers` (passes submission criteria) | Not a member (fails submission criteria, so no edit and no side effects) |
| Ontology Manager / Owner roles | None | None |
| Used by | Service, all normal calls | Service, only when `FOUNDRY_RESTRICTED_CLIENT_ID` is selected for the AE7 run |

Grant the roles at the project level (`voice-helpdesk` project > **Manage** > roles) so nothing outside the project is visible to either service user. Record scope strings, client ids, and service user ids in the README table.

## 7. Expected validation and permission cases (observe and record at U4)

Apply via `pltr -p zap ontology action-validate <ontology rid> createHelpdeskIssue '<json>'` (no edit) and then `action-apply`, once with the main app credentials and once with the restricted app credentials. Record the exact message text in the last column; it drives the service's failure-category mapping (U8).

| # | Case | Parameters | Expected | Observed message (fill at U4) |
|---|---|---|---|---|
| 1 | Valid create (AE6) | `issueId=7342, title="Label printer prints blank pages", description=<AE6 text>, priority=normal, reportedBy=u-demo, assignedTeam=triage, sourceConversationId=conv_demo_0001` | `VALID`; object `7342` exists with status `open`; a `[LOG]` object with the service user as submitter; administrator notification received | |
| 2 | Empty title | as 1 but `title=""` | `INVALID`; parameter-level failure naming `title` (length 5 to 120); nothing created | |
| 3 | Unknown team reference | as 1 but `assignedTeam=nope` | `INVALID`; object reference parameter cannot resolve `Team` `nope`; nothing created | |
| 4 | Duplicate `issueId` | as 1 (`7342` already exists) | `INVALID`; primary key already exists; nothing created (service redraws once, KTD16) | |
| 5 | Restricted app (AE7) | as 1 with `issueId=7343`, restricted client id | Apply denied at Action level (submission criteria / permission), nothing created, no log object, no notification | |
| 6 | Bad `issueId` shape | as 1 but `issueId=12345` | `INVALID`; regex failure naming `issueId` | |
| 7 | Priority outside the value type | as 1 but `priority=urgent` | `INVALID`; multiple-choice failure naming `priority` | |

Error text never reaches the agent; the service maps each category to `failed` with escalation (contract "Error envelope").

## 8. Docs mirror pages used

All under `../../Raava Training Program/knowledge-base/foundry/`:

- `action-types/getting-started.md` (creation wizard, Forms tab, multiple-choice constraint, submission criteria placement)
- `action-types/action-log.md` (enabling log objects, stored fields, permissions on the log type)
- `action-types/set-up-notification.md` (rule placement, static recipients, template syntax, Object View link)
- `action-types/permissions.md` (apply permissions, only-edits-via-actions, side-effect permissions)
- `action-types/submission-criteria.md` (current-user group condition, failure message)
- `developer-console/create-application.md` and `developer-console/permissions.md` (application permissions, service user, SDK scope)
- `object-link-types/allow-editing.md` (enable edits toggle on OSv2)
