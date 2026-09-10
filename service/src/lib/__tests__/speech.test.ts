// Speech shaping is pure and fixed by the contract: counts as words, top three
// items with digits read one by one, an offer only when more exist, and fixed
// sentences for verification outcomes. Every result stays under 600 characters.

import { describe, expect, it } from "vitest";
import {
  CREATE_FAILED_SPEECH,
  ESCALATE_SPEECH,
  LOCKED_SPEECH,
  MAX_SPEECH_CHARS,
  NOT_VERIFIED_SPEECH,
  NO_SIMILAR_SPEECH,
  RETRY_SPEECH,
  VERIFIED_SPEECH,
  countWord,
  createdSpeech,
  fitSpeech,
  issueIdNotCaughtSpeech,
  issueNotFoundSpeech,
  issueStatusSpeech,
  myOpenIssuesSpeech,
  similarMatchSpeech,
  siteCountSpeech,
  teamQueueSpeech,
} from "../speech.js";

const items = [
  { issueId: "4127", title: "Build server SSO login loops back to the sign-in page", status: "open" as const },
  { issueId: "3837", title: "Jenkins pipeline stuck in queued state for over an hour", status: "in_progress" as const },
  { issueId: "4287", title: "Laptop fan runs at full speed while idle", status: "in_progress" as const },
];

describe("countWord", () => {
  it("spells zero through twenty and uses digits above", () => {
    expect(countWord(0)).toBe("zero");
    expect(countWord(1)).toBe("one");
    expect(countWord(5)).toBe("five");
    expect(countWord(14)).toBe("fourteen");
    expect(countWord(20)).toBe("twenty");
    expect(countWord(21)).toBe("21");
    expect(countWord(137)).toBe("137");
  });
});

describe("fixed verification sentences", () => {
  it("match the contract word for word", () => {
    expect(NOT_VERIFIED_SPEECH).toBe(
      "I need to verify you first. Please enter your four-digit PIN on the keypad, then press the pound key.",
    );
    expect(RETRY_SPEECH).toBe("That PIN didn't match. Please try once more, then press pound.");
    expect(LOCKED_SPEECH).toBe("I couldn't verify you. I can have a person call you back instead. Would you like that?");
    expect(VERIFIED_SPEECH).toBe("Thanks, you're verified.");
    expect(ESCALATE_SPEECH).toBe("A person will call you back on this number. Goodbye.");
  });
});

describe("issueStatusSpeech", () => {
  it("reads the identifier digit by digit with status, team, and last update", () => {
    const s = issueStatusSpeech({
      issueId: "4127",
      status: "open",
      teamName: "Platform Engineering",
      updatedAt: "2026-07-19T22:23:31.414Z",
    });
    expect(s).toContain("4, 1, 2, 7");
    expect(s).not.toContain("4127");
    expect(s).toContain("open");
    expect(s).toContain("Platform Engineering");
    expect(s).toContain("July 19");
  });

  it("speaks in_progress as two words and survives a bad timestamp", () => {
    const s = issueStatusSpeech({ issueId: "3837", status: "in_progress", teamName: "Platform Engineering", updatedAt: "nope" });
    expect(s).toContain("in progress");
    expect(s).not.toContain("in_progress");
    expect(s).not.toContain("Invalid");
  });
});

describe("myOpenIssuesSpeech", () => {
  it("speaks the count as a word, three items with digits, and an offer for the rest", () => {
    const s = myOpenIssuesSpeech(5, items);
    expect(s).toContain("five");
    expect(s).toContain("4, 1, 2, 7");
    expect(s).toContain("3, 8, 3, 7");
    expect(s).toContain("4, 2, 8, 7");
    expect(s).toContain("two more");
    expect(s.length).toBeLessThan(MAX_SPEECH_CHARS);
  });

  it("makes no offer when everything fits", () => {
    const s = myOpenIssuesSpeech(3, items);
    expect(s).toContain("three");
    expect(s).not.toMatch(/more/);
  });

  it("speaks a friendly none message with no offer for zero", () => {
    const s = myOpenIssuesSpeech(0, []);
    expect(s).toMatch(/no open issues|zero open issues/i);
    expect(s).not.toMatch(/more/);
  });
});

