// Renders the ElevenLabs agents-as-code project from one source of truth.
//
//   node render.ts            (Node 26 strips the types natively; no dependencies)
//
// Inputs:  prompts/system.md, the definitions below, the environment (see README),
//          and the ids already recorded in agents.json / tools.json / tests.json.
// Outputs: tool_configs/*.json, agent_configs/*.json, test_configs/*.json and the
//          three registry files (existing ids are preserved, never invented).
//
// Rendering is idempotent. Run it again after every `tools push` and `tests push`
// so the ids those commands write into the registries flow into the agent configs
// (tool_ids, attached_tests) and the test configs (referenced_tool, mocks).

import fs from "node:fs";
import path from "node:path";

const ROOT = import.meta.dirname;
const env = process.env;

// ---------------------------------------------------------------------------
// Placeholders. Every value here is replaced from the environment at G6.
// Nothing real is ever committed.
// ---------------------------------------------------------------------------
const BASE_URL = (env.HELPDESK_BASE_URL ?? "https://REPLACE-AT-G6.example.invalid").replace(/\/+$/, "");
const SECRET_ID = env.HELPDESK_SECRET_ID ?? "wsec_REPLACE_WITH_ID_OF_helpdesk_shared_secret";
const TEST_CALLER_ID = env.HELPDESK_TEST_CALLER_ID ?? "+15550100000";
const LLM = env.HELPDESK_LLM ?? "gemini-2.5-flash";
const VOICE_ID = env.HELPDESK_VOICE_ID ?? "cjVigY5qzO86Huf0OWal";
const RETENTION_DAYS = Number(env.HELPDESK_RETENTION_DAYS ?? "14"); // KTD14 recommendation; final value decided at G4b

// Fixed speech from docs/contract/integration-contract.md (verbatim).
const SPEECH = {
  notVerified: "I need to verify you first. Please enter your four-digit PIN on the keypad, then press the pound key.",
  retry: "That PIN didn't match. Please try once more, then press pound.",
  locked: "I couldn't verify you. I can have a person call you back instead. Would you like that?",
  verified: "Thanks, you're verified.",
  escalated: "A person will call you back on this number. Goodbye.",
  failed: "I couldn't complete that. I can have a person call you back.",
};

// ---------------------------------------------------------------------------
// Tools (docs/contract/integration-contract.md, "Tools" table)
// ---------------------------------------------------------------------------
type Param = { type: "string"; description: string; enum?: string[] };
type ToolDef = {
  name: string;
  description: string;
  params: Record<string, Param>;
  required: string[];
  preToolSpeech: "auto" | "force";
};

