# LinkedIn post draft

Two versions. Numbers come from the 2026-09-10 dry run (`run-sheet.md`). No phone numbers, ids, or stack names beyond the products. Swap the bracketed line for the repo or video link when ready.

## Version A (about 240 words)

I built a voice help desk agent that talks to a Palantir Foundry ontology, and the interesting part was not the voice.

The business case is simple. Most help desk calls are the same three questions: what is the status of my ticket, has anyone seen this before, and can you log this. An agent that answers the first two and deflects to a known fix before it ever creates a ticket takes minutes off every call and keeps duplicates out of the queue. The hard part is making the third one safe enough that security review says yes.

So: call a phone number. The agent looks up the account behind your caller id and asks for that account's four-digit PIN on the keypad, never spoken. The PIN belongs to the person, not the line, so the right digits from the wrong phone get you nothing, and the secret never enters a transcript. Once verified, you can ask ticket status, who is working it and what else that team has open, and whether your problem was already solved. Describe something new and it confirms title, description, and priority back to you, creates the issue through a Foundry Action, and reads the id back one digit at a time. The row lands in Workshop with the conversation id attached.

What I learned: reads are easy, and the write is where enterprise voice deployments stall. The agent never holds a Foundry credential; a small integration service does, and the only write path is a governed Action, so every ticket carries who, when, and with what parameters. Latency lives in the model, not the audio: median 1.8 s from the caller finishing to first audio, and text-to-speech was 0.11 s of that. And the limitations list is 24 items long; I am prouder of it than the happy path.

Stack: ElevenLabs Agents, Twilio, a TypeScript service on Railway, Palantir Foundry.

[repo or demo video link]

## Version B (about 90 words)

Built a phone help desk agent on ElevenLabs that reads and writes to a Palantir Foundry ontology.

Keypad PIN, never spoken. Ticket status, team queue, and known fixes by voice. New issues created through a governed Foundry Action with the conversation id on the row.

Median 1.8 s to first audio; the model is 90% of that.

The hard part was never the voice. It was the write path: who is allowed to create the ticket, and how you prove it afterwards.

Twenty-four documented limitations. Demo video soon.

[repo or demo video link]

## Notes for posting

- Version A works as the caption for the demo video; version B works alone or as a comment thread opener.
- If the repo link goes in, the README's gate table and `docs/demo/limitations.md` are the two pages a reader will open first; both are current.
- Tag ElevenLabs and Palantir only if you want the reach; the post stands without it.
