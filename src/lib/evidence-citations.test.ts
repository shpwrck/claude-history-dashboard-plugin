/**
 * #3496 — an answer's evidence is the evidence it CITED.
 *
 * The unit under test is the whole answer-to-evidence link: the marker grammar
 * the model is instructed to use and the parser that reads it back. The
 * fail-safe direction is asserted deliberately and repeatedly — every shape this
 * cannot recognize must yield NOTHING, because the failure being fixed is chips
 * appearing under an answer that never referred to them.
 */

import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_CITATION_INSTRUCTION,
  extractCitedEvidence,
  parseEvidenceCitationNumbers,
} from './evidence-citations';

const refs = ['a', 'b', 'c', 'd', 'e'];

describe('parseEvidenceCitationNumbers — recognized forms', () => {
  it('reads the instructed single-marker form', () => {
    expect(parseEvidenceCitationNumbers('Start here [Evidence 2].')).toEqual([
      2,
    ]);
  });

  it('reads a comma-separated list inside one marker', () => {
    expect(parseEvidenceCitationNumbers('Both turns [Evidence 2, 3].')).toEqual([
      2, 3,
    ]);
  });

  it('reads adjacent markers', () => {
    expect(
      parseEvidenceCitationNumbers('Two sources [Evidence 2][Evidence 5].')
    ).toEqual([2, 5]);
  });

  it('reads markers spread across separate sentences', () => {
    expect(
      parseEvidenceCitationNumbers(
        'The retry loop shows it [Evidence 3].\n\nCost follows [Evidence 1].'
      )
    ).toEqual([3, 1]);
  });

  it('tolerates the separators a model substitutes for a comma', () => {
    expect(parseEvidenceCitationNumbers('[Evidence 1; 2]')).toEqual([1, 2]);
    expect(parseEvidenceCitationNumbers('[Evidence 1 and 2]')).toEqual([1, 2]);
    expect(parseEvidenceCitationNumbers('[Evidence 1 & 2]')).toEqual([1, 2]);
    expect(parseEvidenceCitationNumbers('[Evidence 1 + 2]')).toEqual([1, 2]);
  });

  it('tolerates lowercase, an ordinal #, and loose inner spacing', () => {
    expect(parseEvidenceCitationNumbers('[evidence #2]')).toEqual([2]);
    expect(parseEvidenceCitationNumbers('[ EVIDENCE  2 ]')).toEqual([2]);
    expect(parseEvidenceCitationNumbers('[Evidence#2,#3]')).toEqual([2, 3]);
  });

  it('tolerates Markdown-escaped brackets', () => {
    // Some models escape the brackets so the span is not read as a link.
    expect(parseEvidenceCitationNumbers('as shown \\[Evidence 2\\]')).toEqual([
      2,
    ]);
  });

  it('returns each number once, in order of first mention', () => {
    expect(
      parseEvidenceCitationNumbers('[Evidence 3] and again [Evidence 3, 1]')
    ).toEqual([3, 1]);
  });

  it('reads the numbers its own instruction demonstrates', () => {
    // The instruction and the parser are one contract; an example the parser
    // cannot read would teach the model a form that silently drops its chips.
    expect(parseEvidenceCitationNumbers(EVIDENCE_CITATION_INSTRUCTION)).toEqual([
      1, 2, 3,
    ]);
  });
});

describe('parseEvidenceCitationNumbers — nothing else counts', () => {
  it('finds no citation in an answer that names none', () => {
    expect(
      parseEvidenceCitationNumbers('Start with the repeated Bash finding.')
    ).toEqual([]);
  });

  it('ignores prose about evidence that is not a marker', () => {
    expect(
      parseEvidenceCitationNumbers('The evidence 2 entries agree.')
    ).toEqual([]);
    expect(parseEvidenceCitationNumbers('(Evidence 2)')).toEqual([]);
    expect(parseEvidenceCitationNumbers('Evidence: 2')).toEqual([]);
  });

  it('ignores a bracket body that is not purely numbers and separators', () => {
    // Documented decision: ranges are not a supported form, and a prose body is
    // too ambiguous to guess at. Both fall into the fail-safe.
    expect(parseEvidenceCitationNumbers('[Evidence 2-4]')).toEqual([]);
    expect(parseEvidenceCitationNumbers('[Evidence 2 shows the retry]')).toEqual(
      []
    );
    expect(parseEvidenceCitationNumbers('[Evidence]')).toEqual([]);
    expect(parseEvidenceCitationNumbers('[Evidence N]')).toEqual([]);
  });

  it('ignores a zero index and an unbounded integer', () => {
    expect(parseEvidenceCitationNumbers('[Evidence 0]')).toEqual([]);
    expect(parseEvidenceCitationNumbers('[Evidence 99999]')).toEqual([]);
    // The digit cap invalidates the whole marker, not just the oversized
    // number — the valid 2 goes with it.
    expect(parseEvidenceCitationNumbers('[Evidence 2, 99999]')).toEqual([]);
  });

  it('handles empty and non-string input without throwing', () => {
    expect(parseEvidenceCitationNumbers('')).toEqual([]);
    expect(
      parseEvidenceCitationNumbers(undefined as unknown as string)
    ).toEqual([]);
  });
});

