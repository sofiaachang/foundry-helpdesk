# LinkedIn post draft

Two versions. Numbers come from the 2026-09-10 dry run (`run-sheet.md`). No phone numbers, ids, or stack names beyond the products. Swap the bracketed line for the repo or video link when ready.

## Version A (about 240 words)

I built a voice help desk agent that talks to a Palantir Foundry ontology, and the interesting part was not the voice.

The business case is simple. Most help desk calls are the same three questions: what is the status of my ticket, has anyone seen this before, and can you log this. An agent that answers the first two and deflects to a known fix before it ever creates a ticket takes minutes off every call and keeps duplicates out of the queue. The hard part is making the third one safe enough that security review says yes.

So: call a phone number. The agent looks up the account behind your caller id and asks for that account's four-digit PIN on the keypad, never spoken. The PIN belongs to the person, not the line, so the right digits from the wrong phone get you nothing, and the secret never enters a transcript. Once verified, you can ask ticket status, who is working it and what else that team has open, and whether your problem was already solved. Describe something new and it confirms title, description, and priority back to you, creates the issue through a Foundry Action, and reads the id back one digit at a time. The row lands in Workshop with the conversation id attached.

What I learned: reads are easy, and the write is where enterprise voice deployments stall. The agent never holds a Foundry credential; a small integration service does, and the only write path is a governed Action, so every ticket carries who, when, and with what parameters. Latency lives in the model, not the audio: median 1.8 s from the caller finishing to first audio, and text-to-speech was 0.11 s of that. And the limitations list is 24 items long; I am prouder of it than the happy path.

Stack: ElevenLabs Agents, Twilio, a TypeScript service on Railway, Palantir Foundry.

[repo or demo video link]

## Version B (about 240 words)

I built a phone help desk agent on ElevenLabs that reads from and writes to a Palantir Foundry ontology.

Most help desk calls come down to three questions: what is the status of my ticket, has anyone seen this before, and can you log this one. The agent handles all three in a single call, and only creates something if the first two did not already solve the problem.

The user dials in, the agent greets them and asks for their four-digit PIN on the keypad. The PIN is tied to the phone number on their account, so the agent only accepts it from that number; someone with the right PIN and the wrong phone gets nowhere. Once verified, the user can ask about a ticket by number, hear who is working it and what else that team has open, or describe a problem and be read the fix if it has been solved before. If it has not, the agent confirms the title, description, and priority back to them, creates the issue, and reads the new id back one digit at a time.

On the other side, an administrator works out of a Workshop app where new tickets appear as they are created, with the conversation that produced each one. High-priority tickets also send them an email the moment the Action fires; everything else waits for their next look at the queue.

Under the hood: an ElevenLabs agent on a Twilio number calls webhook tools on a small TypeScript service (Fastify, on Railway). That service holds the only Foundry credential, enforces verification and rate limits, and talks to Foundry over the Ontology API. Using a Foundry Action, every ticket inherits permissions, parameter validation, and an audit trail of who, when, and with what. New rows land in a Workshop app with the conversation id attached.

Median 1.8 s to first audio; the model is 90% of that.

Twenty-four documented limitations. Demo video soon.

[repo or demo video link]

## Notes for posting

- **Before posting:** the high-priority email in version B is not live until the notification rule exists on the Action (Ontology Manager → `create-help-desk-issue` → Notifications, condition `priority` equals `high`) and one test call has delivered it. Do not post the paragraph before that.

- Version A works as the caption for the demo video; version B works alone or as a comment thread opener.
- If the repo link goes in, the README's gate table and `docs/demo/limitations.md` are the two pages a reader will open first; both are current.
- Tag ElevenLabs and Palantir only if you want the reach; the post stands without it.

