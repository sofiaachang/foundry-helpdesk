# ElevenLabs agent as code (U10)

Everything under `agent/` is the `@elevenlabs/cli` (v1.2.0) agents-as-code project for the voice help desk. Nothing here has been pushed: the ElevenLabs workspace does not exist until gate G4, and the service URL does not exist until G6.

Authority: `docs/contract/integration-contract.md` for tool names, fields, envelope and fixed speech; the plan's U10 section and KTD7, KTD11, KTD12, KTD14, KTD16, KTD17 for mechanism.

## Files

| Path | What it is | Hand-edit? |
|---|---|---|
| `render.ts` | Single source of truth: the eight tool definitions, the two agent variants, the 21 tests, and the registry merge. Dependency-free; run with `node render.ts` (Node 26 strips types natively). | Yes |
| `prompts/system.md` | The system prompt (Personality, Environment, Tone, Goal, Guardrails, Tools per the ElevenLabs prompting guide). Inlined into both agent configs by `render.ts`. | Yes |
| `agents.json`, `tools.json`, `tests.json` | CLI registries. `render.ts` writes `name` and `config`; the CLI writes `id` (and branch data) on push. Rendering preserves ids. | No (CLI and render.ts own them) |
| `agent_configs/helpdesk-phone.json` | Phone agent: mu-law 8 kHz audio, `system__caller_id` from the call, no auth. | No (rendered) |
| `agent_configs/helpdesk-browser-test.json` | Widget test agent: 16 kHz PCM, `system__caller_id` defaulted to the test caller id, `enable_auth: true` so it can never be a public widget. Archive it after U10 (see below). | No (rendered) |
| `tool_configs/<tool>.json` | One webhook tool per contract tool, in the `tool_config` wire shape. | No (rendered) |
| `test_configs/<test>.json` | One test per file, in the Create test API shape (`type` `llm`, `tool`, or `simulation`). | No (rendered) |
| `.env.example` | The environment variables `render.ts` and the CLI read. Copy to `.env`; `.env` is git-ignored. | Yes |

Real phone numbers, API keys, the shared secret value, and the Railway URL are never committed. They come from `.env` or the shell at push time.

## What the tools look like

Each tool is `POST {HELPDESK_BASE_URL}/tools/<name>`, `Content-Type: application/json`, header `X-Helpdesk-Secret` sourced from the workspace secret (`request_headers: {"X-Helpdesk-Secret": {"secret_id": "wsec_..."}}`), `response_timeout_secs: 10`, `pre_tool_speech: "auto"` (`"force"` on `create_issue`), `tool_error_handling_mode: "hide"` (the model sees only that the call failed, never a raw error), and a body whose `conversation_id` and `caller_id` are bound with `dynamic_variable: "system__conversation_id"` / `"system__caller_id"`. The schema marks `dynamic_variable` as mutually exclusive with `description`, so the model cannot fill those two fields. Tool-specific parameters carry the contract's descriptions and ranges; `priority` uses `enum: ["low","normal","high"]`.

## What the agents look like

Both agents are rendered from `agentConfig(variant)` in `render.ts`:

- `conversation_config.conversation.dtmf_input_settings`: `{dtmf_input_timeout: 2, hash_terminator: true, redact_input: true}` (KTD7; timeout retuned in U11/U14 by editing `render.ts`).
- `conversation_config.conversation.max_duration_seconds: 600`.
- `conversation_config.agent.prompt.built_in_tools`: only `end_call` is set; `transfer_to_number` and `transfer_to_agent` are `null` (KTD12: no live transfer).
- `conversation_config.agent.first_message`: "Help desk." plus the contract's `not_verified` sentence verbatim.
- `platform_settings.privacy`: `retention_days` 14 (KTD14 recommendation; the human decides at G4b, then set `HELPDESK_RETENTION_DAYS` and re-render), `record_voice: true`, `zero_retention_mode: false`.
- `platform_settings.testing.attached_tests`: all 21 tests, on both agents.
- Browser-test only: `dynamic_variable_placeholders: {"system__caller_id": "+15550100000"}` and `platform_settings.auth.enable_auth: true`.

