import { describe, expect, it } from "vitest";
import { normalizeIssueId, speakDigits } from "../identifiers.js";

describe("normalizeIssueId", () => {
  it.each([
    ["forty-one twenty-seven", "4127"],
    ["forty one twenty seven", "4127"],
    ["four one two seven", "4127"],
    ["4 1 2 7", "4127"],
    ["4127", "4127"],
    ["issue 4127", "4127"],
    ["Issue number forty-one twenty-seven", "4127"],
    ["four thousand one hundred twenty-seven", null],
    ["forty one twenty seven.", "4127"],
    ["4,127", "4127"],
    ["one oh two three", "1023"],
    ["ten twenty-three", "1023"],
    ["twelve fifty", "1250"],
    ["ninety-nine ninety-nine", "9999"],
    ["zero zero zero one", "0001"],
    ["fifty six", null],
  ])("%s -> %s", (spoken, expected) => {
    expect(normalizeIssueId(spoken)).toBe(expected);
  });

  it("returns null when the result is not exactly four digits", () => {
    expect(normalizeIssueId("issue forty-one")).toBeNull();
    expect(normalizeIssueId("41")).toBeNull();
    expect(normalizeIssueId("41270")).toBeNull();
    expect(normalizeIssueId("forty-one twenty-seven three")).toBeNull();
    expect(normalizeIssueId("")).toBeNull();
    expect(normalizeIssueId("   ")).toBeNull();
  });

  it("returns null for unrecognised words and non-string input", () => {
    expect(normalizeIssueId("banana 4127")).toBeNull();
    expect(normalizeIssueId(undefined)).toBeNull();
    expect(normalizeIssueId(4127)).toBeNull();
  });
});

describe("speakDigits", () => {
  it("reads digits one by one separated by commas", () => {
    expect(speakDigits("4127")).toBe("4, 1, 2, 7");
    expect(speakDigits("0001")).toBe("0, 0, 0, 1");
  });
});
