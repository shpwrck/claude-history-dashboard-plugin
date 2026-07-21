import { describe, it, expect } from 'vitest';
import {
  DOC_ISSUE_REUSE_MS,
  DOC_ISSUE_MAX_USABLE_MS,
  DOC_ISSUE_MAX_REFS,
  canonicalRefSet,
  docIssueSnapshotAgeMs,
  docIssueSnapshotFreshnessBoundaryMs,
  docIssueSnapshotIdentity,
  docIssueSnapshotUsableThroughMs,
  docIssueStateByNumber,
  isDocIssueSnapshotRefreshEligible,
  isDocIssueSnapshotReusable,
  isDocIssueSnapshotUsable,
  isValidRepoSlug,
  normalizeIssueOrPrState,
  normalizeIssueState,
  normalizePullRequestState,
  validateDocIssueSnapshot,
  type DocIssueSnapshot,
} from './doc-issue-snapshot';

const AS_OF = '2026-07-20T00:00:00.000Z';
const AS_OF_MS = Date.parse(AS_OF);
const FINGERPRINT = 'bdb9e886624fe6885bed8b34406e8e553947a86b2395d049af4dcd82ef73bd62';

function snapshot(over: Partial<DocIssueSnapshot> = {}): DocIssueSnapshot {
  return {
    repo: 'shpwrck/claude-history-dashboard',
    refs: [1, 2, 3],
    records: [
      { number: 1, state: 'open' },
      { number: 2, state: 'closed' },
      { number: 3, state: 'not-found' },
    ],
    asOf: AS_OF,
    complete: true,
    fingerprint: FINGERPRINT,
    ...over,
  };
}

describe('doc-issue-snapshot — state normalization', () => {
  it('normalizes Issue state', () => {
    expect(normalizeIssueState('OPEN')).toBe('open');
    expect(normalizeIssueState('CLOSED')).toBe('closed');
    expect(normalizeIssueState('open')).toBe('open'); // case-insensitive
    expect(normalizeIssueState('MERGED')).toBeNull(); // not an Issue state
    expect(normalizeIssueState(42)).toBeNull();
  });

  it('normalizes PullRequest state (merged -> closed)', () => {
    expect(normalizePullRequestState('OPEN')).toBe('open');
    expect(normalizePullRequestState('CLOSED')).toBe('closed');
    expect(normalizePullRequestState('MERGED')).toBe('closed');
    expect(normalizePullRequestState('DRAFT')).toBeNull();
  });

  it('normalizes a resolved node by __typename', () => {
    expect(normalizeIssueOrPrState('Issue', 'OPEN')).toBe('open');
    expect(normalizeIssueOrPrState('PullRequest', 'MERGED')).toBe('closed');
    expect(normalizeIssueOrPrState('Issue', 'MERGED')).toBeNull(); // Issue can't be merged
    expect(normalizeIssueOrPrState('Repository', 'OPEN')).toBeNull(); // wrong typename
  });
});

describe('doc-issue-snapshot — ref-set + slug', () => {
  it('canonicalizes refs: sorted, unique, positive integers only', () => {
    expect(canonicalRefSet([3, 1, 2, 2, 1])).toEqual([1, 2, 3]);
    expect(canonicalRefSet([5, 0, -1, 2.5, 4])).toEqual([4, 5]);
    expect(canonicalRefSet([])).toEqual([]);
  });

  it('validates lowercase owner/repo slugs', () => {
    expect(isValidRepoSlug('shpwrck/claude-history-dashboard')).toBe(true);
    expect(isValidRepoSlug('ShpWrck/Repo')).toBe(false); // must be lowercase
    expect(isValidRepoSlug('no-slash')).toBe(false);
    expect(isValidRepoSlug('a/b/c')).toBe(false);
    expect(isValidRepoSlug('')).toBe(false);
    expect(isValidRepoSlug(123)).toBe(false);
  });
});

