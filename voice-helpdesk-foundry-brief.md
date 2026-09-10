# Voice Help Desk on Palantir Foundry: Project Brief

**Status:** requirements brief, not a plan. The plan does not exist yet and should be produced by the receiving agent.

**Suggested repo path:** `docs/product/voice-helpdesk-foundry-brief.md`

---

## 0. How to use this file

This project uses the Compound Engineering plugin (`EveryInc/compound-engineering-plugin`). Install it first if it is not already present.

```
/plugin marketplace add EveryInc/compound-engineering-plugin
/plugin install compound-engineering
/ce-setup
```

Then run, in this order:

```
/ce-plan docs/product/voice-helpdesk-foundry-brief.md
/ce-work
/ce-simplify-code
/ce-code-review
/ce-compound
```

**Do not run `/ce-brainstorm` first.** The product shape is already settled and recorded in section 4. Brainstorming would re-open decisions that have been made deliberately.

**Do not run `/lfg`.** This build has hard human gates (section 11) where the work cannot proceed without credentials, a purchased phone number, and a person clicking things in two vendor consoles. An unattended pipeline will stall or, worse, invent stubs around the gates and produce something that looks finished and is not.

When `/ce-plan` runs, treat section 4 decisions as `session-settled: user-directed`. Do not re-ask them. Section 5 lists what genuinely is open and should be raised at the scoping checkpoint.

---

## 1. What this is

A demonstration system in which an engineer at a large company calls a help desk phone line, speaks to an AI voice agent, and the call results in a governed record being created inside Palantir Foundry, visible in a Workshop application that a human administrator works out of.

It is built as a portfolio and interview artifact, not a production system. That distinction matters for scoping: it must be genuinely working end to end and genuinely honest about its limitations, but it does not need to scale, and it should not accumulate production hardening that costs time without improving the demonstration.

## 2. Why it is being built

Three purposes, in priority order.

1. **Interview evidence.** The author is interviewing for a Deployment Strategist role at ElevenLabs. The demo needs to show hands-on fluency with the voice platform and an understanding of what stops enterprise voice deployments from reaching production.
2. **A public technical argument.** The interesting claim is not "a voice agent can create a ticket." It is that when the agent's write path is a Foundry Action rather than an arbitrary API call, the write inherits permissions, parameter validation, and an audit record. That is what enterprise security review actually asks about. This will be written up publicly.
3. **Platform learning.** Hands-on depth in Foundry ontology modelling, Actions, OSDK, and Workshop, plus the ElevenLabs agent stack.

Optimise the plan for a working, demonstrable, honestly-caveated system. Do not optimise for feature count.

## 3. Architecture in one paragraph

A caller reaches an ElevenLabs voice agent over a phone number. The agent's tools are webhooks pointed at a small integration service. That service holds Foundry credentials, translates agent tool calls into OSDK reads and Action applications, and returns compact results shaped for speech. Foundry holds the ontology, the Actions, the audit trail, and a Workshop module where an administrator sees issues appear. The voice agent never holds a Foundry credential and cannot write anything outside a defined Action.

The integration service exists because handing a third-party voice vendor a Foundry token is the wrong architecture, and because a dev-tier Foundry environment is unlikely to permit outbound egress configuration. Reads and writes are therefore initiated from outside Foundry, not from inside it.

## 4. Settled decisions: do not re-ask

These were decided deliberately. Record them as `session-settled: user-directed`. Research may contradict them only on invalidating evidence, not on preference.

**D1. One caller persona, not two.** The caller is an engineer with a technical problem. That same caller asks read questions (status of my last ticket, has this happened before, how many open issues at my site) and then creates a new issue. The administrator is a viewer of the Workshop table and never calls in. A second calling persona was considered and rejected: it doubles the authorisation model and breaks the demo into two disconnected calls.

**D2. The integration service sits between the agent and Foundry.** Not a direct agent-to-Foundry connection, and not Foundry-initiated egress.

**D3. Phone number identifies, it does not authenticate.** Caller ID matches the caller to a User object so the agent knows who is probably calling. It grants nothing on its own. Caller ID is trivially spoofable and the system must not treat it as proof.

**D4. Authentication is a keypad-entered PIN, not a spoken passphrase.** Digits arrive as keypad tones so the secret never enters the speech transcript. A spoken passphrase was considered and rejected on three grounds: it lands in stored transcripts, it is replayable by anyone who overhears or reads a transcript, and speech recognition on arbitrary secret strings is unreliable.

**D5. Actions are tiered by verification level.** Reading your own issue status and creating an issue are not the same risk as anything that touches another person's work. The plan should make the tiering explicit rather than treating all authenticated callers as fully trusted.

**D6. Four object types only.** User, Issue, Site, Team. Links: Issue reported-by User, Issue assigned-to Team, User located-at Site. This is deliberately minimal and is sufficient for every read described in section 8, including two-hop traversal. Additional object types are out of scope and should be pushed back on.

**D7. Similar-issue search must be able to fail visibly.** The agent searches prior issues before creating a new one, and reads back a known resolution when it finds one. The demo deliberately includes a case where search finds nothing relevant and the agent proceeds to create the issue. A demo where retrieval always succeeds is not believable.