## Tests

| File | Type | Covers |
|---|---|---|
| `ae1-unverified-no-tier1-tool` | tool, `verify_absence` on `list_my_open_issues` | AE1 |
| `ae1-unverified-reply-asks-for-pin` | llm | AE1 |
| `ae2-two-failures-then-escalate` | simulation; `verify_caller` mocked retry (digits 1111) then locked; `escalate` mocked | AE2 |
| `ae2-locked-offers-callback-no-third-ask` | llm | AE2 |
| `ae2-locked-no-third-verify-call` | tool, `verify_absence` on `verify_caller` | AE2 |
| `ae2-callback-accepted-calls-escalate` | tool, `reason` evaluated by LLM (no digits) | AE2 |
| `ae2-after-escalate-calls-end-call` | tool, referenced `end_call` (system) | AE2 |
| `ae3-status-spoken-with-status-and-team` | llm | AE3 |
| `ae5-similar-resolution-yes-no-create` | simulation; `find_similar_issues` mocked with a match | AE5 |
| `ae5-similar-resolution-no-proceeds-to-confirmation` | llm | AE5 "no" path |
| `spoken-pin-no-verify-call` | tool, `verify_absence` on `verify_caller` | KTD17 |
| `spoken-pin-asks-for-keypad` | llm | KTD17 |
| `ae6-confirms-three-fields-then-creates-and-reads-id` | simulation; similar mocked null, create mocked `6203` | AE6 |
| `ae6-no-create-before-explicit-yes` | tool, `verify_absence` on `create_issue` after a change request | AE6 |
| `ae6-create-after-yes-with-three-fields` | tool; title/description by LLM, priority exact | AE6 |
| `ae6-reads-new-id-digit-by-digit` | llm | AE6, KTD16 |
| `ae7-create-failed-no-success-wording` | llm; create result `status: failed` | AE7 |
| `read-timeout-says-unavailable-offers-callback` | llm; `get_issue_status` result `is_error: true` | KTD12 |
| `create-timeout-retries-once` | tool; after one errored create, expects a second `create_issue` call | KTD12 |
| `create-timeout-twice-then-offers-callback` | simulation; `create_issue` mocked `is_error: true` | KTD12 |
| `verified-reply-never-repeats-digits` | llm | KTD7 |

Keypad turns in unit-test histories are user turns with `source_medium: "dtmf"` and a digit-only `message`. Simulations run with `tool_mock_config.mocking_strategy: "all"` and `fallback_strategy: "raise_error"`, so no test ever reaches the real service; per-tool responses come from `tool_mock_overrides` keyed by tool id.

## Commands once G4 (workspace) and G6 (service URL) clear

Run everything inside `agent/`. The CLI is `npx -y @elevenlabs/cli@latest ...` or, installed, `elevenlabs ...`.

```bash
cd agent
cp .env.example .env            # fill ELEVENLABS_API_KEY (or use `elevenlabs auth login`)
elevenlabs auth login           # OAuth flow; `elevenlabs auth status` to check

# 1. Create the workspace secret and record its id (value comes from the service's deploy env, never from a file here)
elevenlabs agents secrets create --type new --name helpdesk_shared_secret --value "$HELPDESK_SHARED_SECRET"
#    -> response has "secret_id": "wsec_...". Put it in .env as HELPDESK_SECRET_ID.
#    Put the Railway URL (G6) in .env as HELPDESK_BASE_URL.

# 2. Render, push tools (this writes tool ids into tools.json)
node render.ts && elevenlabs tools push

# 3. Render again (tool ids now flow into tests and agents), push tests (writes test ids)
node render.ts && elevenlabs tests push

# 4. Render again (test ids into attached_tests), push agents (creates them; writes agent ids)
node render.ts && elevenlabs agents push --version-description "U10 initial"
elevenlabs agents status

# 5. Run the attached tests, browser agent first, then phone
elevenlabs agents test helpdesk-browser-test
elevenlabs agents test helpdesk-phone

# 6. Verify a clean round-trip: pull and diff must be empty
elevenlabs agents pull --update --dry-run
```