describe('doc-issue-snapshot — freshness windows', () => {
  it('reuses a snapshot below 15 minutes, is eligible at exactly 15 minutes', () => {
    const justUnder = AS_OF_MS + DOC_ISSUE_REUSE_MS - 1;
    const at = AS_OF_MS + DOC_ISSUE_REUSE_MS;
    expect(isDocIssueSnapshotReusable(snapshot(), justUnder)).toBe(true);
    expect(isDocIssueSnapshotRefreshEligible(snapshot(), justUnder)).toBe(false);
    // boundary: exactly 15m is NOT reused; a refresh is eligible.
    expect(isDocIssueSnapshotReusable(snapshot(), at)).toBe(false);
    expect(isDocIssueSnapshotRefreshEligible(snapshot(), at)).toBe(true);
  });

  it('remains usable through exactly 24h and is suppressed immediately after', () => {
    const at24 = AS_OF_MS + DOC_ISSUE_MAX_USABLE_MS;
    const past24 = AS_OF_MS + DOC_ISSUE_MAX_USABLE_MS + 1;
    expect(isDocIssueSnapshotUsable(snapshot(), at24)).toBe(true);
    expect(isDocIssueSnapshotUsable(snapshot(), past24)).toBe(false);
  });

  it('treats a future or unparseable asOf as an untrustworthy (null) age', () => {
    const future = AS_OF_MS - 1000;
    expect(docIssueSnapshotAgeMs(snapshot(), future)).toBeNull();
    expect(isDocIssueSnapshotReusable(snapshot(), future)).toBe(false);
    expect(isDocIssueSnapshotUsable(snapshot(), future)).toBe(false);
    expect(isDocIssueSnapshotRefreshEligible(snapshot(), future)).toBe(true);
    const bad = snapshot({ asOf: 'not-a-date' });
    expect(docIssueSnapshotAgeMs(bad, AS_OF_MS)).toBeNull();
    expect(docIssueSnapshotFreshnessBoundaryMs(bad)).toBeNull();
  });

  it('exposes the next freshness boundary as asOf + 15m', () => {
    expect(docIssueSnapshotFreshnessBoundaryMs(snapshot())).toBe(AS_OF_MS + DOC_ISSUE_REUSE_MS);
  });

  it('exposes the inclusive usable-through boundary as asOf + 24h', () => {
    expect(docIssueSnapshotUsableThroughMs(snapshot())).toBe(
      AS_OF_MS + DOC_ISSUE_MAX_USABLE_MS
    );
    expect(docIssueSnapshotUsableThroughMs(snapshot({ asOf: 'not-a-date' }))).toBeNull();
  });
});