describe("teamQueueSpeech", () => {
  it("names the team, the count, three items, and an offer; never a reporter or description", () => {
    const five = [...items, { issueId: "1015", title: "NFS share mount fails", status: "open" as const }, { issueId: "2358", title: "Deploy fails", status: "open" as const }];
    const s = teamQueueSpeech("Platform Engineering", 5, five.slice(0, 3));
    expect(s).toContain("Platform Engineering");
    expect(s).toContain("five");
    expect(s).toContain("4, 1, 2, 7");
    expect(s).toContain("4, 2, 8, 7");
    expect(s).not.toContain("1, 0, 1, 5");
    expect(s).toContain("two more");
    expect(s).not.toContain("Dana");
  });

  it("says the team has nothing else open when the count is zero", () => {
    const s = teamQueueSpeech("Platform Engineering", 0, []);
    expect(s).toContain("Platform Engineering");
    expect(s).toMatch(/no other open issues|nothing else open/i);
  });
});

describe("siteCountSpeech", () => {
  it("speaks the number as a word with the site name, including zero", () => {
    expect(siteCountSpeech("Harbor Point HQ", 14)).toContain("fourteen");
    expect(siteCountSpeech("Harbor Point HQ", 14)).toContain("Harbor Point HQ");
    expect(siteCountSpeech("Riverside Lab", 0)).toContain("zero");
    expect(siteCountSpeech("Riverside Lab", 1)).toMatch(/one open issue\b/);
  });
});

describe("not-found read-back", () => {
  it("repeats the digits, asks for confirmation, and offers the open-issues list", () => {
    const s = issueNotFoundSpeech("9876");
    expect(s).toContain("9, 8, 7, 6");
    expect(s).not.toContain("9876");
    expect(s).toMatch(/confirm|check/i);
    expect(s).toMatch(/open issues/);
  });

  it("asks for the digits again when none were caught and still offers the list", () => {
    const s = issueIdNotCaughtSpeech();
    expect(s).toMatch(/four-digit|digits/);
    expect(s).toMatch(/open issues/);
  });
});

describe("similar and create", () => {
  it("reads the resolution back and asks whether it fixes the problem", () => {
    const s = similarMatchSpeech("Disabled the wifi adapter's power-saving mode.");
    expect(s).toContain("Disabled the wifi adapter's power-saving mode.");
    expect(s).toContain("Does that fix it for you?");
  });

  it("has a fixed no-match sentence", () => {
    expect(NO_SIMILAR_SPEECH).toMatch(/couldn't find a similar issue/);
  });

  it("reads the new identifier digit by digit and never the run-together form", () => {
    const s = createdSpeech("5432");
    expect(s).toContain("5, 4, 3, 2");
    expect(s).not.toContain("5432");
  });

  it("the create failure sentence never claims success", () => {
    expect(CREATE_FAILED_SPEECH).not.toMatch(/created|logged|recorded/i);
    expect(CREATE_FAILED_SPEECH).toMatch(/call you back/);
  });
});

describe("fitSpeech", () => {
  it("keeps long lists under the limit by trimming titles rather than dropping the offer", () => {
    const long = Array.from({ length: 3 }, (_, i) => ({
      issueId: `41${i}${i}`,
      title: "x".repeat(400),
      status: "open" as const,
    }));
    const s = myOpenIssuesSpeech(9, long);
    expect(s.length).toBeLessThan(MAX_SPEECH_CHARS);
    expect(s).toContain("more");
  });

  it("hard-clamps anything still over the limit", () => {
    expect(fitSpeech("y".repeat(2000)).length).toBeLessThanOrEqual(MAX_SPEECH_CHARS);
  });
});
