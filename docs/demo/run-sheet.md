# Demo run sheet

Plan U13. Follow top to bottom. Items marked "pending" are filled after the dry run (G7).

## Pre-flight (15 minutes before)

1. Laptop on a US or Canadian network, VPN off (zap allows US and Canada only): `~/.local/bin/pltr admin user current --profile zap` prints your user.
2. Railway service up: `curl -s https://helpdesk-service-production-9c2e.up.railway.app/health` returns `{"ok":true,"adapter":"foundry","auth":"ok"}`. If `adapter` is `not-ready`, the deploy predates U3; if `auth` is `logged_out` (after a restart or 30 idle days), open `https://helpdesk-service-production-9c2e.up.railway.app/auth/start?t=<FOUNDRY_LOGIN_TOKEN>` in a browser, sign in, and re-check.
3. Workshop module open on the Issues table, sorted newest first, with the Action log panel visible.
4. Demo phone charged, caller id not withheld, keypad tones enabled.
5. `voice-helpdesk-writers` group page open in another tab (for the fail-closed scenario).
6. Do not rehearse the two-wrong-PIN scenario more than twice in fifteen minutes on the demo number; the per-number lockout would trip. A Railway restart clears it, then repeat step 2.
7. Shared secret rotation, only if needed: set `HELPDESK_SHARED_SECRET=new,old` on Railway, update the ElevenLabs workspace secret, then drop the old value.

## Secrets at deploy time

- `PIN_PEPPER`: the value in `ontology/seed/local/PIN_PEPPER` (local, gitignored). The uploaded users dataset was hashed with it on 2026-09-10; changing it means regenerating and re-uploading the seed.
- `HELPDESK_SHARED_SECRET`: generate once (`openssl rand -hex 24`), set on Railway and as the ElevenLabs workspace secret `helpdesk_shared_secret`.
- `FOUNDRY_LOGIN_TOKEN`: generate once (`openssl rand -hex 24`), set on Railway; used only in the `/auth/start?t=` link.
- `ELEVENLABS_WEBHOOK_SECRET`: from the post-call webhook settings in ElevenLabs.

## Call script

| Step | You say or do | Expected agent line (paraphrase) | Evidence |
|---|---|---|---|
| 1 | Dial the number | Greeting, asks for the four-digit PIN by keypad | AE1 if you ask for issues first: it declines |
| 2 | Enter a wrong PIN, then pound | "That PIN didn't match. Please try once more" | AE2 first half |
| 3 | Enter the correct PIN, pound | "Thanks, you're verified." | verify ok |
| 4 | "What's the status of issue four one two seven?" | Status, team, digits read one by one | AE3 |
| 5 | "Who's working on it and what else do they have open?" | Team name, count, top three | AE4 |
| 6 | "My VPN client keeps disconnecting on the office wifi" | Reads the known resolution, asks whether it fixes it. Say yes. | AE5, no issue created |
| 7 | "The label printer on the loading dock prints blank pages after the firmware update" | "I couldn't find a similar issue"; confirms title, description, priority; you say yes | AE6 |
| 8 | Agent reads back the new id digit by digit; hang up | Issue appears at the top of the Workshop table; open the Action log entry | AE6, R14 |
| 9 | Second call, before it: remove yourself from `voice-helpdesk-writers` | Create fails, agent offers a callback, never claims success; restore membership after | AE7 |
| 10 | Optional: set `SLOW_TOOLS_MS=3000` on Railway for one call | Agent covers the wait with speech | AE8 |
| 11 | Interrupt the agent mid-list | It stops and answers | AE9 |

## Where to look

- Workshop: Issues table (newest first) and the Action log timeline for the selected issue: submitter, time, parameters.
- Railway logs: filter `tool_call` for per-tool timings, `escalation` for callback packets, `postcall_turn` for per-turn metrics.
- Latency report after the session: export the Railway log to a file and run `node service/scripts/latency-report.ts <file>`.

## Recovery moves

| Symptom | Move |
|---|---|
| Agent says the system is unavailable | Check `/health`; if Railway restarted, redo pre-flight step 3 |
| Verify keeps failing with the right PIN | Lockout tripped by rehearsals; restart the Railway service, redo step 3 |
| Notification did not arrive | Open the Action log entry directly from the issue in Workshop |
| Foundry calls fail with "request blocked" | Railway egress not on the ingress allowlist; see the G6 note in the README |

## Evidence table

Dry run 2026-09-10 (four phone calls from the demo caller's mobile to the Twilio number, plus a shell run of every tool against the live service).

| AE | Conversation id | Outcome | Evidence |
|---|---|---|---|
| AE1 | shell run | Read tools before verification return `not_verified` with the fixed PIN sentence | Railway `tool_call` lines, `status="not_verified"` |
| AE2 | call 4 | Wrong PIN twice: retry sentence, then locked sentence and callback offer; caller declined; goodbye | `verify_caller` `not_verified` 606 ms, then `locked` 320 ms |
| AE3 | `conv_9001m2799s4mek59171896bp2hfx` | Issue 4127: open, Platform Engineering, digits read one by one | `get_issue_status` 677 ms |
| AE4 | same call | Team name, three other open issues listed | `get_team_queue_for_issue` 889 ms |
| AE5 | same call | VPN resolution read back, caller said yes, nothing created | `find_similar_issues` 315 ms |
| AE6 | `conv_8001m279h2e0ffybyb6hy7a952nx` | No match; three fields confirmed; issue `8066` created and read back digit by digit | `find_similar_issues` `not_found` 397 ms, `create_issue` `ok` 829 ms; object `8066` in Foundry |
| AE7 | not run | Skipped by decision on 2026-09-10 (no submission criterion on the Action yet) | Limitation 3 |
| AE8 | not run | `SLOW_TOOLS_MS` rehearsal not done | |
| AE9 | not run | Interruption not rehearsed | |

Post-call webhook: received and signature-verified for every call (`postcall_summary` with the full turn count). The webhook payload carried no time-to-first-byte or first-sentence fields, so the latency report has only the service-side tool timings above.

Call 1 defect, fixed the same evening: the agent said goodbye right after the caller accepted a known resolution instead of asking for anything else (prompt step 3).

Gate sign-offs: G1 2026-09-09 (no service identity; delegated user), G2 2026-09-10 (contract signed), G3 not applicable (public client), G4a 2026-09-09, G4b pending, G5 2026-09-09, G6 2026-09-10, G7 2026-09-10 (AE2 to AE6 live; AE7 to AE9 not run).
