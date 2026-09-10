// Speech shaping (KTD11). Pure functions that turn adapter results into the
// sentence the agent reads aloud: counts as words, at most three items with
// the identifier read digit by digit, an offer only when more exist, and the
// contract's fixed sentences for verification outcomes. Every result is kept
// under MAX_SPEECH_CHARS. Nothing here knows about sessions or Foundry.

import { speakDigits } from "./identifiers.js";
import type { IssueStatus } from "./types.js";

export const MAX_SPEECH_CHARS = 600;
/** Titles longer than this are trimmed in speech so three items plus an offer always fit. */
const MAX_TITLE_CHARS = 80;

// Fixed sentences, word for word from docs/contract/integration-contract.md.
export const NOT_VERIFIED_SPEECH =
  "I need to verify you first. Please enter your four-digit PIN on the keypad, then press the pound key.";
export const RETRY_SPEECH = "That PIN didn't match. Please try once more, then press pound.";
export const LOCKED_SPEECH = "I couldn't verify you. I can have a person call you back instead. Would you like that?";
export const VERIFIED_SPEECH = "Thanks, you're verified.";
export const ESCALATE_SPEECH = "A person will call you back on this number. Goodbye.";
export const NO_SIMILAR_SPEECH = "I couldn't find a similar issue that was already resolved. Would you like me to log a new one?";
export const CREATE_FAILED_SPEECH =
  "I wasn't able to save that issue, so nothing has been filed. I can have a person call you back. Would you like that?";
export const REFUSED_TIER_SPEECH = "I can't do that from this line. I can have a person call you back. Would you like that?";

export interface SpokenIssue {
  issueId: string;
  title: string;
  status: IssueStatus;
}

const COUNT_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];

/** "zero" through "twenty" as words; larger counts as digits, which TTS reads fine. */
export function countWord(n: number): string {
  const whole = Math.max(0, Math.floor(n));
  return COUNT_WORDS[whole] ?? String(whole);
}

export function spokenStatus(status: IssueStatus | string): string {
  return status.replace(/_/g, " ");
}

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return n === 1 ? singular : pluralForm;
}

function trimTitle(title: string, max = MAX_TITLE_CHARS): string {
  const clean = title.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const atWord = cut.lastIndexOf(" ");
  return `${atWord > max / 2 ? cut.slice(0, atWord) : cut}…`;
}

function spokenItems(items: SpokenIssue[], titleMax = MAX_TITLE_CHARS): string {
  return items
    .slice(0, 3)
    .map((i) => `issue ${speakDigits(i.issueId)}, ${trimTitle(i.title, titleMax)}, ${spokenStatus(i.status)}`)
    .join("; ");
}

function offer(count: number, shown: number): string {
  const more = count - shown;
  if (more <= 0) return "";
  return ` There ${more === 1 ? "is" : "are"} ${countWord(more)} ${plural(more, "more")}. Would you like to hear ${more === 1 ? "it" : "them"}?`;
}

/** Shrinks titles progressively until the sentence fits, then hard-clamps as a last resort. */
function build(render: (titleMax: number) => string): string {
  for (const max of [MAX_TITLE_CHARS, 50, 30, 16]) {
    const s = render(max);
    if (s.length < MAX_SPEECH_CHARS) return s;
  }
  return fitSpeech(render(16));
}

/** Hard clamp at the contract limit, on a word boundary where possible. */
export function fitSpeech(speech: string): string {
  if (speech.length <= MAX_SPEECH_CHARS) return speech;
  const cut = speech.slice(0, MAX_SPEECH_CHARS - 1);
  const atWord = cut.lastIndexOf(" ");
  return `${atWord > MAX_SPEECH_CHARS / 2 ? cut.slice(0, atWord) : cut}…`;
}

function spokenDate(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

export function issueStatusSpeech(issue: { issueId: string; status: IssueStatus; teamName: string; updatedAt: string }): string {
  const date = spokenDate(issue.updatedAt);
  const updated = date ? ` It was last updated on ${date}.` : "";
  return fitSpeech(
    `Issue ${speakDigits(issue.issueId)} is ${spokenStatus(issue.status)}. It's assigned to ${issue.teamName}.${updated}`,
  );
}

export function myOpenIssuesSpeech(count: number, top: SpokenIssue[]): string {
  if (count <= 0 || top.length === 0) return "You have no open issues right now.";
  const shown = Math.min(3, top.length, count);
  return build((titleMax) => {
    const lead = count === 1 ? "You have one open issue: " : `You have ${countWord(count)} open issues. ${shown === count ? "They are" : `The latest ${countWord(shown)} are`}: `;
    return `${lead}${spokenItems(top, titleMax)}.${offer(count, shown)}`;
  });
}

export function teamQueueSpeech(teamName: string, openCount: number, top: SpokenIssue[]): string {
  if (openCount <= 0 || top.length === 0) {
    return `${teamName} is handling your issue and has no other open issues right now.`;
  }
  const shown = Math.min(3, top.length, openCount);
  return build((titleMax) => {
    const lead =
      openCount === 1
        ? `${teamName} is handling your issue and has one other open issue: `
        : `${teamName} is handling your issue and has ${countWord(openCount)} other open issues. ${shown === openCount ? "They are" : `The latest ${countWord(shown)} are`}: `;
    return `${lead}${spokenItems(top, titleMax)}.${offer(openCount, shown)}`;
  });
}

export function siteCountSpeech(siteName: string, openCount: number): string {
  const n = Math.max(0, openCount);
  return fitSpeech(`There ${n === 1 ? "is" : "are"} ${countWord(n)} open ${plural(n, "issue")} at ${siteName} right now.`);
}

/** Same sentence for an unknown identifier and for an issue the caller does not own (KTD5). */
export function issueNotFoundSpeech(issueId: string): string {
  return `I couldn't find an issue numbered ${speakDigits(issueId)} under your name. Could you confirm those digits? Or I can read out your open issues instead.`;
}

export function issueIdNotCaughtSpeech(): string {
  return "I didn't catch a four-digit issue number. Could you say the digits one at a time? Or I can read out your open issues instead.";
}

export function similarMatchSpeech(resolution: string): string {
  const text = resolution.replace(/\s+/g, " ").trim();
  const ending = /[.!?]$/.test(text) ? "" : ".";
  return build((max) => {
    const body = text.length > max * 5 ? `${text.slice(0, max * 5).trimEnd()}…` : `${text}${ending}`;
    return `I found a similar issue that was already resolved. The fix was: ${body} Does that fix it for you?`;
  });
}

export function createdSpeech(issueId: string): string {
  const digits = speakDigits(issueId);
  return `I've logged that as issue number ${digits}. Once more, that's ${digits}. Someone from triage will pick it up.`;
}