describe('extractCitedEvidence', () => {
  it('keeps only the cited entries', () => {
    expect(extractCitedEvidence('Look at [Evidence 2].', refs)).toEqual(['b']);
  });

  it('keeps several cited entries in the order they were supplied', () => {
    // Supplied order, not mention order: a chip's position must keep matching
    // the number it is labelled with.
    expect(extractCitedEvidence('[Evidence 4] then [Evidence 2]', refs)).toEqual(
      ['b', 'd']
    );
  });

  it('attaches nothing when the answer cites nothing', () => {
    expect(extractCitedEvidence('A plain answer with no marker.', refs)).toEqual(
      []
    );
  });

  it('drops a number that names no supplied entry', () => {
    expect(extractCitedEvidence('[Evidence 9]', refs)).toEqual([]);
    expect(extractCitedEvidence('[Evidence 2, 9]', refs)).toEqual(['b']);
  });

  it('returns nothing when nothing was supplied', () => {
    expect(extractCitedEvidence('[Evidence 1]', [])).toEqual([]);
  });

  it('does not mutate or alias the supplied list', () => {
    const supplied = [...refs];
    const cited = extractCitedEvidence('[Evidence 1, 2, 3, 4, 5]', supplied);
    expect(cited).toEqual(supplied);
    expect(cited).not.toBe(supplied);
  });

  it('carries whatever ref shape the caller supplies', () => {
    const objects = [{ id: 'one' }, { id: 'two' }];
    expect(extractCitedEvidence('[Evidence 2]', objects)).toEqual([
      { id: 'two' },
    ]);
    expect(extractCitedEvidence('[Evidence 2]', objects)[0]).toBe(objects[1]);
  });
});

/**
 * Eager-index contracts (#3481). Both indexes here are lazy by construction, and
 * the uncited answer is not an edge case — it is the fail-safe path this feature
 * is built around, so it is the path that must stay at zero work.
 *
 * These are regression proofs, not restatements of the behaviour tests above:
 * each fails if the laziness is lost while the visible output stays correct.
 */
describe('zero work on the non-querying path', () => {
  it('never populates the dedupe index for an answer that cites nothing', () => {
    // perf-index-contract: evidence-citation-dedupe non-querying
    // Deliberately near-miss prose: every line looks like a citation without
    // being one, so this fails if the grammar is ever loosened into matching
    // them and the index starts accumulating on the uncited path.
    const nearMisses = [
      'The evidence 2 entries agree.',
      'Evidence: 2 and 3 are the relevant turns.',
      '(Evidence 2) supports the retry theory.',
      '[Evidence 2-4] would be a range, which is not a citation.',
      '[Evidence N] is the literal instruction, not a use of it.',
    ].join('\n');

    expect(parseEvidenceCitationNumbers(nearMisses).length).toBe(0);
  });

  it('never reads the refs list for an answer that cites nothing', () => {
    // perf-index-contract: evidence-citation-lookup non-querying
    // Counts element reads through a Proxy: the early return must fire before
    // the filter, so a no-citation reply touches the supplied list zero times.
    // Removing that early return leaves the OUTPUT correct and fails only here.
    let elementReads = 0;
    const watched = new Proxy(['a', 'b', 'c'], {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) elementReads += 1;
        return Reflect.get(target, prop, receiver);
      },
    });

    expect(extractCitedEvidence('A plain answer with no marker.', watched)).toEqual(
      []
    );
    expect(elementReads).toBe(0);

    // ...and the same list IS read once there is something to match, so the
    // assertion above is about laziness rather than an unreachable path.
    expect(extractCitedEvidence('[Evidence 2]', watched)).toEqual(['b']);
    expect(elementReads).toBeGreaterThan(0);
  });
});
