// Keyword similarity (KTD9): salient terms minus stop words, overlap score,
// a threshold of three shared terms, and the top match only.

import { describe, expect, it } from "vitest";
import { SIMILARITY_THRESHOLD, STOP_WORDS, rankSimilar, salientTerms, termOverlap } from "../similarity.js";

const AE5 = "the VPN client disconnects every few minutes on the office wifi and I have to reconnect";
const AE6 = "the label printer on the loading dock prints blank pages after the firmware update";

const vpn = {
  issueId: "2210",
  title: "VPN client disconnects every few minutes on office wifi",
  description:
    "Since Monday the VPN client drops every few minutes whenever I am on the office wifi and I have to reconnect each time. A wired connection stays up all day.",
  resolution: "Disabled the wifi adapter's power-saving mode and switched the VPN client profile to keep-alive.",
};
const printer = {
  issueId: "3001",
  title: "Printer on the third floor is broken",
  description: "The printer jams on every job and the display is dark.",
  resolution: "Replaced the fuser.",
};

describe("salientTerms", () => {
  it("lower-cases, drops stop words and duplicates, keeps first-seen order", () => {
    const terms = salientTerms(AE5);
    expect(terms).toEqual(expect.arrayContaining(["vpn", "client", "disconnects", "minutes", "office", "wifi", "reconnect"]));
    expect(terms).not.toContain("the");
    expect(terms).not.toContain("i");
    expect(terms.indexOf("vpn")).toBeLessThan(terms.indexOf("wifi"));
    expect(new Set(terms).size).toBe(terms.length);
  });

  it("treats the seed generator's stop words as stop words", () => {
    for (const w of ["the", "on", "and", "i", "to", "a", "after", "every", "few", "my", "have", "it", "is", "of", "in"]) {
      expect(STOP_WORDS.has(w)).toBe(true);
    }
  });

  it("returns nothing for empty or all-stop-word text", () => {
    expect(salientTerms("")).toEqual([]);
    expect(salientTerms("the and of")).toEqual([]);
  });
});

describe("termOverlap", () => {
  it("counts query terms present in the candidate", () => {
    expect(termOverlap(["vpn", "wifi", "zzz"], ["wifi", "vpn", "client"])).toBe(2);
    expect(termOverlap([], ["a"])).toBe(0);
  });
});

describe("rankSimilar", () => {
  it("returns the seeded resolved issue with its resolution for the AE5 description", () => {
    const match = rankSimilar(AE5, [printer, vpn]);
    expect(match?.issueId).toBe("2210");
    expect(match?.resolution).toBe(vpn.resolution);
    expect(match?.score).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
  });

  it("returns null for the AE6 description", () => {
    expect(rankSimilar(AE6, [printer, vpn])).toBeNull();
  });

  it("does not match on stop words: 'the printer is broken again' scores only its salient words", () => {
    const candidate = { issueId: "1", title: "The the the", description: "the is is the", resolution: "r" };
    expect(rankSimilar("the printer is broken again", [candidate])).toBeNull();
    expect(rankSimilar("the printer is broken again", [printer, candidate], 2)?.issueId).toBe("3001");
  });

  it("returns exactly one result, the highest score, and honours the threshold", () => {
    const weaker = { ...vpn, issueId: "9999", title: "Connection trouble", description: "vpn wifi reconnect only" };
    const match = rankSimilar(AE5, [weaker, vpn]);
    expect(match?.issueId).toBe("2210");
    expect(rankSimilar(AE5, [weaker], 3)?.issueId).toBe("9999");
    expect(rankSimilar(AE5, [weaker], 4)).toBeNull();
  });
});