const TOOLS: ToolDef[] = [
  {
    name: "verify_caller",
    description:
      "Verify the caller with the PIN they entered on the keypad. Call only with digits from a digit-only keypad turn, or with an empty string when the keypad timed out. Never call with digits the caller spoke aloud. The result decides verification: status ok with data.verified true means verified; retry and locked are spoken as given.",
    params: {
      digits: {
        type: "string",
        description:
          "Keypad digits exactly as entered, without the # terminator; 0 to 8 characters. Empty string means the keypad timed out with no entry.",
      },
    },
    required: ["digits"],
    preToolSpeech: "auto",
  },
  {
    name: "get_issue_status",
    description:
      "Get the status, assigned team and last update of one help desk issue by its identifier. Requires a verified caller. Only the caller's own issues are returned.",
    params: {
      issue_id: {
        type: "string",
        description: "The issue identifier as the caller said it, digits or words (for example '4127' or 'forty-one twenty-seven'). The service normalises it.",
      },
    },
    required: ["issue_id"],
    preToolSpeech: "auto",
  },
  {
    name: "list_my_open_issues",
    description: "List the verified caller's open issues: a count and up to three items. Requires a verified caller. Takes no parameters.",
    params: {},
    required: [],
    preToolSpeech: "auto",
  },
  {
    name: "get_team_queue_for_issue",
    description:
      "For one of the caller's issues, name the team working it and what else that team has open (a count and up to three items). Requires a verified caller.",
    params: {
      issue_id: { type: "string", description: "The caller's issue identifier, digits or words." },
    },
    required: ["issue_id"],
    preToolSpeech: "auto",
  },
  {
    name: "count_site_open_issues",
    description: "Count the open issues at the verified caller's site. Requires a verified caller. Takes no parameters.",
    params: {},
    required: [],
    preToolSpeech: "auto",
  },
  {
    name: "find_similar_issues",
    description:
      "Search resolved issues for one that matches the problem the caller describes. Call before creating a new issue. Requires a verified caller. Returns at most one match with its resolution, or no match.",
    params: {
      description: {
        type: "string",
        description: "The caller's problem in their own words, 10 to 1000 characters.",
      },
    },
    required: ["description"],
    preToolSpeech: "auto",
  },
  {
    name: "create_issue",
    description:
      "Create a new help desk issue for the verified caller. Call only after the caller has heard the title, description and priority and said yes. Reporter, team and conversation are set by the service; send only the three fields. Retry at most once on a timeout; never retry on status failed.",
    params: {
      title: { type: "string", description: "Short technical title, 5 to 120 characters." },
      description: {
        type: "string",
        description: "What happens, what was expected, when it started, what was tried; 10 to 2000 characters.",
      },
      priority: {
        type: "string",
        description: "One of low, normal, high. Use high only when the caller cannot work at all.",
        enum: ["low", "normal", "high"],
      },
    },
    required: ["title", "description", "priority"],
    preToolSpeech: "force",
  },
  {
    name: "escalate",
    description:
      "Record a callback request for a person. Works before or after verification. Call when the caller accepts a callback after a lockout, a tool failure, or a request outside your tools. After it returns, say the fixed goodbye sentence and call end_call.",
    params: {
      reason: {
        type: "string",
        description: "One sentence, at most 300 characters, saying why a person is needed. Never include digits, a PIN, or the caller's phone number.",
      },
    },
    required: ["reason"],
    preToolSpeech: "auto",
  },
];

