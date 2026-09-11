# LinkedIn post draft

Two versions. Numbers come from the 2026-09-10 dry run (`run-sheet.md`). No phone numbers, ids, or stack names beyond the products. Swap the bracketed line for the repo or video link when ready.

## Version A (about 230 words)

I built a voice help desk agent that talks to a Palantir Foundry ontology, and the interesting part was not the voice.

Call a phone number. The agent asks for a four-digit PIN on the keypad, never spoken, so the secret never enters a transcript. Once verified, it can tell you the status of a ticket, who is working it and what else that team has open, and whether a problem like yours was already solved. Describe something new and it confirms the title, description, and priority back to you, then creates the issue through a Foundry Action, and reads the new id back one digit at a time. The row appears in Workshop with the conversation id attached.

What I learned building it:

Reads are easy. The write is where enterprise voice deployments stall. The agent never holds a Foundry credential; a small integration service does, and the only write path is a governed Action, so every ticket carries who, when, and with what parameters.

Latency lives in the model, not the audio. Median 1.8 s from the caller finishing to the agent's first audio; text-to-speech was 0.11 s of that. Pre-tool speech ("creating that now") is what makes an 800 ms write feel fine.

Every environment fights back. Ingress allowlists, OAuth grants that the plan assumed and the tenant did not have, object types that index nothing until a data store exists. The limitations list is 24 items long and I am prouder of it than the happy path.

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
