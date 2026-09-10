# Limitations and shortcuts (say these out loud)

Plan U13. Every shortcut the demo takes, with the production alternative named. Items marked "pending" are filled after the dry run (G7).

## Identity and permissions

1. **No service identity.** The zap enrollment plan has no client-credentials grant, so the integration service cannot act as a generated service user. It acts as a delegated user (the presenter) through a public OAuth client with PKCE and a refresh token. The Action log therefore shows the presenter as the submitter, via the application. Production: a confidential client with its own service user, granted only the four object types and the Action.
2. **The token lives in the service's memory.** Foundry rotates the refresh token on each use and invalidates it after 30 days idle; Railway's disk is ephemeral. A restart means one re-login click before the next call. Production: a secrets store with the rotated token, or a service user with no refresh flow at all.
3. **Fail-closed is shown through submission criteria, not a second identity.** For the fail-closed scenario the presenter leaves the `voice-helpdesk-writers` group for one call and Foundry refuses the Action at submission. Production: a separate, less-privileged identity per integration.
4. **Network ingress allowlist.** zap only accepts API calls from allowed countries or IP ranges. The presenter's machine must be on an allowed network or VPN, and the Railway deployment's egress addresses must be allowed. This is the kind of enterprise integration prerequisite that stalls voice deployments in practice.

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
15. **Latency is time to first sentence**, the metric the post-call webhook exposes; true time to first audio adds text-to-speech latency the webhook does not report. Pending: measured values from the dry run.
16. **Free ElevenLabs plan**: 15 agent minutes per month, which bounds rehearsals.
17. **Recognition accuracy on identifiers**: pending from the keypad spike.
18. **What zap permitted versus what the plan assumed**: no client-credentials grant (assumed available), network ingress allowlist (not assumed), backend-service applications unavailable. Object Storage v2 availability: pending from U3.