`agents push` creates an agent when its registry entry has no `id` and updates it when it does; `tools push` and `tests push` behave the same. `tests push` also auto-registers untracked configs that contain `chat_history` or `success_condition`; the simulation tests use `success_conditions` (plural) so they are registered explicitly in `tests.json` by `render.ts`.

After U10 runs, retire the browser-test agent: set `archived: true` for the browser variant in `render.ts` (or delete it with `elevenlabs agents delete --agent-id <id>` and remove its registry entry), re-render, push.

## Placeholders to fill

| Placeholder | Where | Source |
|---|---|---|
| `https://REPLACE-AT-G6.example.invalid` | every `tool_configs/*.json` `api_schema.url` | `HELPDESK_BASE_URL` in `.env` (Railway URL, G6) |
| `wsec_REPLACE_WITH_ID_OF_helpdesk_shared_secret` | every tool's `request_headers.X-Helpdesk-Secret.secret_id` | `HELPDESK_SECRET_ID` from step 1 |
| `TOOL_ID_NOT_PUSHED_YET:<name>` | agent `tool_ids`, test `referenced_tool.id`, `mocked_tool_ids`, `tool_mock_overrides` keys | written into `tools.json` by `tools push`, then re-render |
| `TEST_ID_NOT_PUSHED_YET:<name>` | agent `attached_tests` | written into `tests.json` by `tests push`, then re-render |
| `+15550100000` | browser-test agent placeholder, simulation `dynamic_variables` | `HELPDESK_TEST_CALLER_ID`; must be the demo caller's phone in the U3 seed or verification always fails |
| `14` | `platform_settings.privacy.retention_days` | `HELPDESK_RETENTION_DAYS`, decided at G4b |

The phone number itself is not in any config here; U11 assigns the imported Twilio number to `helpdesk-phone` through the phone-numbers API.

## Verified versus assumed

Verified against the CLI's embedded OpenAPI spec (`elevenlabs agents --spec`, v1.2.0), `elevenlabs agents init`, `elevenlabs agents templates show default`, and the docs:

- Layout `agents.json`, `tools.json`, `tests.json`, `agent_configs/`, `tool_configs/`, `test_configs/` and the `init`/`add`/`push`/`pull`/`test`/`auth login` commands: https://github.com/elevenlabs/cli (README) and `--help` output.
- Webhook tool fields (`response_timeout_secs` 5 to 300, `pre_tool_speech` `auto|force|off`, `request_headers` with `{secret_id}`, `request_body_schema.properties.*.dynamic_variable` mutually exclusive with `description`, `enum`): https://elevenlabs.io/docs/api-reference/tools/create and the spec's `WebhookToolConfig`, `LiteralJsonSchemaProperty`, `ConvAISecretLocator`.
- `conversation_config.conversation.dtmf_input_settings` `{dtmf_input_timeout, hash_terminator, redact_input}` and the note that digits passed to tools are not redacted: https://elevenlabs.io/docs/changelog/2026/8/31 and the spec's `DTMFInputConfig`.
- `system__conversation_id`, `system__caller_id`, `dynamic_variable_placeholders`: https://elevenlabs.io/docs/agents-platform/customization/personalization/dynamic-variables.
- `built_in_tools.end_call` shape `{type:"system", name:"end_call", description:"", params:{system_tool_type:"end_call"}}`: https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/end-call.
- `max_duration_seconds`, `platform_settings.privacy.retention_days`, `platform_settings.testing.attached_tests[{test_id}]`: spec `ConversationConfig`, `PrivacyConfig`, `AgentTestingSettings`; https://elevenlabs.io/docs/eleven-agents/customization/privacy/retention.
- Test shapes: `CreateResponseUnitTestRequest` (`chat_history`, `success_condition`, `success_examples[{response,type:"success"}]`), `CreateToolCallUnitTestRequest` (`tool_call_parameters.referenced_tool{id,type}`, `parameters[{path, eval{type: exact|llm|regex|anything}}]`, `verify_absence`), `CreateSimulationTestRequest` (`simulation_scenario`, `simulation_max_turns`, `success_conditions`, `tool_mock_config{mocking_strategy, fallback_strategy, mocked_tool_ids}`, `tool_mock_overrides{<tool_id>: [{mock_result, is_error, parameter_conditions}]}`): https://elevenlabs.io/docs/api-reference/tests/create, https://elevenlabs.io/docs/eleven-agents/customization/agent-testing, https://elevenlabs.io/docs/changelog/2026/4/1.
- Chat-history tool call/result entries (`request_id`, `tool_name`, `params_as_json`, `tool_has_been_called`, `result_value`, `is_error`) and `source_medium: "dtmf"`: spec `ConversationHistoryTranscriptCommonModel`, `ChatSourceMedium`.
- Prompt structure: https://elevenlabs.io/docs/eleven-agents/best-practices/prompting-guide.
- The simulate-conversations guide (https://elevenlabs.io/docs/agents-platform/guides/simulate-conversations) is marked deprecated in favour of the simulation test type, which is what is used here.

Assumed or uncertain (check on first push; each is a one-line change in `render.ts`):

1. Registry entry keys. The CLI binary's serde field names are `name`, `config`, `id`, `branches`, `branch_id`, `version_id`, `type`. `tools.json` entries here carry `name`, `type`, `config`; if push rejects `type`, drop it from `mergeRegistry` in `render.ts`.
2. Whether `tool_configs/*.json` holds the bare `tool_config` object (as written) or `{"tool_config": {...}}`. The README says pulled configs are "raw wire JSON"; the binary extracts `tool_config` on pull, so bare is assumed. If `tools push` fails, wrap it.
3. `referenced_tool` for the system `end_call` tool uses `{id: "end_call", type: "system"}`. The id form for system tools is not documented. If `tests push` rejects `ae2-after-escalate-calls-end-call`, remove that test; the simulation `ae2-two-failures-then-escalate` still checks that the call ended.
4. Overriding `system__caller_id` through `dynamic_variable_placeholders` on the browser-test agent. Placeholders are documented as defaults for any variable; whether the platform lets one default a `system__` variable in a widget session is not stated. Fallback: bind the tools' `caller_id` to a custom variable `helpdesk_caller_id`, give the phone agent a placeholder of `{{system__caller_id}}`, and re-test on the phone.
5. Whether a keypad entry reaches the model as a bare digit-only user turn (the prompt's rule for telling a keypad PIN from a spoken one relies on this) and whether the platform yields a turn on keypad silence (the empty-digits path). Both are U14 spike questions; KTD17 already records the spoken-PIN guardrail as prompt-only.
6. Whether simulation `success_conditions` evaluators can see tool calls. The conditions are written to reference tool calls; if they cannot, the tool-type unit tests cover the same assertions.
7. Mock ordering in `tool_mock_overrides`: the first mock whose `parameter_conditions` match is assumed to win (AE2 uses a digits-1111 mock before a catch-all).
8. mu-law 8 kHz audio formats on the phone agent follow the ElevenLabs Twilio guidance; U11 confirms against the imported number.
9. `HELPDESK_LLM` defaults to `gemini-2.5-flash` (the platform default). Not tuned; change via `.env` if simulation runs show guardrail drift.

## No-test exception

This is a configuration unit. Its verification is the CLI's own test run (`elevenlabs agents test ...`) and a diff-free `agents pull`, both blocked until G4. Local validation done instead: every rendered file was checked structurally against the schemas in the CLI's embedded OpenAPI spec (0 errors across 31 files).
