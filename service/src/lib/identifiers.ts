// Normalisation of things callers say or the phone network sends: issue
// identifiers spoken in any digit shape (KTD16) and caller ids as E.164. Pure;
// no I/O, no framework imports.

const UNITS: Record<string, number> = {
  zero: 0, oh: 0, o: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
/** Words the caller may wrap around the number; they carry no digits. */
const FILLER = new Set(["issue", "ticket", "number", "no", "id", "the", "my", "is", "it", "its", "hash", "pound", "and", "a", "for"]);

/**
 * Turns a spoken or typed issue identifier into its four-digit form.
 * "forty-one twenty-seven", "four one two seven", "4 1 2 7", "4127", and
 * "issue 4127" all give "4127". Returns null unless the result is exactly four
 * digits, so callers can say "that is not an identifier" without guessing.
 */
export function normalizeIssueId(spoken: unknown): string | null {
  if (typeof spoken !== "string") return null;
  const tokens = spoken
    .toLowerCase()
    .replace(/[,.#!?;:'"]/g, " ")
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;

  let digits = "";
  let pendingTens: number | null = null;
  const flushTens = () => {
    if (pendingTens !== null) {
      digits += String(pendingTens);
      pendingTens = null;
    }
  };

  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      flushTens();
      digits += token;
      continue;
    }
    if (token in TENS) {
      flushTens();
      pendingTens = TENS[token] ?? null;
      continue;
    }
    if (token in UNITS) {
      const value = UNITS[token] ?? 0;
      if (pendingTens !== null && value >= 1 && value <= 9) {
        digits += String(pendingTens + value);
        pendingTens = null;
      } else {
        flushTens();
        digits += String(value);
      }
      continue;
    }
    if (FILLER.has(token)) continue;
    // Anything else ("hundred", "thousand", a stray word) means we cannot be
    // sure what was said; refuse rather than guess.
    return null;
  }
  flushTens();
  return /^\d{4}$/.test(digits) ? digits : null;
}

/** "4127" -> "4, 1, 2, 7": the read-back shape the prompt uses for identifiers. */
export function speakDigits(id: string): string {
  return id.split("").join(", ");
}

/**
 * Normalises a caller id to E.164. Strips spaces, dashes, dots, and
 * parentheses; adds a leading plus when missing; a bare ten-digit number is
 * assumed to be US and gets +1. Returns null for absent or non-numeric input,
 * which the verifier treats as the "unknown" bucket.
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const stripped = raw.trim().replace(/[\s\-.()]/g, "");
  if (stripped.length === 0) return null;
  const hasPlus = stripped.startsWith("+");
  const digits = hasPlus ? stripped.slice(1) : stripped;
  if (!/^\d{8,15}$/.test(digits)) return null;
  if (!hasPlus && digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}
