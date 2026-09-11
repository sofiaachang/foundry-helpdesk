# Limitations and shortcuts (say these out loud)

Plan U13. Every shortcut the demo takes, with the production alternative named. Items marked "pending" are filled after the dry run (G7).

## Identity and permissions

1. **No service identity.** The zap enrollment plan has no client-credentials grant, so the integration service cannot act as a generated service user. It acts as a delegated user (the presenter) through a public OAuth client with PKCE and a refresh token. The Action log therefore shows the presenter as the submitter, via the application. Production: a confidential client with its own service user, granted only the four object types and the Action.
2. **The token lives in the service's memory.** Foundry rotates the refresh token on each use and invalidates it after 30 days idle; Railway's disk is ephemeral. A restart means one re-login click before the next call. Production: a secrets store with the rotated token, or a service user with no refresh flow at all.
3. **Fail-closed is shown through submission criteria, not a second identity.** For the fail-closed scenario the presenter leaves the `voice-helpdesk-writers` group for one call and Foundry refuses the Action at submission. Production: a separate, less-privileged identity per integration.
4. **Network ingress allowlist.** zap only accepts API calls from the United States and Canada (country allowlist). The presenter's machine must be on an allowed network or VPN, and the Railway deployment's egress addresses must be allowed. This is the kind of enterprise integration prerequisite that stalls voice deployments in practice.

## Verification

5. **Static shared PIN.** The PIN is a per-user static secret stored as a peppered hash. It is replayable by anyone who learns it. Production: a one-time code by SMS or an identity-provider step, or telephony-level authentication.
6. **Keypad digits reach the language model.** ElevenLabs captures keypad tones without speech, and `redact_input` removes them from the stored transcript, but the digits still pass through the model as a turn and are recorded in the tool-call parameters of the stored conversation. Retention is set short for that reason. Production: collect the PIN in the telephony layer before the call reaches the agent.
7. **Spoken PIN refusal is prompt-only.** If a caller says the PIN aloud the prompt tells the agent to refuse it; the service cannot tell spoken digits from keypad digits.
8. **Caller id is a hint, not proof.** It selects the account to test the PIN against and nothing else. Caller id is spoofable.
9. **Attempt limits live in memory.** Two failures per conversation and six per number in fifteen minutes, both in the service process. A restart clears them. A shared phone number is not handled (the seed has unique numbers).

## Reads and writes

10. **Similar-issue search is keyword overlap**, not semantic search. It finds the seeded resolved issue on the demo script and is designed to find nothing on the new-issue script. Production: vector search over an embedding pipeline.
11. **Creation is at most once per call.** A second, different issue in the same call is refused with an offer of a callback. If the Action applies but the response is lost, the service cannot reconcile it without re-querying, which it deliberately does not do.
12. **The issue identifier is drawn by the service**, because a form-based Foundry Action cannot mint a short numeric id. Seeds use 1000 to 4999, the service 5000 to 9999.
13. **A call dropped after the Action applied but before the read-back** leaves an issue the caller never heard about.

## Escalation and operations

14. **No live human transfer.** Escalation records a context packet in the service log and the agent promises a callback. There is no destination line for this build.
15. **Latency was measured on one model configuration.** Per-turn metrics come from the conversation detail API after the fact (the post-call webhook carries none): median 1.8 s from the caller stopping to first audio, p90 2.9 s, with the LLM accounting for almost all of it and text-to-speech under 0.15 s. The service adds 0.3 to 0.9 s per tool. Only `gemini-2.5-flash` was measured; a second and third model configuration were not run because the free plan's credits were spent (see 23).
16. **Free ElevenLabs plan**: 15 agent minutes per month, which bounds rehearsals.
17. **Recognition accuracy on identifiers**: on the dry run the four-digit issue id was recognised correctly when spoken digit by digit; no wider test was done.
18. **Ontology authoring through the CLI has gaps.** The object types, properties, and links were created with `pltr` (0.29.1 from the local repo). Four things then had to be done in Ontology Manager or Developer Console by hand, each discovered the hard way on 2026-09-10: an object type created through the API has no Object Storage V2 data store, so it reports "syncing" forever until one is added on its Datasources page; properties created through the API are not searchable, so every filter and sort fails with `PropertiesNotSearchable` until the flag is set; the Action type's internal definition format is undocumented and the validator rejects best-effort documents at the wire level, so the Action was built in the wizard; and the Developer Console app's data scope must list every object type, link type, and action type, which must be redone after types are deleted and recreated (the symptom is a 404 on a type that exists). Value types, title keys, and the action log were not set up. Object types made through the API also sit unfiled in the Ontology; filing them into the project's folders is a UI step.
19. **What zap permitted versus what the plan assumed**: no client-credentials grant (assumed available), network ingress allowlist (not assumed), backend-service applications unavailable. Object Storage V2 is available and is what the object types use.
20. **Deploys cost a login.** Railway rebuilds from `railway up` (push events from GitHub never reached it), and every deploy or variable change restarts the container, which drops the memory-only refresh token; the presenter logs in again from `/auth/start`. Opening the OAuth callback from browser history after a restart fails with a state mismatch by design; the login must start from `/auth/start`.
21. **AE7 (fail-closed) is not demonstrated.** The Action has no submission criterion yet, so there is no path that Foundry refuses; the fail-closed story is told from the design, not shown. Adding the `voice-helpdesk-writers` criterion and repeating the call is a ten-minute follow-up.
22. **The ElevenLabs post-call webhook and workspace settings need a human.** The CLI's OAuth token lacks `webhooks_write`, so the webhook was created in the ElevenLabs UI and its secret pasted into Railway from a terminal.
23. **The ElevenLabs test suite is not free.** Running the 21 attached tests twice on the free plan exhausted the monthly 10,000-credit quota (`quota_exceeded`) and the simulation tests then reported "insufficient credits". First run: 17 of 21 passed; the three parameter-asserting tool-call tests fail with "Parameter path not found" even though the recorded call carries the field (path form undocumented), and one timeout test showed the agent escalating after a single failed create rather than retrying (prompt rule firmed up, not re-verified). Check the usage page before the demo; the phone calls draw from the same plan.

