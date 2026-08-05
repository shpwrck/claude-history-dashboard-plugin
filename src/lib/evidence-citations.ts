/**
 * The answer -> evidence link for Ask Claude (#3496).
 *
 * PR #3495 made the recommendations payload's citation list resolvable and
 * relabelled the rendered chips as evidence *supplied* to the model, because
 * nothing tied the answer to any particular entry: the refs were attached
 * unconditionally, and on the recommendations payload that list POOLS evidence
 * drawn from several independent findings, so the entry behind finding A could
 * sit under a sentence about finding B.
 *
 * This module is the mechanism that closes that gap, and it owns BOTH halves of
 * the contract so they cannot drift: the instruction handed to the model and the
 * parser that reads the markers back out. Change the grammar in one place and
 * the other is wrong; keeping them in one file makes the pair reviewable, and
 * `evidence-citations.test.ts` asserts the instruction's own examples parse.
 *
 * Fail safe: an answer with no recognizable marker cites NOTHING, so the caller
 * attaches no chips. Showing every supplied entry on a reply that named none is
 * the failure this exists to prevent, so silence is the correct degraded state.
 *
 * The numbering is per-turn, not per-thread. A number is only ever resolved
 * against the list supplied with the SAME request, and Ask Claude re-derives
 * that list whenever the dashboard slice changes — so if a model echoes an
 * `[Evidence 2]` it learned from an earlier turn, it resolves against the new
 * turn's second entry, which may be a different transcript entry entirely.
 * (A follow-up turn on an UNCHANGED slice carries no evidence list at all and
 * attaches nothing, so the echo only matters when the slice moved.)
 */

/**
 * Told to the model alongside the numbered `evidenceRefs` list.
 *
 * Deliberately states the consequence of not citing (the entry is dropped), not
 * just the syntax: the model has no other way to learn that an uncited entry
 * disappears from the answer's evidence.
 */
export const EVIDENCE_CITATION_INSTRUCTION =
  'Each entry in the evidenceRefs list is labelled "Evidence N". When a claim ' +
  'rests on one of those transcript entries, cite it inline in that sentence as ' +
  '[Evidence 1], or [Evidence 2, 3] for several at once. Cite only entries the ' +
  'claim actually rests on: an entry you do not cite is dropped from the ' +
  "answer's evidence list, and an answer that cites none shows none.";

/**
 * One `[Evidence N]` marker, tolerant of the forms a model actually emits:
 *
 * - `[Evidence 2]` — the instructed form.
 * - `[Evidence 2, 3]` — a list; `;`, `&`, `+`, and `and` also separate.
 * - `[Evidence 2][Evidence 5]` — adjacent markers (the global flag walks both).
 * - `\[Evidence 2\]` — Markdown-escaped brackets, which some models emit to stop
 *   a bracketed span being read as a link.
 * - `[evidence #2]` — lowercase, and an ordinal `#`.
 *
 * Ranges (`[Evidence 2-4]`) are NOT a citation: the body must be numbers and
 * separators, so a hyphenated or prose body (`[Evidence 2 shows the retry]`)
 * matches nothing and falls into the fail-safe rather than guessing an intent.
 *
 * Digits are capped at four so a runaway integer cannot be parsed as an index,
 * and that cap invalidates the WHOLE marker rather than just the oversized
 * number: `[Evidence 2, 99999]` cites nothing at all, dropping the valid `2`
 * with it. That is the fail-safe direction — a marker we cannot read in full is
 * one whose intent we do not know — but it does mean a single malformed number
 * costs its companions.
 *
 * Position in the answer is not considered, so a marker inside a fenced code
 * block counts exactly like one in prose. An answer quoting `[Evidence 2]` as
 * an example rather than using it will therefore attach that chip.
 */
const CITATION_MARKER =
  /\\?\[\s*Evidence\s*#?\s*(\d{1,4}(?:\s*(?:,|;|&|\+|and)\s*#?\s*\d{1,4})*)\s*\\?\]/gi;

/**
 * The 1-based `Evidence N` numbers an answer cites, in order of first mention
 * and without repeats.
 *
 * Numbers are returned as written: whether one names a supplied entry is the
 * caller's question, since only it knows how many were offered.
 */
export function parseEvidenceCitationNumbers(text: string): number[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  // perf-index-contract: evidence-citation-dedupe non-querying
  // An answer with no marker — the fail-safe path, and the common one — yields
  // no match, so the loop body never runs and this is never inserted into or
  // queried. Proven in evidence-citations.test.ts against near-miss prose.
  const seen = new Set<number>();
  const numbers: number[] = [];
  for (const match of text.matchAll(CITATION_MARKER)) {
    for (const token of match[1].split(/[^0-9]+/)) {
      if (!token) continue;
      const n = Number.parseInt(token, 10);
      if (!Number.isInteger(n) || n < 1 || seen.has(n)) continue;
      seen.add(n);
      numbers.push(n);
    }
  }
  return numbers;
}

/**
 * The subset of `refs` an answer actually cites, in the order they were supplied
 * (so a rendered chip's position still matches its `Evidence N` label).
 *
 * Generic over the ref shape: the linkage is positional, so this needs to know
 * nothing about an `EvidenceRef` and stays testable without a transcript.
 *
 * Returns `[]` when the answer cites nothing recognizable, and drops a number
 * that names no supplied entry — an answer citing only `[Evidence 9]` out of
 * three offered entries has cited nothing this list can honestly stand behind.
 */
export function extractCitedEvidence<T>(
  replyText: string,
  refs: readonly T[]
): T[] {
  // perf-index-contract: evidence-citation-lookup non-querying
  // The uncited answer returns before any lookup, so `refs` is never scanned —
  // the membership set exists only to keep the filter below linear once there
  // IS something to match. Proven in evidence-citations.test.ts by counting
  // element reads through a Proxy.
  const cited = new Set(parseEvidenceCitationNumbers(replyText));
  if (cited.size === 0) return [];
  return refs.filter((_, index) => cited.has(index + 1));
}
