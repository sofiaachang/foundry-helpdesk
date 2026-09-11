# Voice Help Desk on Palantir Foundry

A demonstration: an engineer phones an ElevenLabs voice agent, verifies with a keypad PIN, asks about existing help desk issues, and describes a new one. The only write path is a Foundry Action applied by a small integration service that holds the only Foundry credential. The administrator watches issues appear in a Workshop table with an inspectable Action log.

Plan: `docs/plans/2026-09-09-001-feat-voice-helpdesk-foundry-plan.md`. Brief: `voice-helpdesk-foundry-brief.md`. Contract between agent and service: `docs/contract/integration-contract.md`.

## Layout

| Path | What |
|---|---|
| `service/` | TypeScript Fastify service: shared-secret gate, verification, tier gate, tool routes, post-call webhook, latency report. `pnpm check` runs lint, types, tests, and the disclosure guard. |
| `ontology/` | Synthetic seed generator and CSVs, Ontology Manager click path, Action spec. |
| `agent/` | ElevenLabs agent as code: prompt, eight webhook tools, two configurations, simulation tests. |
| `scripts/check-no-disclosure.sh` | Structural guard: no route can reach Foundry without a gated session. |
| `docs/` | Plan, contract, demo run sheet and limitations (written after the dry run). |

## Run locally (no Foundry, no ElevenLabs)

```bash
cd service && pnpm install
cp .env.example .env   # fill HELPDESK_SHARED_SECRET (24+ chars), ELEVENLABS_WEBHOOK_SECRET, PIN_PEPPER=example-pepper-do-not-use
FOUNDRY_ADAPTER=fake SEED_DIR=../ontology/seed pnpm dev
curl -s -X POST localhost:3000/tools/verify_caller -H 'content-type: application/json' \
  -H "x-helpdesk-secret: $HELPDESK_SHARED_SECRET" \
  -d '{"conversation_id":"conv_local_0001","caller_id":"+15550100000","digits":"4321"}'
```

The fake adapter serves the committed seed (demo caller `u-demo`, PIN `4321`, issue `4127`). It is refused when `NODE_ENV=production`, as is `not-ready` unless `FOUNDRY_ALLOW_NOT_READY=1`. `GET /health` reports `{ok, adapter, auth}` where `auth` is the delegated-login status.

## What only a human can do (the gates)

Execution stops at each of these. Nothing is stubbed past them.

| Gate | Do this | Unblocks |
|---|---|---|
| G1 | Done 2026-09-09: project `voice-helpdesk` exists; zap has no client-credentials grant, so the app is a client-facing public client with user permissions (plan KTD3). Create it in Developer Console with redirect URL `http://localhost:3000/auth/callback`, generate the SDK for Raava Ontology, and record the client id, app RID, and scope strings in `ontology/README.md`. Create the group `voice-helpdesk-writers` with yourself in it. | U1, U3 upload |
| G3 | No client secret exists for a public client. Instead, log in once through the service (`/auth/start`) after deploy; the refresh token lives in the service's memory. Re-authorise after any restart. | U1 probe, U8 |
| G2 | Signed 2026-09-10 (`docs/contract/integration-contract.md`). | U4, U9 final, U10 |
| G4a | Done 2026-09-09: ElevenLabs workspace on the free plan (15 agent minutes a month; Starter if rehearsals exhaust it). Still to do at U10 push: create the workspace secret `helpdesk_shared_secret`. | U14, U15 secret |
| G5 | Done 2026-09-09: a Twilio trial number is imported into ElevenLabs and attached to an existing agent. Decision: create the new agent `helpdesk-phone` from `agent/` and move the number to it at U11; leave the existing agent untouched. | U14, U11 |
| G4b | After the keypad spike, decide conversation and audio retention (recommendation in plan KTD14). | U10 push |
| G6 | Cleared 2026-09-10. Railway project `voice-helpdesk`, service `helpdesk-service`, region sfo, URL `https://helpdesk-service-production-9c2e.up.railway.app` (`/health` returns `{ok, adapter: foundry, auth}`). Env vars set from `service/.env.example`; secrets were set through stdin and never printed. Deploys run with `railway up --service helpdesk-service --ci` from the repo root (the GitHub source is connected but push events do not reach Railway; see CLAUDE.md). Ingress allowlist: United States and Canada, so a US-region deploy passes. | U10 tool URLs |
| G7 | Dry run done 2026-09-10: AE2 to AE6 passed on live phone calls (issue `8006` created through the Action); AE7 to AE9 not run (see `docs/demo/run-sheet.md`). Every tool also exercised from the shell against the live service. | U13 evidence |

## Conventions

- Every `pltr` command targets the zap profile: `pltr <command> --profile zap`.
- Secrets never enter the repo. `.env` is gitignored; `.env.example` lists names only.
- The seed CSVs are committed with a placeholder phone number and the example pepper. Real values are generated locally into `ontology/seed/local/`.
- Tests are the proof. `cd service && pnpm check` must pass before a commit.