describe('doc-issue-snapshot — validation', () => {
  it('accepts a well-formed complete snapshot and round-trips it', () => {
    const parsed = validateDocIssueSnapshot(JSON.parse(JSON.stringify(snapshot())));
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual(snapshot());
  });

  it('rejects a snapshot that is not marked complete', () => {
    expect(validateDocIssueSnapshot(snapshot({ complete: false as unknown as true }))).toBeNull();
  });

  it('rejects a bad slug, non-canonical/impossible asOf, or fingerprint outside lowercase 64-hex', () => {
    expect(validateDocIssueSnapshot(snapshot({ repo: 'BAD/Repo' }))).toBeNull();
    expect(validateDocIssueSnapshot(snapshot({ asOf: '2026-07-20' }))).toBeNull();
    expect(validateDocIssueSnapshot(snapshot({ asOf: '2026-02-31T00:00:00.000Z' }))).toBeNull();
    expect(validateDocIssueSnapshot(snapshot({ asOf: '2026-01-01T24:00:00.000Z' }))).toBeNull();
    expect(validateDocIssueSnapshot(snapshot({ asOf: '2026-07-20T00:00:00Z' }))).toBeNull();
    expect(validateDocIssueSnapshot(snapshot({ fingerprint: '' }))).toBeNull();
    expect(validateDocIssueSnapshot(snapshot({ fingerprint: 'a'.repeat(63) }))).toBeNull();
    expect(validateDocIssueSnapshot(snapshot({ fingerprint: 'A'.repeat(64) }))).toBeNull();
    expect(validateDocIssueSnapshot(snapshot({ fingerprint: 'g'.repeat(64) }))).toBeNull();
  });

  it('rejects unsorted, duplicate, or non-positive refs', () => {
    expect(
      validateDocIssueSnapshot({ ...snapshot(), refs: [2, 1, 3] })
    ).toBeNull();
    expect(validateDocIssueSnapshot({ ...snapshot(), refs: [1, 1, 2] })).toBeNull();
    expect(validateDocIssueSnapshot({ ...snapshot(), refs: [0, 1, 2] })).toBeNull();
  });

  it('rejects ref sets above the hard 1000-record schema cap', () => {
    const refs = Array.from({ length: DOC_ISSUE_MAX_REFS + 1 }, (_, index) => index + 1);
    expect(
      validateDocIssueSnapshot({
        ...snapshot(),
        refs,
        records: refs.map((number) => ({ number, state: 'open' })),
      })
    ).toBeNull();
  });

  it('requires exactly one recognized-state record per ref (no gaps, no extras)', () => {
    // missing a record
    expect(
      validateDocIssueSnapshot({
        ...snapshot(),
        records: [
          { number: 1, state: 'open' },
          { number: 2, state: 'closed' },
        ],
      })
    ).toBeNull();
    // an extra number not in refs
    expect(
      validateDocIssueSnapshot({
        ...snapshot(),
        records: [
          { number: 1, state: 'open' },
          { number: 2, state: 'closed' },
          { number: 9, state: 'open' },
        ],
      })
    ).toBeNull();
    // an unrecognized state
    expect(
      validateDocIssueSnapshot({
        ...snapshot(),
        records: [
          { number: 1, state: 'merged' },
          { number: 2, state: 'closed' },
          { number: 3, state: 'not-found' },
        ],
      })
    ).toBeNull();
    // records must follow the exact canonical ref order
    expect(
      validateDocIssueSnapshot({
        ...snapshot(),
        records: [
          { number: 2, state: 'closed' },
          { number: 1, state: 'open' },
          { number: 3, state: 'not-found' },
        ],
      })
    ).toBeNull();
  });

  it('can bind validation to an exact expected repo, ref set, and recomputed fingerprint', () => {
    expect(
      validateDocIssueSnapshot(snapshot(), {
        repo: 'shpwrck/claude-history-dashboard',
        refs: [1, 2, 3],
        fingerprint: FINGERPRINT,
      })
    ).toEqual(snapshot());
    expect(validateDocIssueSnapshot(snapshot(), { refs: [1, 2] })).toBeNull();
    expect(validateDocIssueSnapshot(snapshot(), { refs: [3, 2, 1] })).toBeNull();
    expect(validateDocIssueSnapshot(snapshot(), { repo: 'other/repo' })).toBeNull();
    expect(validateDocIssueSnapshot(snapshot(), { fingerprint: '0'.repeat(64) })).toBeNull();
  });

  it('builds a deterministic identity over every detector-visible field', () => {
    const base = snapshot();
    const identity = docIssueSnapshotIdentity(base);
    expect(docIssueSnapshotIdentity(JSON.parse(JSON.stringify(base)))).toBe(identity);
    expect(
      docIssueSnapshotIdentity(
        snapshot({
          records: [
            { number: 1, state: 'closed' },
            { number: 2, state: 'closed' },
            { number: 3, state: 'not-found' },
          ],
        })
      )
    ).not.toBe(identity);
    expect(docIssueSnapshotIdentity(snapshot({ asOf: '2026-07-20T00:00:01.000Z' }))).not.toBe(
      identity
    );
    expect(docIssueSnapshotIdentity(snapshot({ fingerprint: '0'.repeat(64) }))).not.toBe(identity);
  });

  it('builds a number->state lookup for the consumer detector', () => {
    const map = docIssueStateByNumber(snapshot());
    expect(map.get(1)).toBe('open');
    expect(map.get(2)).toBe('closed');
    expect(map.get(3)).toBe('not-found');
    expect(map.get(99)).toBeUndefined();
  });
});
