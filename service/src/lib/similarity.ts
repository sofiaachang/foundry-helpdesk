// Keyword similarity (KTD9). Pure: term extraction with a stop list, overlap
// scoring against a candidate's title and description, a threshold of three
// shared salient terms, and the single best match. The stop list mirrors the
// seed generator's (ontology/seed/generate-seed.ts) and extends it with words
// that carry no signal; the seed's AE5/AE6 guarantees only rely on the first
// fifteen, so the extension cannot break them.

export const STOP_WORDS: ReadonlySet<string> = new Set([
  "the", "on", "and", "i", "to", "a", "after", "every", "few", "my", "have", "it", "is", "of", "in",
  "an", "at", "for", "with", "that", "this", "when", "was", "are", "be", "or", "but", "not", "again",
  "still", "am", "we", "our", "so", "as", "by", "from", "can", "cant", "just", "also", "then",
]);

export const SIMILARITY_THRESHOLD = 3;

/** Lower-cased alphanumeric tokens minus stop words, de-duplicated, in first-seen order. */
export function salientTerms(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || STOP_WORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/** Number of query terms that appear in the candidate's terms. */
export function termOverlap(query: string[], candidate: string[]): number {
  const set = new Set(candidate);
  let n = 0;
  for (const t of query) if (set.has(t)) n++;
  return n;
}

export interface SimilarCandidate {
  issueId: string;
  title: string;
  description: string;
  resolution: string;
}

export interface SimilarResult {
  issueId: string;
  resolution: string;
  score: number;
}

/**
 * The single best candidate whose title+description shares at least
 * `threshold` salient terms with the description, or null. Ties keep the
 * earlier candidate, which callers order newest-resolved first.
 */
export function rankSimilar(
  description: string,
  candidates: SimilarCandidate[],
  threshold: number = SIMILARITY_THRESHOLD,
): SimilarResult | null {
  const query = salientTerms(description);
  if (query.length === 0) return null;
  let best: SimilarResult | null = null;
  for (const c of candidates) {
    const score = termOverlap(query, salientTerms(`${c.title} ${c.description}`));
    if (score < threshold) continue;
    if (!best || score > best.score) best = { issueId: c.issueId, resolution: c.resolution, score };
  }
  return best;
}
