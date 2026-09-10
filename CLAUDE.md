# CLAUDE.md

Repo conventions for the voice help desk on Foundry. The plan at `docs/plans/2026-09-09-001-feat-voice-helpdesk-foundry-plan.md` is the decision artifact; the contract at `docs/contract/integration-contract.md` is authoritative for tool shapes.

## Concepts

- **Tier gate.** `service/src/lib/tiers.ts` is the only code that mints a `VerifiedSession`. Every Foundry adapter method takes one as its first argument. Routes never import `src/foundry/*`; only `src/server.ts` (the composition root) and `src/foundry/*` may. `scripts/check-no-disclosure.sh` enforces this and runs in `pnpm check`.
- **Session vs lockout.** A session is keyed by the ElevenLabs conversation id (two PIN failures lock it). A lockout is keyed by the normalised caller id (six failures in fifteen minutes). Both are in memory and clear on restart. That is a stated demo limitation.
- **PIN hash.** Hex HMAC-SHA256, key `PIN_PEPPER`, message `${userId}:${pin}`. The seed generator and the verifier share this definition; the committed CSVs use `example-pepper-do-not-use`.
- **Envelope.** Every tool returns `{status, speech, escalate, data}`. `speech` is what the agent says. Nothing from Foundry (errors, bodies, hashes) reaches the agent.
- **Escalation** is a recorded callback request, not a live transfer. The service logs the packet; the agent promises a callback and ends the call.
- **Issue ids** are four digits. Seeds use 1000 to 4999; the service draws 5000 to 9999 and passes the id to the Action, because a form-based Action cannot mint short ids.

## Idioms

- Pure logic in `service/src/lib/` with injected clocks and lookups; no Fastify or OSDK imports there.
- Tests under `__tests__/` beside the code (vitest). Ontology seed tests use `node --test`.
- Node 26 runs TypeScript natively for scripts (`node service/scripts/latency-report.ts`, `node ontology/seed/generate-seed.ts`).
- Logging is an allowlist. Never log request bodies, digits, secrets, or Foundry responses.

## Gotchas

- `pltr` must run with `-p zap`; the default profile points at an unrelated tenant.
- The harness may believe this folder is not a git repo if the session started before `git init`; worktree isolation for subagents then fails. Run workers in the shared directory and commit from the orchestrator.
- pnpm 11 approves build scripts in `service/pnpm-workspace.yaml` (`allowBuilds`), not in `package.json`.
- Human gates G1 to G7 are hard stops. Do not stub a credential, a phone number, or a Foundry object to get past one.