**D8. Synthetic data only.** No real company, customer, or employee data enters this system at any point.

## 5. Genuinely open questions

Raise these at the `/ce-plan` scoping checkpoint. Do not decide them unilaterally.

- Deployment target for the integration service. Needs a stable public HTTPS URL. A dev tunnel is acceptable for local iteration but the URL instability will cost time if it becomes the demo path.
- Whether the administrator notification is a Workshop-native notification or an outbound webhook to a chat channel. Pick the cheaper one; this is the last five percent of the story and should not consume a day.
- Whether a second-tier action (something touching another caller's issue) is worth building to demonstrate D5, or whether stating the tiering in the write-up is sufficient.
- Whether per-caller permission scoping (the same question returning different data depending on who calls, enforced by the platform rather than by the integration service) is in scope. This is the single most impressive capability available and also the most expensive. Treat as a stretch goal, decide explicitly.

## 6. Actors

- **Caller.** An engineer at a large company with a technical problem. Not technical about this system. On a phone, possibly a mobile one, possibly somewhere noisy.
- **Administrator.** Works out of the Workshop table. Does not interact with the voice system.
- **Integration service.** Holds credentials. Trusted by Foundry, not trusted by the caller.
- **Voice agent.** Holds no credentials. Can only do what its tools allow.

## 7. Key flows

**F1. Identify and verify.** Call arrives. Caller ID is matched against User objects. The caller enters a PIN by keypad. Failed attempts are limited and a caller who cannot verify is offered escalation rather than an unlimited retry loop.

**F2. Read.** A verified caller asks about their own open issues, the status of a specific issue, who is working on it, whether similar issues have been reported before, or a count of open issues at their site.

**F3. Write.** The caller describes a new problem. The agent searches prior issues, offers a known resolution if one exists, and otherwise confirms the details back to the caller and applies a Foundry Action that creates the Issue object. The new issue appears in the Workshop table and the administrator is notified.

## 8. Requirements

**Verification**

- The system must not disclose any account or issue information before verification succeeds.
- The system must not confirm or deny whether a given phone number corresponds to a known user before verification succeeds.
- PIN entry must be by keypad tone, never by speech.
- Failed verification attempts must be limited, and the limit must be enforced server-side in the integration service, not by prompt instruction alone.

**Reads**

- Status of a specific issue by identifier.
- The caller's own open issues.
- Two-hop traversal: the assignee of an issue and what else is in that assignee's queue.
- An aggregate count, scoped to the caller's site.
- Similar-issue search over prior issue text, returning the resolution where one exists.
- Read results must be shaped for speech. A voice agent reading a list of twelve items is a failed interaction. Aggregates and top-N with an offer to continue are the correct shapes.

**Writes**

- Issue creation must go through a Foundry Action, never a direct object write.
- The Action must validate its parameters and must fail closed if the calling identity lacks permission.
- The agent must confirm the issue details back to the caller before the Action is applied.
- The resulting audit record must be inspectable and must be shown during the demo.

**Escalation**

- The caller can ask for a human at any point.
- Two failed verification attempts route to escalation.
- Anything outside the defined capabilities routes to escalation rather than being improvised.
- Escalation must carry context forward so the caller does not repeat themselves.

**Observability**

- Every agent tool call must be logged with a correlation identifier that ties the conversation to the resulting Foundry Action.
- Time to first audio must be measurable, not estimated.

## 9. Acceptance examples

These should carry into the plan as test scenarios.

- **AE1.** An unverified caller asks for their open issues. The agent declines and asks for verification. No issue data is disclosed.
- **AE2.** A caller enters a PIN that does not match. The agent reports failure and offers one retry. On the second failure it offers escalation and does not offer a third attempt.
- **AE3.** A verified caller asks the status of a known issue identifier. The agent reports status and assignee.
- **AE4.** A verified caller asks who is working on their issue and what else that team has open. The agent traverses two links and answers.
- **AE5.** A verified caller describes a problem matching a resolved prior issue. The agent reads back the known resolution and asks whether that resolves it. The caller says yes. No new issue is created.
- **AE6.** A verified caller describes a problem with no prior match. The agent confirms details, applies the Action, and reads back the new issue identifier. The object appears in the Workshop table.
- **AE7.** The Foundry Action is applied by a service identity lacking permission for the target team. The Action fails closed. The agent reports that it could not create the issue and escalates. It does not claim success.
- **AE8.** The integration service is artificially slowed. The agent covers the gap with speech rather than producing silence, and the caller experience remains acceptable.
- **AE9.** The caller interrupts the agent mid-sentence while it is reading issue details. The agent stops and responds to the interruption.

## 10. Scope boundaries

**In scope**

Voice agent, integration service, ontology, Actions, seeded synthetic data, Workshop module with an issue table, administrator notification, end-to-end tests against the acceptance examples, latency instrumentation, and a written demo run sheet.

**Out of scope**

Multi-tenancy. Production authentication such as SMS one-time codes or SSO. Real telephony scale. Internationalisation. Any object type beyond the four in D6. Issue resolution workflow beyond creation. Anything requiring a paid Foundry tier feature not available in the target environment.

**Explicitly not the goal**

This is not a production help desk. Do not add retry queues, circuit breakers, caching layers, or horizontal scaling. If the plan starts producing units that only make sense at scale, that is a signal to cut them.

## 11. Human gates: mandatory stops

Execution must halt at each of these and wait for the human. Do not stub past a gate. Do not synthesise a placeholder credential and continue. A gate that is worked around silently produces a build that appears complete and is not.

The plan should encode each of these as a blocker on the units that depend on it.

**G1. Foundry environment and identity.** Before any ontology work. The human confirms which Foundry environment is being used, that they can create object types and Actions in it, and provisions the service identity the integration layer will use. Blocks all Foundry units.

**G2. Integration contract sign-off.** After the interface between the integration service and the voice agent is specified and before either side is implemented. The human reviews and approves the endpoint list and payload shapes. This gate is what allows the Foundry track, the service track, and the agent track to proceed in parallel afterwards. Blocks the service and agent tracks.

**G3. Credentials in place.** Before the integration service can call Foundry. The human supplies the Foundry client credentials and confirms where secrets are stored. Secrets are never committed. Blocks all live-integration units.

**G4. ElevenLabs workspace and retention settings.** Before agent configuration. The human creates the workspace, selects a plan tier, and makes an explicit decision about conversation and audio retention. The retention decision is a design decision in this project, not a default to accept. Blocks all agent units.

**G5. Phone number connected.** Before any telephony testing. The human purchases a number and connects it. Blocks telephony units only; browser-based agent testing can proceed without it.

**G6. Public URL confirmed.** Before agent tools can be pointed anywhere. The human confirms the integration service's reachable HTTPS URL and whether it is stable or ephemeral. Blocks agent tool configuration.

**G7. End-to-end dry run.** After all tracks converge and before demo polish. The human runs the full call themselves and signs off. Do not proceed to polish on the strength of automated tests alone. The failure modes that matter in voice are the ones a human hears.

## 12. Manual setup the human must perform

Collected in one place. The plan should reference this section rather than duplicating it.

| What | Where | Blocks |
|---|---|---|
| Confirm Foundry environment and object-creation rights | Foundry | G1 |
| Provision service identity and record its permissions | Foundry | G1, G3 |
| Generate client credentials and store the secret | Foundry, then the secret store | G3 |
| Create the ElevenLabs workspace and choose a plan tier | ElevenLabs console | G4 |
| Decide and set conversation and audio retention | ElevenLabs console | G4 |
| Purchase a phone number and connect it to the agent | Telephony provider, then ElevenLabs console | G5 |
| Deploy the integration service and record its public URL | Hosting provider | G6 |
| Paste the integration URL and shared secret into each agent tool | ElevenLabs console | G6 |
| Choose and configure the administrator notification target | Foundry or chat provider | none, but needed for the demo |
| Run the full call end to end and sign off | Phone | G7 |

## 13. Non-functional constraints

**Latency.** Time to first audio should be measured, not assumed. Target the median under 800ms and the 95th percentile under 1.5s. Anything the integration service does synchronously inside a tool call is inside that budget. Where a tool is slow, the fix is speech that covers the gap, not silence.

**Privacy.** No secret, PIN, or credential may appear in a stored transcript. Retention settings are a deliberate configuration, and the choice made should be recorded in the plan with its reasoning.

**Honesty.** Where the demo takes a shortcut, the shortcut must be documented and stated out loud during the demo. The PIN mechanism in particular is a shared static secret and should be presented as such, with the production alternative named. Do not let the build quietly acquire the appearance of production security it does not have.

## 14. Risks to carry into the plan

- Caller ID spoofing. Mitigated by D3 and D4, not eliminated. Must be stated in the write-up.
- Static PIN replay. Accepted for the demo, documented as a limitation.
- Dev-tier Foundry limits on API access or Action permissions. Discovered at G1. If Actions cannot be applied by an external identity in the target environment, the whole architecture needs revisiting and that must surface before any other work starts.
- Ephemeral tunnel URLs breaking agent tool configuration between sessions. Cheap to avoid with a stable deployment, expensive to keep re-fixing.
- OSDK version drift against whatever the environment generates. Verify against the actual generated client rather than against documentation.
- Speech recognition accuracy on issue identifiers and technical terms. Worth testing early; it may change how identifiers are read back.

## 15. Definition of done

The build is done when a person can dial the number, verify by keypad, ask about an existing issue, describe a new problem, hear it confirmed back, hang up, and see the new Issue object in the Workshop table with an inspectable Action record showing who initiated the write, when, with what parameters, and under whose permissions.

Plus: all acceptance examples in section 9 pass, time to first audio has been measured and recorded, and the limitations in section 13 are written down.

## 16. For `/ce-compound` afterwards

Capture at minimum: the measured latency contribution of each stage, what the Foundry environment actually permitted versus what was assumed at G1, what broke in the voice interaction that automated tests did not catch, and the recognition accuracy findings on identifiers. These are the learnings that make the second build of this kind faster, and they are also the substance of the public write-up.