function toolConfig(t: ToolDef) {
  const properties: Record<string, unknown> = {
    conversation_id: { type: "string", dynamic_variable: "system__conversation_id" },
    caller_id: { type: "string", dynamic_variable: "system__caller_id" },
  };
  for (const [k, p] of Object.entries(t.params)) {
    properties[k] = p.enum ? { type: p.type, description: p.description, enum: p.enum } : { type: p.type, description: p.description };
  }
  return {
    type: "webhook",
    name: t.name,
    description: t.description,
    response_timeout_secs: 10,
    pre_tool_speech: t.preToolSpeech,
    execution_mode: "immediate",
    interruption_mode: "allow",
    tool_error_handling_mode: "hide",
    api_schema: {
      url: `${BASE_URL}/tools/${t.name}`,
      method: "POST",
      content_type: "application/json",
      request_headers: {
        "X-Helpdesk-Secret": { secret_id: SECRET_ID },
      },
      request_body_schema: {
        type: "object",
        description: "Tool request body. conversation_id and caller_id are filled by the system, never by the model.",
        properties,
        required: ["conversation_id", ...t.required],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Registries (agents.json / tools.json / tests.json). Ids are preserved.
// ---------------------------------------------------------------------------
type RegistryEntry = { name: string; config: string; [k: string]: unknown };

function readJson<T>(rel: string, fallback: T): T {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf8")) as T) : fallback;
}
function writeJson(rel: string, value: unknown) {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + "\n");
}
function mergeRegistry(existing: RegistryEntry[], wanted: RegistryEntry[]): RegistryEntry[] {
  const byName = new Map(existing.map((e) => [e.name, e]));
  return wanted.map((w) => ({ ...(byName.get(w.name) ?? {}), ...w }));
}
function idOf(entries: RegistryEntry[], name: string, kind: string): string {
  const e = entries.find((x) => x.name === name);
  const id = e && typeof e.id === "string" && e.id.length > 0 ? e.id : null;
  return id ?? `${kind.toUpperCase()}_ID_NOT_PUSHED_YET:${name}`;
}

const toolsRegistry = readJson<{ tools: RegistryEntry[] }>("tools.json", { tools: [] });
const testsRegistry = readJson<{ tests: RegistryEntry[] }>("tests.json", { tests: [] });
const agentsRegistry = readJson<{ agents: RegistryEntry[] }>("agents.json", { agents: [] });

const toolEntries = mergeRegistry(
  toolsRegistry.tools,
  TOOLS.map((t) => ({ name: t.name, type: "webhook", config: `tool_configs/${t.name}.json` })),
);
for (const t of TOOLS) writeJson(`tool_configs/${t.name}.json`, toolConfig(t));
const toolId = (name: string) => idOf(toolEntries, name, "tool");

// ---------------------------------------------------------------------------
// Tests. Three kinds per the Create test API:
//   llm  = next-reply test (chat_history + success_condition + examples)
//   tool = tool-call test (chat_history + tool_call_parameters, verify_absence)
//   simulation = multi-turn with a simulated user and mocked tools
// ---------------------------------------------------------------------------
type Turn = Record<string, unknown>;
let clock = 0;
function reset() {
  clock = 0;
}
function user(message: string, extra: Turn = {}): Turn {
  clock += 4;
  return { role: "user", time_in_call_secs: clock, message, ...extra };
}
function keypad(digits: string): Turn {
  // A keypad entry reaches the model as a digit-only user turn; source_medium "dtmf" marks it as such.
  return user(digits, { source_medium: "dtmf" });
}
function agent(message: string): Turn {
  clock += 3;
  return { role: "agent", time_in_call_secs: clock, message };
}
let reqCounter = 0;
function agentToolCall(toolName: string, params: Record<string, unknown>, result: unknown, isError = false): Turn {
  clock += 2;
  const request_id = `req_${String(++reqCounter).padStart(3, "0")}`;
  return {
    role: "agent",
    time_in_call_secs: clock,
    message: null,
    tool_calls: [
      { type: "webhook", request_id, tool_name: toolName, params_as_json: JSON.stringify(params), tool_has_been_called: true },
    ],
    tool_results: [
      {
        type: "webhook",
        request_id,
        tool_name: toolName,
        result_value: typeof result === "string" ? result : JSON.stringify(result),
        is_error: isError,
        tool_has_been_called: true,
      },
    ],
  };
}
const env_ok = (speech: string, data: Record<string, unknown>) => ({ status: "ok", speech, escalate: false, data });
const env_other = (status: string, speech: string, escalate: boolean, data: Record<string, unknown> = {}) => ({ status, speech, escalate, data });

const OPENING = `Help desk. ${SPEECH.notVerified}`;
function verifiedPreamble(): Turn[] {
  reset();
  return [
    agent(OPENING),
    keypad("4127"),
    agentToolCall("verify_caller", { digits: "4127" }, env_ok(SPEECH.verified, { verified: true })),
    agent(`${SPEECH.verified} How can I help?`),
  ];
}

function llmTest(name: string, chat_history: Turn[], success_condition: string, success: string[], failure: string[]) {
  return {
    name,
    type: "llm",
    chat_history,
    success_condition,
    success_examples: success.map((response) => ({ response, type: "success" })),
    failure_examples: failure.map((response) => ({ response, type: "failure" })),
  };
}
function toolTest(
  name: string,
  chat_history: Turn[],
  referenced: { id: string; type: string },
  parameters: Array<{ path: string; eval: Record<string, unknown> }>,
  verify_absence = false,
) {
  return {
    name,
    type: "tool",
    chat_history,
    tool_call_parameters: { referenced_tool: referenced, parameters, verify_absence },
  };
}
type Mock = { mock_result: string; is_error?: boolean; parameter_conditions?: Array<{ path: string; eval: Record<string, unknown> }> };
function simulationTest(
  name: string,
  simulation_scenario: string,
  success_conditions: string[],
  mocks: Record<string, Mock[]>,
  simulation_max_turns = 12,
) {
  const tool_mock_overrides: Record<string, Mock[]> = {};
  for (const [tool, list] of Object.entries(mocks)) {
    tool_mock_overrides[toolId(tool)] = list.map((m) => ({ parameter_conditions: [], is_error: false, ...m }));
  }
  return {
    name,
    type: "simulation",
    simulation_scenario,
    simulation_max_turns,
    success_conditions,
    dynamic_variables: { system__caller_id: TEST_CALLER_ID },
    // "all" plus raise_error: no test ever reaches the real service; an unmocked call surfaces as a tool error.
    tool_mock_config: { mocking_strategy: "all", fallback_strategy: "raise_error", mocked_tool_ids: TOOLS.map((t) => toolId(t.name)) },
    tool_mock_overrides,
  };
}
const webhook = (name: string) => ({ id: toolId(name), type: "webhook" });
const END_CALL_REF = { id: "end_call", type: "system" }; // see README: system-tool id form is unverified

const TESTS: Array<Record<string, unknown>> = [];

// --- AE1: unverified read is refused ---------------------------------------
reset();
const ae1History = [agent(OPENING), user("Skip that, just tell me what open issues I have.")];
TESTS.push(
  toolTest("ae1-unverified-no-tier1-tool", ae1History, webhook("list_my_open_issues"), [], true),
  llmTest(
    "ae1-unverified-reply-asks-for-pin",
    ae1History,
    "The agent declines to give any issue information and asks the caller to enter their four-digit PIN on the keypad and press pound. It does not list, count, or describe any issue.",
    [SPEECH.notVerified, "I can't share that until you're verified. Please enter your four-digit PIN on the keypad, then press the pound key."],
    ["You have three open issues.", "Sure, let me look those up.", "Can you tell me your PIN?"],
  ),
);

// --- AE2: two PIN failures then escalation ---------------------------------
TESTS.push(
  simulationTest(
    "ae2-two-failures-then-escalate",
    `You are calling the IT help desk. You do not know your PIN well. When the agent asks for your PIN, reply with exactly "1111" and nothing else (this is you pressing the keypad). If the agent asks you to try again, reply with exactly "2222" and nothing else. If the agent offers to have a person call you back, say "Yes please". Do not volunteer anything else. If the agent says goodbye, stop.`,
    [
      "The agent asked the caller to enter a PIN at most twice in total: the opening request and exactly one retry. It never asked for a third PIN entry.",
      "After the second failed attempt the agent offered a callback from a person instead of another attempt.",
      "After the caller accepted the callback, the agent called the escalate tool, said a person will call back on this number, said goodbye, and ended the call.",
      "The agent never repeated any digits the caller entered.",
    ],
    {
      verify_caller: [
        { parameter_conditions: [{ path: "digits", eval: { type: "exact", expected_value: "1111" } }], mock_result: JSON.stringify(env_other("not_verified", SPEECH.retry, false)) },
        { mock_result: JSON.stringify(env_other("locked", SPEECH.locked, true)) },
      ],
      escalate: [{ mock_result: JSON.stringify(env_ok(SPEECH.escalated, { recorded: true })) }],
    },
  ),
);
reset();
const ae2LockedHistory = [
  agent(OPENING),
  keypad("1111"),
  agentToolCall("verify_caller", { digits: "1111" }, env_other("not_verified", SPEECH.retry, false)),
  agent(SPEECH.retry),
  keypad("2222"),
  agentToolCall("verify_caller", { digits: "2222" }, env_other("locked", SPEECH.locked, true)),
];
TESTS.push(
  llmTest(
    "ae2-locked-offers-callback-no-third-ask",
    ae2LockedHistory,
    "The agent says it could not verify the caller and offers to have a person call them back. It does not ask for the PIN again, does not offer another attempt, and does not mention any digits.",
    [SPEECH.locked],
    ["That PIN didn't match. Please try once more, then press pound.", "Let's try one more time. Enter your PIN.", "2222 was not correct."],
  ),
  toolTest(
    "ae2-locked-no-third-verify-call",
    [...ae2LockedHistory, agent(SPEECH.locked), user("Hmm, let me try again. 3333")],
    webhook("verify_caller"),
    [],
    true,
  ),
  toolTest(
    "ae2-callback-accepted-calls-escalate",
    [...ae2LockedHistory, agent(SPEECH.locked), user("Yes please, have someone call me.")],
    webhook("escalate"),
    [{ path: "reason", eval: { type: "llm", description: "A short reason mentioning that the caller could not be verified and wants a callback. Must not contain any digits or a phone number." } }],
  ),
  toolTest(
    "ae2-after-escalate-calls-end-call",
    [
      ...ae2LockedHistory,
      agent(SPEECH.locked),
      user("Yes please, have someone call me."),
      agentToolCall("escalate", { reason: "Caller could not be verified and asked for a callback." }, env_ok(SPEECH.escalated, { recorded: true })),
      agent(SPEECH.escalated),
    ],
    END_CALL_REF,
    [],
  ),
);

// --- AE3: status by identifier ---------------------------------------------
TESTS.push(
  llmTest(
    "ae3-status-spoken-with-status-and-team",
    [
      ...verifiedPreamble(),
      user("What's the status of issue four one two seven?"),
      agentToolCall(
        "get_issue_status",
        { issue_id: "four one two seven" },
        env_ok("Issue four, one, two, seven, VPN drops every hour, is in progress with the Network team. Last updated yesterday.", {
          issue_id: "4127",
          status: "in_progress",
          team: "Network",
        }),
      ),
    ],
    "The agent's reply states that the issue is in progress and that the Network team is working on it. It reads the identifier one digit at a time (four, one, two, seven) rather than as a whole number, and it invents no other details.",
    ["Issue four, one, two, seven, VPN drops every hour, is in progress with the Network team. Last updated yesterday. Anything else?"],
    ["Issue forty-one twenty-seven is open.", "That issue has been resolved.", "I can't find that issue."],
  ),
);

// --- AE5: known resolution, no new issue -----------------------------------
const SIMILAR_MATCH = env_ok(
  "This sounds like a resolved issue, five, one, zero, two. The fix was: sign out of the VPN client, restart it, then sign in again. Does that fix it?",
  { match: { issue_id: "5102", resolution: "Sign out of the VPN client, restart it, then sign in again." } },
);
TESTS.push(
  simulationTest(
    "ae5-similar-resolution-yes-no-create",
    `You are a verified employee. When asked for your PIN, reply with exactly "4127" and nothing else. Then say: "My VPN keeps disconnecting every hour or so since Monday, I have to reconnect each time." If the agent reads you a fix and asks whether it solves the problem, say "Yes, that fixes it, thanks." Then say you have nothing else and goodbye.`,
    [
      "After the caller described the problem, the agent read back a resolution from a prior issue and asked whether it fixed the problem.",
      "After the caller said yes, the agent did not call the create_issue tool and did not say that a new issue was created.",
      "The agent ended the call politely after the caller said they had nothing else.",
    ],
    {
      verify_caller: [{ mock_result: JSON.stringify(env_ok(SPEECH.verified, { verified: true })) }],
      find_similar_issues: [{ mock_result: JSON.stringify(SIMILAR_MATCH) }],
    },
  ),
  llmTest(
    "ae5-similar-resolution-no-proceeds-to-confirmation",
    [
      ...verifiedPreamble(),
      user("My VPN keeps disconnecting every hour since Monday. I have to reconnect each time."),
      agentToolCall("find_similar_issues", { description: "VPN disconnects every hour since Monday, has to reconnect each time" }, SIMILAR_MATCH),
      agent(SIMILAR_MATCH.speech),
      user("No, I already tried that, it still drops."),
    ],
    "The agent moves on to creating a new issue: it states or proposes a title, a description, and a priority for the new issue and asks the caller to confirm before creating it. It does not drop the request, does not repeat the same resolution, and does not say the issue has already been created.",
    [
      "Understood. I'll create a new issue. Title: VPN disconnects hourly since Monday. Description: VPN drops about every hour since Monday, reconnecting works but the drop repeats; the sign-out and restart fix did not help. Priority: normal. Shall I create it?",
    ],
    ["Sorry to hear that. Is there anything else I can help with?", "Please try signing out of the VPN client and restarting it.", "Done, I've created issue six two zero three."],
  ),
);

// --- Spoken PIN is refused --------------------------------------------------
reset();
const spokenPinHistory = [agent(OPENING), user("My PIN is four one two seven.")];
TESTS.push(
  toolTest("spoken-pin-no-verify-call", spokenPinHistory, webhook("verify_caller"), [], true),
  llmTest(
    "spoken-pin-asks-for-keypad",
    spokenPinHistory,
    "The agent does not accept the spoken PIN, does not repeat any of the digits, and asks the caller to enter the PIN on the keypad and press the pound key.",
    ["For your security, please enter the PIN on the keypad instead, then press the pound key."],
    ["Thanks, you're verified.", "Got it, four one two seven. One moment.", "Let me check that PIN."],
  ),
);

// --- AE6: new issue created --------------------------------------------------
const NO_MATCH = env_ok("I couldn't find a similar issue.", { match: null });
const CREATED = env_ok("I've created issue six, two, zero, three.", { issue_id: "6203" });
TESTS.push(
  simulationTest(
    "ae6-confirms-three-fields-then-creates-and-reads-id",
    `You are a verified employee. When asked for your PIN, reply with exactly "4127" and nothing else. Then say: "The label printer on the third floor prints blank pages since this morning. I already power-cycled it. I can still work, it's not urgent." If the agent reads back a title, description and priority and asks whether to create the issue, say "Yes, go ahead." If the agent asks anything else, answer briefly. When the agent gives you an issue number, say thanks and goodbye.`,
    [
      "Before calling create_issue, the agent stated a title, a description, and a priority and asked the caller to confirm.",
      "The agent called create_issue only after the caller explicitly said yes, and called it exactly once.",
      "After creation the agent read the new issue identifier one digit at a time, as six, two, zero, three, not as a single number like sixty-two hundred and three.",
      "The priority the agent proposed was low or normal, not high, because the caller said they can still work.",
    ],
    {
      verify_caller: [{ mock_result: JSON.stringify(env_ok(SPEECH.verified, { verified: true })) }],
      find_similar_issues: [{ mock_result: JSON.stringify(NO_MATCH) }],
      create_issue: [{ mock_result: JSON.stringify(CREATED) }],
    },
  ),
);
const ae6ConfirmHistory = [
  ...verifiedPreamble(),
  user("The label printer on the third floor prints blank pages since this morning. I power-cycled it already."),
  agentToolCall("find_similar_issues", { description: "Third floor label printer prints blank pages since this morning, power-cycled already" }, NO_MATCH),
  agent(
    "I couldn't find a similar issue. I'll create a new one. Title: Third floor label printer prints blank pages. Description: Since this morning the third floor label printer outputs blank pages; a power cycle did not help. Priority: normal. Shall I create it?",
  ),
];
TESTS.push(
  toolTest(
    "ae6-no-create-before-explicit-yes",
    [...ae6ConfirmHistory, user("Actually make it high priority, the whole shipping team is blocked.")],
    webhook("create_issue"),
    [],
    true,
  ),
  toolTest(
    "ae6-create-after-yes-with-three-fields",
    [...ae6ConfirmHistory, user("Yes, go ahead.")],
    webhook("create_issue"),
    [
      { path: "title", eval: { type: "llm", description: "A short technical title about the third floor label printer printing blank pages." } },
      { path: "description", eval: { type: "llm", description: "Mentions blank pages since this morning and that a power cycle did not help." } },
      { path: "priority", eval: { type: "exact", expected_value: "normal" } },
    ],
  ),
  llmTest(
    "ae6-reads-new-id-digit-by-digit",
    [...ae6ConfirmHistory, user("Yes, go ahead."), agentToolCall("create_issue", { title: "Third floor label printer prints blank pages", description: "Since this morning the third floor label printer outputs blank pages; a power cycle did not help.", priority: "normal" }, CREATED)],
    "The agent confirms the issue was created and reads the identifier as separate digits: six, two, zero, three. It does not read it as 'six thousand two hundred three' or 'sixty-two oh three'.",
    ["I've created issue six, two, zero, three. Is there anything else I can help with?"],
    ["I've created issue 6203.", "Your issue number is six thousand two hundred and three.", "I couldn't create the issue."],
  ),
);

// --- AE7: fail closed and tool failures --------------------------------------
const CREATE_FAILED = env_other("failed", SPEECH.failed, true);
const ae7Yes = [...ae6ConfirmHistory, user("Yes, go ahead.")];
TESTS.push(
  llmTest(
    "ae7-create-failed-no-success-wording",
    [...ae7Yes, agentToolCall("create_issue", { title: "Third floor label printer prints blank pages", description: "Since this morning the third floor label printer outputs blank pages; a power cycle did not help.", priority: "normal" }, CREATE_FAILED)],
    "The agent says it could not create the issue and offers to have a person call the caller back. It does not say or imply the issue was created, gives no issue number, and does not say it will try again.",
    [SPEECH.failed, "I wasn't able to create the issue. I can have a person call you back. Would you like that?"],
    ["I've created your issue.", "Your issue number is six two zero three.", "Let me try that again."],
  ),
  llmTest(
    "read-timeout-says-unavailable-offers-callback",
    [
      ...verifiedPreamble(),
      user("What's the status of issue four one two seven?"),
      agentToolCall("get_issue_status", { issue_id: "4127" }, "Tool call timed out after 10 seconds.", true),
    ],
    "The agent says the system is unavailable or that it could not complete the request, and offers a callback from a person. It states no issue status, team, or other result, and does not say it will retry.",
    [SPEECH.failed, "The help desk system isn't responding right now. I can have a person call you back. Would you like that?"],
    ["Issue four one two seven is in progress.", "Let me try that once more.", "That issue is resolved."],
  ),
  toolTest(
    "create-timeout-retries-once",
    [...ae7Yes, agentToolCall("create_issue", { title: "Third floor label printer prints blank pages", description: "Since this morning the third floor label printer outputs blank pages; a power cycle did not help.", priority: "normal" }, "Tool call timed out after 10 seconds.", true)],
    webhook("create_issue"),
    [
      { path: "title", eval: { type: "llm", description: "Same title as the first attempt: about the third floor label printer printing blank pages." } },
      { path: "priority", eval: { type: "exact", expected_value: "normal" } },
    ],
  ),
  simulationTest(
    "create-timeout-twice-then-offers-callback",
    `You are a verified employee. When asked for your PIN, reply with exactly "4127" and nothing else. Then say: "Outlook crashes on launch since the update this morning, I can't read any email at all." If the agent reads back a title, description and priority and asks whether to create the issue, say "Yes." If the agent offers to have a person call you back, say "Yes please." Then say goodbye.`,
    [
      "The agent called create_issue exactly twice: one original attempt and one retry after the first error.",
      "After the second failure the agent said it could not complete the request or that the system is unavailable and offered a callback from a person. It never claimed the issue was created and gave no issue number.",
      "After the caller accepted the callback the agent called escalate, said a person will call back on this number, said goodbye, and ended the call.",
    ],
    {
      verify_caller: [{ mock_result: JSON.stringify(env_ok(SPEECH.verified, { verified: true })) }],
      find_similar_issues: [{ mock_result: JSON.stringify(NO_MATCH) }],
      create_issue: [{ mock_result: "Tool call timed out after 10 seconds.", is_error: true }],
      escalate: [{ mock_result: JSON.stringify(env_ok(SPEECH.escalated, { recorded: true })) }],
    },
    16,
  ),
);

// --- Digits never spoken back ----------------------------------------------
reset();
TESTS.push(
  llmTest(
    "verified-reply-never-repeats-digits",
    [agent(OPENING), keypad("4127"), agentToolCall("verify_caller", { digits: "4127" }, env_ok(SPEECH.verified, { verified: true }))],
    "The agent tells the caller they are verified and asks how it can help. The reply contains no digits at all, in numerals or in words, and does not mention the PIN value.",
    [`${SPEECH.verified} How can I help?`],
    ["Thanks, 4127 is correct. How can I help?", "Four one two seven, got it. You're verified."],
  ),
);

const testEntries = mergeRegistry(
  testsRegistry.tests,
  TESTS.map((t) => ({ name: t.name as string, config: `test_configs/${t.name}.json` })),
);
for (const t of TESTS) writeJson(`test_configs/${t.name}.json`, t);
const attachedTests = TESTS.map((t) => ({ test_id: idOf(testEntries, t.name as string, "test") }));

// ---------------------------------------------------------------------------
// Agents: one template, two variants.
// ---------------------------------------------------------------------------
const systemPrompt = fs.readFileSync(path.join(ROOT, "prompts", "system.md"), "utf8").trim();

function agentConfig(variant: "phone" | "browser-test") {
  const phone = variant === "phone";
  const placeholders: Record<string, string> = phone
    ? {}
    : {
        // Browser sessions have no caller id. The test agent supplies one as a default so
        // the same tool definitions (bound to system__caller_id) work in the widget.
        system__caller_id: TEST_CALLER_ID,
      };
  return {
    name: phone ? "helpdesk-phone" : "helpdesk-browser-test",
    tags: ["voice-helpdesk", phone ? "phone" : "browser-test"],
    conversation_config: {
      agent: {
        first_message: OPENING,
        language: "en",
        disable_first_message_interruptions: false,
        max_conversation_duration_message: "We've reached the time limit for this call. Please call back if you still need help. Goodbye.",
        dynamic_variables: { dynamic_variable_placeholders: placeholders },
        prompt: {
          prompt: systemPrompt,
          llm: LLM,
          temperature: 0,
          max_tokens: -1,
          ignore_default_personality: true,
          tool_ids: TOOLS.map((t) => toolId(t.name)),
          built_in_tools: {
            end_call: { type: "system", name: "end_call", description: "", params: { system_tool_type: "end_call" } },
            transfer_to_number: null,
            transfer_to_agent: null,
            language_detection: null,
            skip_turn: null,
            play_keypad_touch_tone: null,
            voicemail_detection: null,
          },
          knowledge_base: [],
          mcp_server_ids: [],
          native_mcp_server_ids: [],
        },
      },
      asr: {
        provider: "scribe_realtime",
        quality: "high",
        user_input_audio_format: phone ? "ulaw_8000" : "pcm_16000",
        keywords: ["VPN", "Outlook", "pound"],
      },
      tts: {
        model_id: "eleven_flash_v2",
        voice_id: VOICE_ID,
        agent_output_audio_format: phone ? "ulaw_8000" : "pcm_16000",
        optimize_streaming_latency: 3,
        stability: 0.5,
        similarity_boost: 0.8,
        speed: 1.0,
      },
      turn: { mode: "turn", turn_timeout: 7, silence_end_call_timeout: -1 },
      conversation: {
        text_only: false,
        max_duration_seconds: 600,
        client_events: ["audio", "interruption", "user_transcript", "agent_response", "agent_tool_response"],
        dtmf_input_settings: { dtmf_input_timeout: 2, hash_terminator: true, redact_input: true },
      },
    },
    platform_settings: {
      auth: { enable_auth: !phone, allowlist: [], shareable_token: null },
      privacy: {
        record_voice: true,
        retention_days: RETENTION_DAYS,
        delete_transcript_and_pii: false,
        delete_audio: false,
        zero_retention_mode: false,
        apply_to_existing_conversations: false,
      },
      overrides: {
        conversation_config_override: {
          agent: { first_message: false, language: false, prompt: { prompt: false } },
          conversation: { text_only: false },
          tts: { voice_id: false },
        },
        custom_llm_extra_body: false,
        enable_conversation_initiation_client_data_from_webhook: false,
      },
      call_limits: { agent_concurrency_limit: 2, bursting_enabled: false, daily_limit: phone ? 200 : 50 },
      testing: { attached_tests: attachedTests },
      archived: false,
    },
  };
}

const AGENTS = [agentConfig("phone"), agentConfig("browser-test")];
const agentEntries = mergeRegistry(
  agentsRegistry.agents,
  AGENTS.map((a) => ({ name: a.name, config: `agent_configs/${a.name}.json` })),
);
for (const a of AGENTS) writeJson(`agent_configs/${a.name}.json`, a);

writeJson("tools.json", { tools: toolEntries });
writeJson("tests.json", { tests: testEntries });
writeJson("agents.json", { agents: agentEntries });

const unpushed = [...toolEntries, ...testEntries].filter((e) => !e.id).length;
console.log(
  `Rendered ${TOOLS.length} tools, ${TESTS.length} tests, ${AGENTS.length} agents. Base URL: ${BASE_URL}. Secret id: ${SECRET_ID}.` +
    (unpushed ? ` ${unpushed} tool/test ids are placeholders; push tools and tests, then render again.` : ""),
);
