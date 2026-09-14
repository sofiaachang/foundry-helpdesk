# LinkedIn post draft

Two versions. Numbers come from the 2026-09-10 dry run (`run-sheet.md`). No phone numbers, ids, or stack names beyond the products. Swap the bracketed line for the repo or video link when ready.

## Version A (about 240 words)

I built a voice help desk agent that talks to a Palantir Foundry ontology, and the interesting part was not the voice.

The business case is simple. Most help desk calls are the same three questions: what is the status of my ticket, has anyone seen this before, and can you log this. An agent that answers the first two and deflects to a known fix before it ever creates a ticket takes minutes off every call and keeps duplicates out of the queue. The hard part is making the third one safe enough that security review says yes.

So: call a phone number. The agent looks up the account behind your caller id and asks for that account's four-digit PIN on the keypad, never spoken. The PIN belongs to the person, not the line, so the right digits from the wrong phone get you nothing, and the secret never enters a transcript. Once verified, you can ask ticket status, who is working it and what else that team has open, and whether your problem was already solved. Describe something new and it confirms title, description, and priority back to you, creates the issue through a Foundry Action, and reads the id back one digit at a time. The row lands in Workshop with the conversation id attached.

What I learned: reads are easy, and the write is where enterprise voice deployments stall. The agent never holds a Foundry credential; a small integration service does, and the only write path is a governed Action, so every ticket carries who, when, and with what parameters. Latency lives in the model, not the audio: median 1.8 s from the caller finishing to first audio, and text-to-speech was 0.11 s of that. And the limitations list is 24 items long; I am prouder of it than the happy path.

Stack: ElevenLabs Agents, Twilio, a TypeScript service on Railway, Palantir Foundry.

[repo or demo video link]

## Version B (about 260 words, Story Post structure)

I built a phone line that can open tickets in Palantir Foundry. The hard part was not the voice.

Every help desk hears the same three questions. Where is my ticket? Has anyone fixed this before? Can you log this? I wanted a voice agent that answers all three in one call and only opens a ticket when the first two did not already solve the problem.

Here is what a call looks like.

You dial in and the agent asks for your four-digit PIN on the keypad. That PIN belongs to the phone number on your account, so it only works from your phone. Someone with your PIN and a different number gets nowhere. And because you key it in instead of saying it, it never lands in a transcript.

Once you are through, you can ask about a ticket by number, hear who is working on it and what else that team has open, or describe a problem and get the known fix read back to you. If nothing matches, the agent repeats the title, description, and priority, creates the ticket, and reads the new id back one digit at a time.

On the other side, an administrator watches new tickets arrive in a Workshop app, each one carrying the conversation that created it. High-priority tickets also send an email the moment they are created. Everything else waits for the next look at the queue.

Under the hood: an ElevenLabs agent on a Twilio number calls a small TypeScript service on Railway. That service holds the only Foundry credential, enforces verification and rate limits, and reads the ontology through its API. The one write is a Foundry Action, so every ticket arrives with permissions checked, parameters validated, and a record of who created it, when, and with what.

First audio in 1.8 seconds, median. The model is nearly all of it.

Twenty-four documented limitations. Demo video soon.

This started as curiosity about whether ElevenLabs and Foundry would fit together. They do, and the fit is better than I expected: ElevenLabs makes the conversation feel effortless, and Foundry makes the outcome trustworthy. Neither can do the other's job, and a help desk needs both.

#VoiceAI #Palantir #ElevenLabs

[repo or demo video link in the first comment]

## Notes for posting

- **Before posting:** the high-priority email in version B is not live until the notification rule exists on the Action (Ontology Manager → `create-help-desk-issue` → Notifications, condition `priority` equals `high`) and one test call has delivered it. Do not post the paragraph before that.

- Version A works as the caption for the demo video; version B works alone or as a comment thread opener.
- If the repo link goes in, the README's gate table and `docs/demo/limitations.md` are the two pages a reader will open first; both are current.
- Per the social skill: hook in the first line (it is all that shows before "see more"), link in the first comment rather than the body, 3 to 5 hashtags at the end. Closes with a takeaway rather than a question, by choice. Tag ElevenLabs and Palantir only if you want the reach.

